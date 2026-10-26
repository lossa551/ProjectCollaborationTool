import { estimateTokens } from './model.js';
import { normalizePath } from './paths.js';

// Folder notes in the agent workflow: which AGENTS.md notes an agent should
// get for the paths its task touches, which notes a change leaves behind, and
// how the notes read in the agent's context. The desktop app's Folder notes
// tab (apps/desktop/src/common/folder-notes.ts) builds on the same file name.

export const NOTE_FILE = 'AGENTS.md';

/** Most of an agent's context the notes may take; notes past it are listed by path only. */
export const NOTES_TOKEN_BUDGET = 6000;

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const depthOf = (folder: string) => (folder === '' ? 0 : folder.split('/').length);
const key = (path: string) => path.toLowerCase();

export const isNotePath = (path: string) => key(nameOf(path)) === key(NOTE_FILE);

/**
 * The folder a task path or pattern points at: everything before the first
 * wildcard, or the folder of a plain file path. `scripts/player/**` and
 * `scripts/player/jump.gd` both give `scripts/player`; `*.psd` gives the top folder.
 */
export function patternFolder(pattern: string): string {
  const parts = (normalizePath(pattern) ?? '').split('/').filter(Boolean);
  const literal: string[] = [];
  for (const part of parts) {
    if (/[*?[\]{}]/.test(part)) return literal.join('/');
    literal.push(part);
  }
  // Without a wildcard, a last part with an extension is a file.
  if (literal.length && /\.[^./]+$/.test(literal[literal.length - 1]!)) literal.pop();
  return literal.join('/');
}

/**
 * The notes an agent should read for these paths: the note of each folder
 * they point at, the notes of the folders above it (the top folder's
 * included), and the notes of its subfolders. Shallowest first.
 */
export function notesForPaths(notePaths: string[], patterns: string[]): string[] {
  const byFolder = new Map(notePaths.filter(isNotePath).map((p) => [key(folderOf(p)), p]));
  const chosen = new Set<string>();
  const top = byFolder.get('');
  if (top) chosen.add(top);
  for (const folder of new Set(patterns.map(patternFolder))) {
    const parts = folder ? folder.split('/') : [];
    for (let i = 1; i <= parts.length; i++) {
      const note = byFolder.get(key(parts.slice(0, i).join('/')));
      if (note) chosen.add(note);
    }
    if (!folder) continue;
    const inside = `${key(folder)}/`;
    for (const [noteFolder, note] of byFolder) if (noteFolder.startsWith(inside)) chosen.add(note);
  }
  return [...chosen].sort((a, b) => depthOf(folderOf(a)) - depthOf(folderOf(b)) || a.localeCompare(b));
}

/** The note that covers a file: its folder's, else the nearest one above. */
export function coveringNote(path: string, notePaths: string[]): string | null {
  const byFolder = new Map(notePaths.filter(isNotePath).map((p) => [key(folderOf(p)), p]));
  for (let folder = folderOf(path); ; folder = folderOf(folder)) {
    const note = byFolder.get(key(folder));
    if (note) return note;
    if (folder === '') return null;
  }
}

/**
 * Notes a change may have left out of date: notes covering changed files
 * when the change does not touch the note itself.
 */
export function notesToUpdate(changedFiles: string[], notePaths: string[]): { note: string; files: string[] }[] {
  const touched = new Set(changedFiles.filter(isNotePath).map(key));
  const out = new Map<string, string[]>();
  for (const file of changedFiles) {
    if (isNotePath(file)) continue;
    const note = coveringNote(file, notePaths);
    if (!note || touched.has(key(note))) continue;
    out.set(note, [...(out.get(note) ?? []), file]);
  }
  return [...out].map(([note, files]) => ({ note, files })).sort((a, b) => a.note.localeCompare(b.note));
}

export interface FolderNote {
  path: string;
  text: string;
}

/** The notes as the agent reads them, within the token budget; the rest are named so it can read them itself. */
export function renderFolderNotes(notes: FolderNote[], budget = NOTES_TOKEN_BUDGET): { text: string; included: FolderNote[]; skipped: string[] } {
  const included: FolderNote[] = [];
  const skipped: string[] = [];
  let used = 0;
  for (const note of notes) {
    const tokens = estimateTokens(note.text);
    if (used + tokens > budget) {
      skipped.push(note.path);
      continue;
    }
    used += tokens;
    included.push(note);
  }
  if (included.length === 0 && skipped.length === 0) return { text: '', included, skipped };
  const lines = [
    'Folder notes: short AGENTS.md files that say what a folder is for, what to read first and what to skip. ' +
      'Use them to find your way instead of reading whole folders, and if your change makes a note wrong, update the note in the same change.',
  ];
  for (const note of included) lines.push('', `--- ${note.path} ---`, note.text.trim());
  if (skipped.length) lines.push('', 'More notes for these folders (read them when you work there):', ...skipped.map((p) => `- ${p}`));
  return { text: lines.join('\n'), included, skipped };
}

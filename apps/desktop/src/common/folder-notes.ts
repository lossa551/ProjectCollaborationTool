// Folder notes: a short AGENTS.md in a folder that tells an agent what the
// folder does, what to read first and what to skip. The desktop app scans
// your project folder (apps/desktop/src/main/folder-notes.ts) and shows, per
// folder, whether its note exists and still matches the folder. This file
// holds the report's shape and the prompts, used by both sides.

import { NOTE_FILE, type FolderNoteFinding } from '@pct/shared';

export { NOTE_FILE };

/**
 * fresh: nothing in the folder changed since the note was last committed.
 * drifting: a few files changed since. stale: many did, or the note names
 * files that are gone. missing: big enough to deserve a note and has none.
 * not-needed: small, or covered by a note further up.
 */
export type NoteState = 'fresh' | 'drifting' | 'stale' | 'missing' | 'not-needed';

export type NoteChange = 'added' | 'modified' | 'deleted';

export interface FolderInfo {
  /** Repo-relative with forward slashes; '' is the repository's top folder. */
  path: string;
  depth: number;
  /** The folder's note, if it has one. */
  notePath: string | null;
  state: NoteState;
  /** Readable text in this folder and below, in estimated tokens (characters / 4). */
  tokens: number;
  /** The part a note here covers: subfolders with their own note left out. */
  ownTokens: number;
  ownFiles: number;
  /** Text files in this folder and below. */
  files: number;
  /** Binary files (images, audio, .uasset…): agents only ever see their names. */
  binaryFiles: number;
  binaryBytes: number;
  noteTokens: number;
  /** The note's first line of text, for the root index. */
  noteSummary: string | null;
  /** When the note was last committed (ms); null while it has uncommitted changes, 0 if older than the history the scan reads. */
  noteCommittedAt: number | null;
  /** Files the note covers that changed since it was last committed, committed or not. */
  changed: { path: string; change: NoteChange }[];
  /** Paths the note names that do not exist. */
  deadReferences: string[];
  /** Files and folders right inside the folder that the note never mentions. */
  unmentioned: string[];
  /** The biggest readable files the note covers, for drafting a note. */
  largest: { path: string; tokens: number }[];
  /** Why the folder has this state, in a few words each. */
  reasons: string[];
}

export interface FolderNotesReport {
  root: string;
  scannedAt: number;
  folders: FolderInfo[];
  totals: { tokens: number; files: number; binaryFiles: number; binaryBytes: number; notes: number; ignoredFiles: number };
  /** The project has more files than the scanner reads; the rest are left out. */
  truncated: boolean;
}

export const STATE_LABELS: Record<NoteState, string> = {
  fresh: 'Fresh',
  drifting: 'Drifting',
  stale: 'Stale',
  missing: 'Missing',
  'not-needed': 'Not needed',
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 100_000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export const folderLabel = (path: string) => (path === '' ? 'the top folder' : `${path}/`);
const notePathFor = (folder: string) => (folder ? `${folder}/${NOTE_FILE}` : NOTE_FILE);

const WHAT_A_NOTE_SAYS = [
  'A folder note is for AI agents and people new to the folder. Keep it to 10 to 30 lines of Markdown:',
  '- what the folder is for, in one or two sentences;',
  '- which files to read first, and what each of the main ones does;',
  '- what to skip: generated, huge or rarely relevant files, and where to look instead;',
  '- conventions someone changing this folder must follow.',
  'Name files with their paths in backticks so they can be checked later. Do not describe subfolders that have their own AGENTS.md beyond one line.',
];

/** The prompt that asks an agent to bring a folder's note up to date. */
export function updateNotePrompt(folder: FolderInfo): string {
  const note = folder.notePath ?? notePathFor(folder.path);
  const lines = [`Update the folder note ${note} so it matches ${folderLabel(folder.path)} again.`, ''];
  const changedList = (change: NoteChange, title: string) => {
    const files = folder.changed.filter((c) => c.change === change).map((c) => c.path);
    if (files.length) lines.push(`${title}:`, ...files.slice(0, 60).map((f) => `- ${f}`), ...(files.length > 60 ? [`- and ${files.length - 60} more`] : []), '');
  };
  if (folder.changed.length) {
    lines.push(`Since the note was last committed, ${plural(folder.changed.length, 'file')} changed.`, '');
    changedList('added', 'Added');
    changedList('modified', 'Changed');
    changedList('deleted', 'Deleted');
  }
  if (folder.deadReferences.length) lines.push('The note names these, which no longer exist:', ...folder.deadReferences.map((r) => `- ${r}`), '');
  if (folder.unmentioned.length) {
    lines.push('The note does not mention these (add them only if an agent needs to know about them):', ...folder.unmentioned.map((u) => `- ${u}`), '');
  }
  lines.push(
    `Read the note and the files above, then edit ${note}. Keep what is still right; fix or remove what is wrong.`,
    '',
    ...WHAT_A_NOTE_SAYS,
    '',
    `Only change ${note}.`,
  );
  return lines.join('\n');
}

/** The prompt that asks an agent to write a first note for a folder. */
export function draftNotePrompt(folder: FolderInfo, subfolders: FolderInfo[]): string {
  const note = notePathFor(folder.path);
  const lines = [
    `Write a folder note, ${note}, for ${folderLabel(folder.path)}. It has ${plural(folder.ownFiles, 'readable file')} (about ${formatTokens(folder.ownTokens)} tokens), and agents currently have to read through it to find their way.`,
    '',
  ];
  if (folder.largest.length) lines.push('Its biggest files:', ...folder.largest.map((f) => `- ${f.path} (${formatTokens(f.tokens)} tokens)`), '');
  if (subfolders.length) {
    lines.push(
      'Its subfolders:',
      ...subfolders.map((s) => `- ${s.path}/ (${formatTokens(s.tokens)} tokens${s.notePath ? ', has its own note' : ''})`),
      '',
    );
  }
  lines.push(
    'Look through the folder, starting from the files you would expect to be entry points, without reading every large file in full.',
    '',
    ...WHAT_A_NOTE_SAYS,
    '',
    `Only create ${note}.`,
  );
  return lines.join('\n');
}

/** First line of a note that says something (not a heading), for the root index. */
export function summarizeNote(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('<!--') || line === '---') continue;
    const clean = line.replace(/^[-*>]\s+/, '');
    return clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
  }
  return '';
}

/** An index of every folder note, for the top of an agent's context or a root AGENTS.md. */
export function rootIndex(report: FolderNotesReport): string {
  const noted = report.folders.filter((f) => f.notePath && f.path !== '');
  const lines = ['# Folder notes', '', 'Read the note for a folder before working in it. Folders and their size in tokens:', ''];
  for (const folder of noted) {
    lines.push(`- \`${folder.notePath}\` (${formatTokens(folder.tokens)})${folder.noteSummary ? `: ${folder.noteSummary}` : ''}`);
  }
  if (noted.length === 0) lines.push('No folder has a note yet.');
  return lines.join('\n');
}

/** A text file this big costs an agent a lot of context to read whole. */
export const LARGE_FILE_TOKENS = 25_000;

/** The scan's findings for the bloat report: stale and missing notes, and very large text files. */
export function folderNoteFindings(report: FolderNotesReport): FolderNoteFinding[] {
  const out: FolderNoteFinding[] = [];
  for (const folder of report.folders) {
    if (folder.state === 'stale') {
      out.push({ kind: 'stale-note', path: folder.notePath!, tokens: folder.tokens, detail: folder.reasons.join('; ').slice(0, 300) });
    } else if (folder.state === 'missing') {
      out.push({
        kind: 'missing-note',
        path: folder.path,
        tokens: folder.ownTokens,
        detail: `${plural(folder.ownFiles, 'readable file')}, about ${formatTokens(folder.ownTokens)} tokens, with no ${NOTE_FILE}`,
      });
    }
  }
  const large = new Map<string, number>();
  for (const folder of report.folders) for (const file of folder.largest) if (file.tokens >= LARGE_FILE_TOKENS) large.set(file.path, file.tokens);
  for (const [path, tokens] of [...large].sort((a, b) => b[1] - a[1])) {
    out.push({ kind: 'large-file', path, tokens, detail: `about ${formatTokens(tokens)} tokens if an agent reads it whole` });
  }
  return out;
}

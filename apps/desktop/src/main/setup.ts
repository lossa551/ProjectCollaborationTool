import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CLAUDE_FILE, MEMORY_EXPORT_PATH, NOTE_FILE, SETUP_CONFIG_PATH, type ProjectFacts } from '@pct/shared';
import { DRAFT_LISTING_LIMIT, type FolderInfo, type FolderNotesReport, type NoteDraftInput } from '../common/folder-notes';
import { hasGitLfs, listProjectFiles } from './git';

// Project setup on this PC: reads what the wizard needs from your project
// folder (which engine, what the setup files say now), and writes the files
// it planned. What to write is worked out in @pct/shared (setup.ts).

const readText = (root: string, path: string) => readFile(join(root, ...path.split('/')), 'utf8').catch(() => null);

export async function readProjectFacts(root: string): Promise<ProjectFacts> {
  const entries = await readdir(root, { withFileTypes: true });
  const topFiles = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
  const uprojectName = topFiles.find((name) => /\.uproject$/i.test(name)) ?? null;
  const [uproject, godotProject, config, gitignore, gitattributes, agents, claude, memory, lfs] = await Promise.all([
    uprojectName ? readText(root, uprojectName) : Promise.resolve(null),
    topFiles.includes('project.godot') ? readText(root, 'project.godot') : Promise.resolve(null),
    readText(root, SETUP_CONFIG_PATH),
    readText(root, '.gitignore'),
    readText(root, '.gitattributes'),
    readText(root, NOTE_FILE),
    readText(root, CLAUDE_FILE),
    stat(join(root, ...MEMORY_EXPORT_PATH.split('/'))).then(
      (s) => s.isFile(),
      () => false,
    ),
    hasGitLfs(root),
  ]);
  return {
    topFiles,
    uproject: uprojectName ? { name: uprojectName, text: uproject ?? '' } : null,
    godotProject,
    config,
    gitignore,
    gitattributes,
    agents,
    claude,
    memoryFile: memory,
    lfs,
  };
}

/**
 * Writes files by repo-relative path; only the ones whose text changes. A file
 * that had Windows line endings keeps them. Returns the paths written.
 */
export function writeProjectFiles(root: string, files: Record<string, string>): string[] {
  const written: string[] = [];
  for (const [path, planned] of Object.entries(files)) {
    const file = join(root, ...path.split('/'));
    let text = planned;
    try {
      const old = readFileSync(file, 'utf8');
      if (old.includes('\r\n')) text = planned.replace(/\r?\n/g, '\r\n');
      if (old === text) continue;
    } catch {
      // New file.
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, text);
    renameSync(`${file}.tmp`, file);
    written.push(path);
  }
  return written;
}

/** Most first notes setup drafts; more can be asked for on the Folder notes tab. */
export const SETUP_NOTE_LIMIT = 8;

/**
 * The folders setup offers first notes for: big folders with no note, the
 * biggest first. The top folder is left out, since its AGENTS.md holds the
 * agent rules.
 */
export function noteCandidates(report: FolderNotesReport): FolderInfo[] {
  return report.folders
    .filter((f) => f.path !== '' && f.state === 'missing')
    .sort((a, b) => b.ownTokens - a.ownTokens)
    .slice(0, SETUP_NOTE_LIMIT);
}

const FILE_CHARS = 4000;
const PROMPT_FILES = 6;

/** What a drafting agent gets to see of a folder: its file names and the start of its main files. */
export async function noteDraftInput(root: string, folder: FolderInfo, report: FolderNotesReport): Promise<NoteDraftInput> {
  const prefix = folder.path ? `${folder.path}/` : '';
  // Subfolders with their own note are that note's business.
  const noted = report.folders.filter((f) => f.notePath && f.path !== folder.path && f.path.startsWith(prefix)).map((f) => `${f.path}/`);
  const listing = (await listProjectFiles(root))
    .filter((p) => p.startsWith(prefix) && !noted.some((n) => p.startsWith(n)))
    .sort()
    .slice(0, DRAFT_LISTING_LIMIT * 2);
  const depth = folder.path ? folder.path.split('/').length + 1 : 1;
  const subfolders = report.folders.filter((f) => f.path.startsWith(prefix) && f.path !== folder.path && f.path.split('/').length === depth);
  // Changed files first for an update, then the biggest files.
  const wanted = [
    ...folder.changed.filter((c) => c.change !== 'deleted').map((c) => c.path),
    ...folder.largest.map((f) => f.path),
  ].filter((p, i, all) => all.indexOf(p) === i && !p.endsWith(NOTE_FILE));
  const files: NoteDraftInput['files'] = [];
  for (const path of wanted) {
    if (files.length >= PROMPT_FILES) break;
    const text = await readText(root, path);
    if (text !== null && !text.slice(0, 2000).includes('\0')) files.push({ path, text: text.slice(0, FILE_CHARS) });
  }
  const existing = folder.notePath ? await readText(root, folder.notePath) : null;
  return { existing, listing, files, subfolders };
}

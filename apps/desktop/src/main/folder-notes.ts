import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { NOTE_FILE, summarizeNote, type FolderInfo, type FolderNotesReport, type NoteChange } from '../common/folder-notes';

// Scans your project folder for the Folder notes tab: the folder tree with
// each folder's token weight, its AGENTS.md if it has one, and whether that
// note still matches the folder. Files come from git (so .gitignore applies)
// minus a basic list of build and engine folders; history comes from one
// `git log` pass over the repository, never one call per folder.

/** Folders nobody should read or write notes for, whatever .gitignore says. */
const IGNORED_FOLDERS = new Set([
  'node_modules',
  '.git',
  '.godot',
  '.import',
  'Intermediate',
  'Saved',
  'DerivedDataCache',
  'Binaries',
  '.vs',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.venv',
  '.next',
]);
const IGNORED_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock)$|\.import$/;

const BINARY = new Set(
  (
    'png jpg jpeg gif bmp tga psd webp ico tif tiff exr hdr dds ktx ktx2 basis svgz ' +
    'wav mp3 ogg flac aiff aif m4a mp4 mov webm avi mkv ' +
    'fbx blend glb max ma mb abc usdz ' +
    'uasset umap upk pak ubulk uexp utoc ucas scn res ctex stex ' +
    'dll exe so dylib lib a o obj pdb ilk exp jar class wasm ' +
    'zip 7z rar gz tgz bz2 xz tar ' +
    'ttf otf woff woff2 eot pdf db sqlite sqlite3 bin dat'
  ).split(' '),
);
const TEXT = new Set(
  (
    'ts tsx js jsx mjs cjs json jsonc md mdx txt gd gdshader gdextension tscn tres godot cfg ini toml yaml yml xml html htm css scss less ' +
    'cs cpp cc cxx c h hpp hh inl py rs go java kt kts swift lua sh bash ps1 bat cmd cmake uproject uplugin target build ' +
    'glsl hlsl usf ush shader compute wgsl csv tsv svg sql graphql proto gitignore gitattributes editorconfig'
  ).split(' '),
);

/** Stop reading files past this many; giant asset folders do not need every file counted. */
export const FILE_LIMIT = 150_000;
/** History pass depth: older commits only matter when a note is older still. */
const LOG_LIMIT = 5000;

/** A folder with no note but this much readable text of its own deserves one. */
export const MISSING_TOKENS = 20_000;
export const MISSING_FILES = 25;
/** Missing notes are only asked for this deep (top folder is 0). */
const MISSING_DEPTH = 4;
/** A folder that is mostly one subfolder is a pass-through: the note belongs in that subfolder. */
const PASS_THROUGH_SHARE = 0.8;
/** A note goes stale when this many of its files changed (or this share, if more). */
const STALE_CHANGES = 5;
const STALE_SHARE = 0.25;

export interface ScanInput {
  root: string;
  /** Files in the project, present on disk, not ignored. */
  files: { path: string; bytes: number; binary: boolean }[];
  ignoredFiles: number;
  /** Note texts by repo-relative path. */
  notes: Record<string, string>;
  /** Last commit that touched each path: when, and how. Newest wins. */
  history: Map<string, { at: number; change: NoteChange }>;
  /** Changes not committed yet (untracked files count as added). */
  uncommitted: { path: string; change: NoteChange }[];
  /** Whether a repo-relative path exists, file or folder (ignored ones included). */
  exists: (path: string) => boolean;
  truncated: boolean;
  now: number;
}

const parentOf = (path: string) => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
};
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const depthOf = (folder: string) => (folder === '' ? 0 : folder.split('/').length);
const isNote = (path: string) => nameOf(path).toLowerCase() === NOTE_FILE.toLowerCase();
const tokensOf = (bytes: number) => Math.ceil(bytes / 4);

/** True when a path is in an ignored folder or is an ignored file. */
export function isIgnored(path: string): boolean {
  if (IGNORED_FILES.test(path)) return true;
  const parts = path.split('/');
  for (let i = 0; i < parts.length - 1; i++) if (IGNORED_FOLDERS.has(parts[i]!)) return true;
  return false;
}

/** Paths a note names: `in backticks` or as Markdown link targets, that look like files or folders. */
export function noteReferences(text: string): string[] {
  const found = new Set<string>();
  const candidates = [...text.matchAll(/`([^`\n]+)`/g), ...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!.trim());
  for (let candidate of candidates) {
    if (/\s|[*?<>{}|$]|:\/\/|^[a-z]+:/i.test(candidate) || candidate.startsWith('#')) continue;
    candidate = candidate.replace(/#.*$/, '').replace(/:\d+(:\d+)?$/, '').replace(/^\.\//, '');
    const looksLikePath = candidate.includes('/') || /\.[a-z][a-z0-9]{0,7}$/i.test(candidate);
    if (!candidate || !looksLikePath || /^\.+\/?$/.test(candidate) || /^[\w.-]+\(\)/.test(candidate)) continue;
    found.add(candidate.replace(/\/+$/, ''));
  }
  return [...found];
}

const resolveFrom = (folder: string, reference: string) => {
  if (reference.startsWith('/')) return posix.normalize(reference.slice(1));
  return posix.normalize(folder ? `${folder}/${reference}` : reference);
};

interface Acc {
  path: string;
  notePath: string | null;
  tokens: number;
  files: number;
  binaryFiles: number;
  binaryBytes: number;
  ownTokens: number;
  ownFiles: number;
  ownPaths: { path: string; tokens: number }[];
  children: Set<string>;
}

/** Builds the report from what the scan read. Pure, so it can be tested without git. */
export function buildReport(input: ScanInput): FolderNotesReport {
  const folders = new Map<string, Acc>();
  const folder = (path: string): Acc => {
    let acc = folders.get(path);
    if (!acc) {
      acc = { path, notePath: null, tokens: 0, files: 0, binaryFiles: 0, binaryBytes: 0, ownTokens: 0, ownFiles: 0, ownPaths: [], children: new Set() };
      folders.set(path, acc);
      if (path !== '') {
        folder(parentOf(path)).children.add(path);
      }
    }
    return acc;
  };
  folder('');

  for (const file of input.files) {
    const dir = parentOf(file.path);
    folder(dir).children.add(file.path);
    if (isNote(file.path) && input.notes[file.path] !== undefined) folder(dir).notePath = file.path;
  }

  // The note that covers a folder: its own, else the nearest one above it.
  const coverOf = new Map<string, string>();
  const cover = (path: string): string => {
    const known = coverOf.get(path);
    if (known !== undefined) return known;
    const result = folders.get(path)?.notePath || path === '' ? path : cover(parentOf(path));
    coverOf.set(path, result);
    return result;
  };

  let totalTokens = 0;
  let totalFiles = 0;
  let totalBinary = 0;
  let totalBinaryBytes = 0;
  for (const file of input.files) {
    const dir = parentOf(file.path);
    const tokens = file.binary ? 0 : tokensOf(file.bytes);
    for (let path: string | null = dir; path !== null; path = path === '' ? null : parentOf(path)) {
      const acc = folder(path);
      if (file.binary) {
        acc.binaryFiles++;
        acc.binaryBytes += file.bytes;
      } else {
        acc.tokens += tokens;
        acc.files++;
      }
    }
    if (file.binary) {
      totalBinary++;
      totalBinaryBytes += file.bytes;
    } else {
      totalTokens += tokens;
      totalFiles++;
      // Own weight goes to the folder whose note covers it, and to every folder
      // in between that has no note (so a missing note shows where the weight is).
      for (let path = dir; ; path = parentOf(path)) {
        const acc = folder(path);
        acc.ownTokens += tokens;
        acc.ownFiles++;
        acc.ownPaths.push({ path: file.path, tokens });
        if (acc.notePath || path === '') break;
      }
    }
  }

  // Changes since each note, from history and uncommitted work. A note being
  // edited right now counts as up to date; one older than the history pass as
  // older than everything in it.
  const current = new Set(input.files.map((f) => f.path));
  const uncommitted = new Map(input.uncommitted.map((u) => [u.path, u.change]));
  const noteTime = (notePath: string): number | null => (uncommitted.has(notePath) ? null : (input.history.get(notePath)?.at ?? 0));
  const changedSince = new Map<string, { path: string; change: NoteChange }[]>();
  const record = (path: string, change: NoteChange, at: number | null) => {
    if (isNote(path) || isIgnored(path)) return;
    // cover() walks up past folders that no longer exist, e.g. after a folder was deleted.
    const notePath = folders.get(cover(parentOf(path)))?.notePath;
    if (!notePath) return;
    const since = noteTime(notePath);
    if (since === null || (at !== null && at <= since)) return;
    const list = changedSince.get(notePath) ?? [];
    list.push({ path, change });
    changedSince.set(notePath, list);
  };
  for (const [path, change] of uncommitted) record(path, change, null);
  for (const [path, last] of input.history) {
    if (uncommitted.has(path)) continue;
    // Only what is still true now: re-added files are not deleted, and so on.
    if ((last.change === 'deleted') === current.has(path)) continue;
    record(path, last.change, last.at);
  }

  const passThrough = (acc: Acc) =>
    [...acc.children].some((child) => {
      const sub = folders.get(child);
      return sub && !sub.notePath && sub.ownTokens >= acc.ownTokens * PASS_THROUGH_SHARE;
    });

  const result: FolderInfo[] = [];
  let notes = 0;
  const visit = (path: string) => {
    const acc = folders.get(path)!;
    const depth = depthOf(path);
    const text = acc.notePath ? (input.notes[acc.notePath] ?? '') : '';
    const references = acc.notePath ? noteReferences(text) : [];
    const deadReferences = references.filter((ref) => !input.exists(resolveFrom(path, ref)) && !input.exists(resolveFrom('', ref)));
    const mentioned = text.toLowerCase();
    const unmentioned = acc.notePath
      ? [...acc.children]
          .filter((child) => child !== acc.notePath && !nameOf(child).startsWith('.'))
          .filter((child) => !mentioned.includes(nameOf(child).toLowerCase()))
          .map((child) => (folders.has(child) ? `${child}/` : child))
          .sort()
          .slice(0, 50)
      : [];
    const changed = acc.notePath ? (changedSince.get(acc.notePath) ?? []).sort((a, b) => a.path.localeCompare(b.path)) : [];
    const reasons: string[] = [];
    let state: FolderInfo['state'];
    if (acc.notePath) {
      notes++;
      const staleAt = Math.max(STALE_CHANGES, Math.ceil(acc.ownFiles * STALE_SHARE));
      if (deadReferences.length) reasons.push(`names ${deadReferences.length === 1 ? 'a path' : `${deadReferences.length} paths`} that no longer exist`);
      if (changed.length) reasons.push(`${changed.length} ${changed.length === 1 ? 'file' : 'files'} changed since the note`);
      state = deadReferences.length || changed.length >= staleAt ? 'stale' : changed.length ? 'drifting' : 'fresh';
    } else if (
      depth <= MISSING_DEPTH &&
      acc.ownTokens > 0 &&
      (acc.ownTokens >= MISSING_TOKENS || acc.ownFiles >= MISSING_FILES) &&
      !passThrough(acc)
    ) {
      state = 'missing';
      reasons.push(`${acc.ownFiles} readable files with no note`);
    } else {
      state = 'not-needed';
    }
    result.push({
      path,
      depth,
      notePath: acc.notePath,
      state,
      tokens: acc.tokens,
      ownTokens: acc.ownTokens,
      ownFiles: acc.ownFiles,
      files: acc.files,
      binaryFiles: acc.binaryFiles,
      binaryBytes: acc.binaryBytes,
      noteTokens: tokensOf(text.length),
      noteSummary: acc.notePath ? summarizeNote(text) || null : null,
      noteCommittedAt: acc.notePath ? noteTime(acc.notePath) : null,
      changed,
      deadReferences,
      unmentioned,
      largest: [...acc.ownPaths].sort((a, b) => b.tokens - a.tokens).slice(0, 10),
      reasons,
    });
    const subfolders = [...acc.children].filter((child) => folders.has(child)).sort();
    for (const child of subfolders) visit(child);
  };
  visit('');

  return {
    root: input.root,
    scannedAt: input.now,
    folders: result,
    totals: { tokens: totalTokens, files: totalFiles, binaryFiles: totalBinary, binaryBytes: totalBinaryBytes, notes, ignoredFiles: input.ignoredFiles },
    truncated: input.truncated,
  };
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, timeout: 120_000, windowsHide: true, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        reject(new Error(missing ? 'Git is not installed or not on the PATH.' : String(stderr).trim() || error.message));
      } else resolve(String(stdout));
    });
  });
}

const zList = (output: string) => output.split('\0').filter(Boolean);

/** Parses `git log --name-status --no-renames --format=@@%ct`: the newest commit touching each path. */
export function parseLog(output: string): Map<string, { at: number; change: NoteChange }> {
  const history = new Map<string, { at: number; change: NoteChange }>();
  let at = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('@@')) {
      at = Number(line.slice(2)) * 1000;
      continue;
    }
    const match = /^([AMDT])\t(.+)$/.exec(line);
    if (!match) continue;
    let path = match[2]!;
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1).replace(/\\(.)/g, '$1');
    if (!history.has(path)) history.set(path, { at, change: match[1] === 'A' ? 'added' : match[1] === 'D' ? 'deleted' : 'modified' });
  }
  return history;
}

async function isBinary(file: string, path: string): Promise<boolean> {
  const dot = path.lastIndexOf('.');
  const ext = dot > path.lastIndexOf('/') ? path.slice(dot + 1).toLowerCase() : '';
  if (BINARY.has(ext)) return true;
  if (TEXT.has(ext) || ext === 'md') return false;
  // Unknown kind: a NUL byte near the start means binary.
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(2048);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/** Runs fn over items, a few at a time. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Scans a repository (its top folder) and builds the folder notes report. */
export async function scanFolderNotes(root: string): Promise<FolderNotesReport> {
  const tracked = zList(await git(root, ['ls-files', '-z', '--cached']));
  const untracked = zList(await git(root, ['ls-files', '-z', '--others', '--exclude-standard']));
  const hasHead = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(
    () => true,
    () => false,
  );
  const [log, diff] = hasHead
    ? await Promise.all([
        git(root, ['log', '--name-status', '--no-renames', '--format=@@%ct', `--max-count=${LOG_LIMIT}`, 'HEAD']),
        git(root, ['diff', '--name-status', '--no-renames', '-z', 'HEAD']),
      ])
    : ['', ''];

  const uncommitted: ScanInput['uncommitted'] = untracked.map((path) => ({ path, change: 'added' }));
  const diffParts = zList(diff);
  for (let i = 0; i + 1 < diffParts.length; i += 2) {
    const letter = diffParts[i]![0];
    uncommitted.push({ path: diffParts[i + 1]!, change: letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified' });
  }

  const listed = [...new Set([...tracked, ...untracked])];
  const kept = listed.filter((path) => !isIgnored(path));
  const truncated = kept.length > FILE_LIMIT;
  const files: ScanInput['files'] = [];
  const notes: Record<string, string> = {};
  await eachLimited(kept.slice(0, FILE_LIMIT), 32, async (path) => {
    const full = join(root, path);
    try {
      const info = await stat(full);
      if (!info.isFile()) return;
      files.push({ path, bytes: info.size, binary: await isBinary(full, path) });
      if (isNote(path)) notes[path] = await readFile(full, 'utf8');
    } catch {
      // Deleted but not committed yet, or unreadable: not part of the folder now.
    }
  });
  files.sort((a, b) => a.path.localeCompare(b.path));

  return buildReport({
    root,
    files,
    ignoredFiles: listed.length - kept.length,
    notes,
    history: parseLog(log),
    uncommitted,
    exists: (path) => !path.startsWith('..') && existsSync(join(root, path)),
    truncated,
    now: Date.now(),
  });
}

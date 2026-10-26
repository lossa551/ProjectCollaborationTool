import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeBloat, type BloatReport, type ScannedFile } from '@pct/shared';
import { folderNoteFindings } from '../common/folder-notes';
import { scanFolderNotes } from './folder-notes';
import { listProjectFiles } from './git';

// Reads the project folder for the bloat check: every file git knows about
// (ignored files left out), hashed to find copies, and the text of the ones
// small enough to search for references. The analysis itself is shared.

/** Most files looked at; bigger projects are checked in part. */
const FILE_LIMIT = 20_000;
/** Larger files are not hashed (big binaries rarely are exact copies by accident). */
const HASH_LIMIT = 32 * 1024 * 1024;
const TEXT_LIMIT = 1024 * 1024;

export async function scanProject(root: string): Promise<{ files: ScannedFile[]; truncated: boolean }> {
  const paths = await listProjectFiles(root);
  const truncated = paths.length > FILE_LIMIT;
  const files: ScannedFile[] = [];
  const queue = paths.slice(0, FILE_LIMIT);
  // A few files at a time, so a big project does not open thousands at once.
  const worker = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const file = await readOne(root, path);
      if (file) files.push(file);
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, truncated };
}

async function readOne(root: string, path: string): Promise<ScannedFile | null> {
  try {
    const full = join(root, path);
    const info = await stat(full);
    if (!info.isFile()) return null;
    if (info.size > HASH_LIMIT) return { path, size: info.size, hash: null, text: null };
    const data = await readFile(full);
    const hash = createHash('sha1').update(data).digest('hex');
    const sample = data.subarray(0, 8000);
    const text = info.size <= TEXT_LIMIT && !sample.includes(0) ? data.toString('utf8') : null;
    return { path, size: info.size, hash, text };
  } catch {
    // Deleted since git listed it, or not readable: left out.
    return null;
  }
}

export async function runBloatCheck(root: string, ranBy: string, branch: string | null): Promise<BloatReport> {
  const [{ files, truncated }, notes] = await Promise.all([
    scanProject(root),
    // The folder notes part is extra: without it the rest of the report still stands.
    scanFolderNotes(root).catch(() => null),
  ]);
  return analyzeBloat(files, { ranBy, branch, truncated }, Date.now(), notes ? folderNoteFindings(notes) : []);
}

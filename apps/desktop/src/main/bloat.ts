import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SETUP_CONFIG_PATH,
  analyzeBloat,
  matchesAny,
  packagePaths,
  parseSetupConfig,
  type BloatReport,
  type BloatTrigger,
  type ScannedFile,
  type SetupConfig,
} from '@pct/shared';
import { folderNoteFindings } from '../common/folder-notes';
import { scanFolderNotes } from './folder-notes';
import { headCommit, listProjectFiles } from './git';

// Reads the project folder for the bloat check: every file git knows about
// (ignored files left out), hashed to find copies, and the text of the ones
// small enough to search for references. The analysis itself is shared.

/** Most files looked at; bigger projects are checked in part. Unreal projects run to tens of thousands of assets. */
export const FILE_LIMIT = 150_000;
/** Most text kept in memory for reference searches; past it, files are hashed but not searched. */
const TEXT_BUDGET = 512 * 1024 * 1024;
/** A Git LFS pointer is a few lines of text. */
const LFS_POINTER_SIZE = 1024;
const LFS_POINTER = 'version https://git-lfs';
/** Larger files are not hashed (big binaries rarely are exact copies by accident). */
const HASH_LIMIT = 32 * 1024 * 1024;
const TEXT_LIMIT = 1024 * 1024;
/** How much of an Unreal asset is read for the packages it uses: the header (name table) is at the start. */
const UNREAL_HEADER = 4 * 1024 * 1024;

/** The project's setup file (.collab-tool.json): its skips (generated and engine-owned files) and Unreal layout. */
async function setupConfig(root: string): Promise<SetupConfig | null> {
  return parseSetupConfig(await readFile(join(root, SETUP_CONFIG_PATH), 'utf8').catch(() => null));
}

/** The /Game/... packages an Unreal asset's header names; undefined for a Git LFS pointer (the asset is not pulled). */
function unrealRefs(data: Buffer): string[] | undefined {
  const head = data.subarray(0, UNREAL_HEADER).toString('latin1');
  return head.startsWith(LFS_POINTER) ? undefined : packagePaths(head);
}

async function readHeader(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(UNREAL_HEADER);
    const { bytesRead } = await handle.read(buffer, 0, UNREAL_HEADER, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function scanProject(root: string, config?: SetupConfig | null): Promise<{ files: ScannedFile[]; truncated: boolean }> {
  const skips = (config === undefined ? await setupConfig(root) : config)?.bloatSkip ?? [];
  const paths = (await listProjectFiles(root)).filter((path) => !matchesAny(path, skips));
  let truncated = paths.length > FILE_LIMIT;
  const files: ScannedFile[] = [];
  const queue = paths.slice(0, FILE_LIMIT);
  let textLeft = TEXT_BUDGET;
  // A few files at a time, so a big project does not open thousands at once.
  const worker = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const file = await readOne(root, path);
      if (!file) continue;
      if (file.text !== null) {
        textLeft -= file.text.length;
        if (textLeft < 0) {
          // Not searched: what it refers to is unknown, so the report says it is partial.
          file.text = null;
          truncated = true;
        }
      }
      files.push(file);
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
    const unreal = /\.(uasset|umap)$/i.test(path);
    if (info.size > HASH_LIMIT) return { path, size: info.size, hash: null, text: null, ...(unreal ? { refs: unrealRefs(await readHeader(full)) } : {}) };
    const data = await readFile(full);
    const hash = createHash('sha1').update(data).digest('hex');
    const sample = data.subarray(0, 8000);
    const text = info.size <= TEXT_LIMIT && !sample.includes(0) ? data.toString('utf8') : null;
    // Pulled or not, a pointer is not the file: nothing in it to search or to compare.
    if (info.size <= LFS_POINTER_SIZE && text?.startsWith(LFS_POINTER)) return { path, size: info.size, hash, text: null, lfs: true };
    return { path, size: info.size, hash, text, ...(unreal ? { refs: unrealRefs(data) } : {}) };
  } catch {
    // Deleted since git listed it, or not readable: left out.
    return null;
  }
}

export async function runBloatCheck(root: string, ranBy: string, branch: string | null, trigger: BloatTrigger = 'manual'): Promise<BloatReport> {
  const setup = await setupConfig(root);
  const [{ files, truncated }, notes, commit] = await Promise.all([
    scanProject(root, setup),
    // The folder notes part is extra: without it the rest of the report still stands.
    scanFolderNotes(root).catch(() => null),
    headCommit(root),
  ]);
  return analyzeBloat(files, { ranBy, branch, commit, trigger, truncated, setup }, Date.now(), notes ? folderNoteFindings(notes) : []);
}

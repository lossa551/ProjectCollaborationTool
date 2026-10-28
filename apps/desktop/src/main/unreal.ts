import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendSection, missingLines } from '@pct/shared';
import { commitPaths, hasCommit } from './git';
import { writeProjectFiles } from './setup';

// EngineWire in an Unreal project (issue #11). Agents reach the Unreal Editor
// through this plugin (ChiR24/Unreal_mcp), so the app adds it with one click:
// the plugin's folder at the version the app's MCP server is pinned to, in
// the project's Plugins folder. It stays out of the repository, so each PC
// adds its own (with the app) and an editor without it never asks for a
// missing plugin. Unreal builds it from source when it next opens the project.

export const ENGINEWIRE_REPO = 'https://github.com/ChiR24/Unreal_mcp.git';
/** The EngineWire release the app installs, and pins its MCP server (npx unreal-engine-mcp-server) to. */
export const ENGINEWIRE_VERSION = '0.6.0';
export const ENGINEWIRE_COMMIT_MESSAGE = 'Keep EngineWire (the Unreal Editor plugin agents use) out of the repository';

const git = (args: string[], cwd: string) =>
  new Promise<void>((resolve, reject) =>
    execFile('git', args, { cwd, timeout: 180_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, _out, stderr) => {
      if (!error) return resolve();
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      reject(new Error(missing ? 'Git is not installed or not on the PATH.' : String(stderr).trim() || error.message));
    }),
  );

/** The .gitignore line for the plugin, for a .uproject at this repo-relative path. */
export function engineWireIgnore(uproject: string): string {
  const dir = uproject.includes('/') ? uproject.slice(0, uproject.lastIndexOf('/') + 1) : '';
  return `${dir}Plugins/EngineWire/`;
}

/**
 * Copies EngineWire into <project>/Plugins/EngineWire (replacing an older
 * copy) and makes sure .gitignore keeps it out, committing only that line.
 */
export async function addEngineWire(root: string, uproject: string, repo = ENGINEWIRE_REPO): Promise<void> {
  const projectDir = join(root, ...uproject.split('/').slice(0, -1));
  const temp = mkdtempSync(join(tmpdir(), 'pct-enginewire-'));
  try {
    // Only the plugin's folder, at the tag the MCP server is pinned to.
    await git(['clone', '--depth', '1', '--branch', `v${ENGINEWIRE_VERSION}`, '--filter=blob:none', '--sparse', repo, 'src'], temp);
    const src = join(temp, 'src');
    await git(['sparse-checkout', 'set', 'plugins/EngineWire'], src);
    const plugin = join(src, 'plugins', 'EngineWire');
    if (!existsSync(join(plugin, 'EngineWire.uplugin'))) throw new Error(`EngineWire ${ENGINEWIRE_VERSION} has no plugin folder where the app expects it.`);
    const target = join(projectDir, 'Plugins', 'EngineWire');
    await rm(target, { recursive: true, force: true });
    await cp(plugin, target, { recursive: true });
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
  const ignorePath = join(root, '.gitignore');
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : null;
  const added = missingLines(ignore, [engineWireIgnore(uproject)]);
  if (added.length) {
    const written = writeProjectFiles(root, { '.gitignore': appendSection(ignore, '# Added by Foreus (Unreal Editor plugin, added on each PC)', added) });
    if (await hasCommit(root)) await commitPaths(root, written, ENGINEWIRE_COMMIT_MESSAGE);
  }
}

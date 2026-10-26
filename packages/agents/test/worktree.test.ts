import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentBranchName,
  canMakeWorktrees,
  commitAll,
  createWorktree,
  defaultWorktreeFolder,
  mainCheckout,
  pickBase,
  removeWorktree,
  slugify,
  worktreeDiff,
  worktreeReady,
  worktreeStatus,
} from '@pct/agents';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

function project() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'pct-wt-')));
  dirs.push(parent);
  const root = join(parent, 'game');
  mkdirSync(join(root, 'src'), { recursive: true });
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 'test@example.com');
  sh(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, 'src/player.gd'), 'v1\n');
  sh(root, 'add', '.');
  sh(root, 'commit', '-qm', 'start');
  return { parent, root };
}

describe('agent copies', () => {
  it('names branches and folders after the task, short enough for Windows', () => {
    expect(slugify('Double jump: the "air" part!')).toBe('double-jump-the-air-part');
    expect(slugify('???')).toBe('work');
    expect(slugify('a'.repeat(80)).length).toBe(32);
    expect(agentBranchName('Double jump', '3F2A1C9d-xx')).toBe('agent/double-jump-3f2a1c');
    expect(defaultWorktreeFolder(join(tmpdir(), 'game'), 'agent/double-jump-3f2a1c')).toBe(join(tmpdir(), 'game-agents', 'double-jump-3f2a1c'));
  });

  it('makes a copy on its own branch, reports its changes, and is reused or rebuilt from the branch', async () => {
    const { parent, root } = project();
    expect(await canMakeWorktrees(root)).toBe(true);
    const folder = join(parent, 'game-agents', 'jump');
    const base = await pickBase(root, ['task/jump']);
    expect(base).toEqual({ base: 'main', ref: 'HEAD' });
    const { baseCommit } = await createWorktree({ root, folder, branch: 'agent/jump', from: base.ref });
    expect(baseCommit).toBe(sh(root, 'rev-parse', 'HEAD'));
    expect(await worktreeReady(folder, 'agent/jump')).toBe(true);
    expect(await mainCheckout(folder)).toBe(await mainCheckout(root));

    writeFileSync(join(folder, 'src/player.gd'), 'v2\n');
    writeFileSync(join(folder, 'src/jump.gd'), 'jump\n');
    const where = { branch: 'main', commit: baseCommit };
    expect(await worktreeStatus(folder, where)).toEqual({
      files: [
        { path: 'src/player.gd', change: 'modified' },
        { path: 'src/jump.gd', change: 'untracked' },
      ],
      truncated: false,
      commits: 0,
      uncommitted: 2,
    });
    const diff = await worktreeDiff(folder, where);
    expect(diff).toContain('+v2');
    expect(diff).toContain('+++ b/src/jump.gd');
    // The person's folder is untouched.
    expect(sh(root, 'status', '--porcelain')).toBe('');

    expect(await commitAll(folder, 'Builder: jump')).toMatch(/^[0-9a-f]{40}$/);
    expect(await commitAll(folder, 'nothing')).toBeNull();
    const committed = await worktreeStatus(folder, where);
    expect(committed).toMatchObject({ commits: 1, uncommitted: 0 });
    expect(committed.files.map((f) => f.path).sort()).toEqual(['src/jump.gd', 'src/player.gd']);

    // Folder deleted by hand: made again from the branch, commits and all.
    rmSync(folder, { recursive: true, force: true });
    expect(await worktreeReady(folder, 'agent/jump')).toBe(false);
    await createWorktree({ root, folder, branch: 'agent/jump', from: baseCommit });
    expect(existsSync(join(folder, 'src/jump.gd'))).toBe(true);

    // Merged into main: nothing left to merge.
    sh(root, 'merge', '-q', '--no-ff', '-m', 'merge', 'agent/jump');
    expect(await worktreeStatus(folder, where)).toEqual({ files: [], truncated: false, commits: 0, uncommitted: 0 });

    await removeWorktree(root, folder, 'agent/jump', true);
    expect(existsSync(folder)).toBe(false);
    expect(sh(root, 'branch', '--list', 'agent/jump')).toBe('');
  });

  it('starts from the task’s branch when there is one', async () => {
    const { parent, root } = project();
    sh(root, 'switch', '-q', '-c', 'task/jump');
    writeFileSync(join(root, 'src/task.gd'), 'task\n');
    sh(root, 'add', '.');
    sh(root, 'commit', '-qm', 'task work');
    sh(root, 'switch', '-q', 'main');
    const base = await pickBase(root, ['task/jump']);
    expect(base).toEqual({ base: 'task/jump', ref: 'task/jump' });
    const folder = join(parent, 'game-agents', 'jump');
    await createWorktree({ root, folder, branch: 'agent/jump', from: base.ref });
    expect(existsSync(join(folder, 'src/task.gd'))).toBe(true);
  });
});

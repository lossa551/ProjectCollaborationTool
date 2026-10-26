import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalWorkspace } from '../src/common/api';
import { WorkspaceWatcher, parseNameStatus, repositoryRoot } from '../src/main/workspace';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'pct-ws-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('remote', 'add', 'origin', 'git@github.com:martin/game.git');
  return { dir, git, write: (path: string, text: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  } };
}

async function read(dir: string, defaultBranch: string | null = 'main'): Promise<LocalWorkspace> {
  let state: LocalWorkspace | null = null;
  const watcher = new WorkspaceWatcher(dir, () => defaultBranch, (next) => (state = next));
  await watcher.poll();
  return state ?? watcher.getState();
}

describe('workspace watcher', () => {
  it('lists committed and uncommitted changes since the branch left main', async () => {
    const { dir, git, write } = repo();
    write('scripts/player.gd', 'v1');
    write('readme.md', 'hi');
    git('add', '.');
    git('commit', '-qm', 'start');
    git('checkout', '-qb', 'task/jump');
    write('scripts/jump.gd', 'jump');
    git('add', '.');
    git('commit', '-qm', 'jump');
    write('scripts/player.gd', 'v2');
    write('notes/todo.txt', 'new');
    git('rm', '-q', 'readme.md');

    const state = await read(join(dir, 'scripts'));
    expect(state.error).toBeNull();
    expect(state.remote).toEqual({ owner: 'martin', name: 'game' });
    expect(state.workspace?.branch).toBe('task/jump');
    expect(state.workspace?.base).toBe('main');
    expect(state.workspace?.files.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'notes/todo.txt', change: 'untracked' },
      { path: 'readme.md', change: 'deleted' },
      { path: 'scripts/jump.gd', change: 'added' },
      { path: 'scripts/player.gd', change: 'modified' },
    ]);
  });

  it('finds the repository root and refuses folders outside git', async () => {
    const { dir, write, git } = repo();
    write('a/b/c.txt', 'x');
    git('add', '.');
    git('commit', '-qm', 'x');
    expect((await repositoryRoot(join(dir, 'a', 'b'))).toLowerCase()).toContain('pct-ws-');
    const plain = mkdtempSync(join(tmpdir(), 'pct-plain-'));
    dirs.push(plain);
    await expect(repositoryRoot(plain)).rejects.toThrow(/not inside a git repository/);
  });

  it('reads renames from git diff output', () => {
    expect(parseNameStatus('R087\0old.gd\0new.gd\0M\0a.gd\0')).toEqual([
      { path: 'new.gd', change: 'renamed' },
      { path: 'a.gd', change: 'modified' },
    ]);
  });
});

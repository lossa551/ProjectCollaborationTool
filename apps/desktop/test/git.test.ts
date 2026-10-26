import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clone, parseStatus, readGitInfo, repositoryRoot, runGitAction, tagCommit } from '../src/main/git';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pct-git-'));
  dirs.push(dir);
  return dir;
};
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

/** A "GitHub" (bare repository with one commit on main) and a clone of it. */
async function setup() {
  const root = temp();
  const origin = join(root, 'origin.git');
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(root, 'seed');
  sh(root, 'clone', '-q', origin, seed);
  configure(seed);
  writeFileSync(join(seed, 'game.gd'), 'v1\n');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-qm', 'start');
  sh(seed, 'push', '-q', 'origin', 'main');
  const mine = join(root, 'mine');
  await clone(origin, mine, root, null);
  configure(mine);
  return { root, origin, seed, mine };
}

function configure(dir: string) {
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Test');
}

describe('parseStatus', () => {
  it('reads upstream, ahead/behind, changes and conflicts', () => {
    const output = [
      '# branch.oid abc',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 a b src/my file.gd',
      '1 D. N... 100644 000000 000000 a b old.gd',
      '1 A. N... 000000 100644 100644 a b new.gd',
      '2 R. N... 100644 100644 100644 a b R100 renamed.gd',
      'was.gd',
      'u UU N... 100644 100644 100644 100644 a b c both.gd',
      '? notes.txt',
      '',
    ].join('\0');
    expect(parseStatus(output)).toEqual({
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      uncommitted: [
        { path: 'src/my file.gd', change: 'modified' },
        { path: 'old.gd', change: 'deleted' },
        { path: 'new.gd', change: 'added' },
        { path: 'renamed.gd', change: 'renamed' },
        { path: 'notes.txt', change: 'untracked' },
      ],
      conflicted: ['both.gd'],
    });
  });
});

// Each test runs dozens of git commands, which take a while on Windows.
describe('git actions', { timeout: 30_000 }, () => {
  it('says plainly when a folder is not a repository', async () => {
    await expect(repositoryRoot(temp())).rejects.toMatchObject({ code: 'not-a-repo', message: 'That folder is not inside a git repository.' });
  });

  it('commits, pushes a new branch and pulls what others pushed', async () => {
    const { seed, mine } = await setup();
    expect(await runGitAction(mine, { type: 'create-branch', branch: 'task/jump', from: 'main' }, null)).toBe('Created task/jump from the latest main.');
    writeFileSync(join(mine, 'jump.gd'), 'jump\n');
    expect((await readGitInfo(mine)).uncommitted).toEqual([{ path: 'jump.gd', change: 'untracked' }]);
    expect(await runGitAction(mine, { type: 'commit', message: 'Add jump' }, null)).toBe('Committed.');
    expect(await runGitAction(mine, { type: 'commit', message: 'Again' }, null)).toBe('Nothing to commit.');
    expect((await readGitInfo(mine)).upstream).toBeNull();
    expect(await runGitAction(mine, { type: 'push' }, null)).toBe('Pushed task/jump to GitHub.');
    expect((await readGitInfo(mine)).upstream).toBe('origin/task/jump');

    // Someone else adds to the branch.
    sh(seed, 'fetch', '-q');
    sh(seed, 'switch', '-q', 'task/jump');
    writeFileSync(join(seed, 'land.gd'), 'land\n');
    sh(seed, 'add', '.');
    sh(seed, 'commit', '-qm', 'Add land');
    sh(seed, 'push', '-q');

    expect(await runGitAction(mine, { type: 'fetch' }, null)).toBe('1 new commit on GitHub. Pull to get them.');
    expect(await runGitAction(mine, { type: 'pull' }, null)).toBe('Pulled the latest changes.');
    expect((await readGitInfo(mine)).behind).toBe(0);
    expect(await runGitAction(mine, { type: 'pull' }, null)).toBe('Already up to date.');
  });

  it('switches to a branch that is only on GitHub', async () => {
    const { seed, mine } = await setup();
    sh(seed, 'switch', '-q', '-c', 'task/art');
    sh(seed, 'push', '-q', '-u', 'origin', 'task/art');
    await runGitAction(mine, { type: 'fetch' }, null);
    expect((await readGitInfo(mine)).remoteBranches).toEqual(['task/art']);
    expect(await runGitAction(mine, { type: 'switch', branch: 'task/art' }, null)).toBe('Switched to task/art.');
    const info = await readGitInfo(mine);
    expect(info.branches.sort()).toEqual(['main', 'task/art']);
    expect(info.remoteBranches).toEqual([]);
  });

  it('explains a rejected push, reports pull conflicts and aborts the merge', async () => {
    const { seed, mine } = await setup();
    writeFileSync(join(seed, 'game.gd'), 'theirs\n');
    sh(seed, 'commit', '-qam', 'theirs');
    sh(seed, 'push', '-q');
    writeFileSync(join(mine, 'game.gd'), 'mine\n');
    await runGitAction(mine, { type: 'commit', message: 'mine' }, null);

    await expect(runGitAction(mine, { type: 'push' }, null)).rejects.toThrow('GitHub has commits on this branch that you do not have. Pull first, then push.');
    expect(await runGitAction(mine, { type: 'pull' }, null)).toBe(
      'Pulled, but 1 file has conflicts. Fix them in your editor and commit, or abort the merge.',
    );
    let info = await readGitInfo(mine);
    expect(info.conflicted).toEqual(['game.gd']);
    expect(info.merging).toBe(true);
    await expect(runGitAction(mine, { type: 'commit', message: 'merge' }, null)).rejects.toThrow('Fix the conflicts in 1 file first.');

    await runGitAction(mine, { type: 'abort-merge' }, null);
    info = await readGitInfo(mine);
    expect(info.merging).toBe(false);
    expect(info.conflicted).toEqual([]);
    expect(info.ahead).toBe(1);
  });

  it('rejects bad branch names', async () => {
    const { mine } = await setup();
    await expect(runGitAction(mine, { type: 'create-branch', branch: 'bad..name', from: null }, null)).rejects.toThrow('That is not a valid branch name.');
  });
});

describe('tagCommit', () => {
  it('tags the checked-out commit with the snapshot label', async () => {
    const { mine } = await setup();
    expect(await tagCommit(mine, 'snapshot/20261026-1540-before-rewrite', 'Before the rewrite')).toBe('snapshot/20261026-1540-before-rewrite');
    expect(sh(mine, 'rev-parse', 'snapshot/20261026-1540-before-rewrite^{commit}')).toBe(sh(mine, 'rev-parse', 'HEAD'));
    expect(sh(mine, 'tag', '-l', '--format=%(contents:subject)', 'snapshot/*')).toBe('Before the rewrite');
    await expect(tagCommit(mine, 'bad..name', 'x')).rejects.toThrow(/not a valid tag/);
  });
});

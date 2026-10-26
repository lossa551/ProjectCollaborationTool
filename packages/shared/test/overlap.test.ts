import { describe, expect, it } from 'vitest';
import {
  EMPTY_GITHUB_STATUS,
  filesOutsideScope,
  findOverlaps,
  overlapsForTask,
  parseRepoRef,
  pullForBranch,
  type GitHubStatus,
  type Lock,
  type PullRequest,
  type Task,
  type Workspace,
} from '../src/index.js';

const ws = (branch: string | null, paths: string[]): Workspace => ({
  branch,
  base: 'origin/main',
  files: paths.map((path) => ({ path, change: 'modified' })),
  truncated: false,
  updatedAt: 0,
});

const pull = (number: number, branch: string, files: string[], state: PullRequest['state'] = 'open'): PullRequest => ({
  number,
  title: `PR ${number}`,
  url: '',
  state,
  draft: false,
  author: 'x',
  branch,
  base: 'main',
  mergeable: 'mergeable',
  review: 'none',
  checks: 'none',
  checkRuns: [],
  files,
  updatedAt: number,
});

const github = (pulls: PullRequest[], branches: GitHubStatus['branches'] = []): GitHubStatus => ({
  ...EMPTY_GITHUB_STATUS,
  defaultBranch: 'main',
  pulls,
  branches,
});

const lock = (path: string, holderId: string, taskId: string | null = null): Lock => ({
  id: `lock-${path}-${holderId}`,
  path,
  kind: 'exclusive',
  holder: { id: holderId, name: holderId, kind: 'human' },
  taskId,
  chatId: null,
  reason: null,
  acquiredAt: 0,
  heartbeatAt: 0,
  abandoned: false,
});

const task = (id: string, branch: string | null, scope: string[] = []): Task => ({
  id,
  title: id,
  stage: 'implementing',
  owner: null,
  scope,
  readFirst: [],
  branch,
  featureId: null,
  criteria: [],
  createdAt: 0,
  updatedAt: 0,
  version: 1,
});

describe('findOverlaps', () => {
  it('finds two people changing the same file, ignoring case', () => {
    const overlaps = findOverlaps({
      workspaces: [
        { participantId: 'm', name: 'Martin', workspace: ws('jump', ['scripts/Player.gd', 'a.gd']) },
        { participantId: 'f', name: 'Friend', workspace: ws('dash', ['scripts/player.gd', 'b.gd']) },
      ],
      github: github([]),
      locks: [],
    });
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]!.sources.map((s) => s.kind)).toEqual(['workspace', 'workspace']);
  });

  it('treats a workspace, its pull request and its owner’s locks as one piece of work', () => {
    const overlaps = findOverlaps({
      workspaces: [{ participantId: 'm', name: 'Martin', workspace: ws('jump', ['scripts/jump.gd', 'art/hero.png']) }],
      github: github([pull(3, 'jump', ['scripts/jump.gd'])]),
      locks: [lock('art/hero.png', 'm')],
    });
    expect(overlaps).toEqual([]);
  });

  it('does not tie two people together because both work on the default branch', () => {
    const overlaps = findOverlaps({
      workspaces: [
        { participantId: 'm', name: 'Martin', workspace: ws('main', ['readme.md']) },
        { participantId: 'f', name: 'Friend', workspace: ws('main', ['readme.md']) },
      ],
      github: github([]),
      locks: [],
    });
    expect(overlaps).toHaveLength(1);
  });

  it('includes open pull requests, pushed branches without one, and locks', () => {
    const overlaps = findOverlaps({
      workspaces: [{ participantId: 'm', name: 'Martin', workspace: ws('jump', ['a.gd', 'b.gd', 'c.png']) }],
      github: github(
        [pull(3, 'dash', ['a.gd']), pull(2, 'old', ['b.gd'], 'merged')],
        [{ name: 'wip', sha: 'x', ahead: 1, behind: 0, files: ['b.gd'] }],
      ),
      locks: [lock('c.png', 'f')],
    });
    expect(overlaps.map((o) => [o.path, o.sources.map((s) => s.kind)])).toEqual([
      ['a.gd', ['workspace', 'pull']],
      ['b.gd', ['workspace', 'branch']],
      ['c.png', ['workspace', 'lock']],
    ]);
  });

  it('lists only the other side for a task', () => {
    const overlaps = findOverlaps({
      workspaces: [
        { participantId: 'm', name: 'Martin', workspace: ws('jump', ['a.gd']) },
        { participantId: 'f', name: 'Friend', workspace: ws('dash', ['a.gd']) },
      ],
      github: github([]),
      locks: [],
    });
    const forJump = overlapsForTask(overlaps, task('t1', 'jump'));
    expect(forJump).toHaveLength(1);
    expect(forJump[0]!.sources).toEqual([{ kind: 'workspace', participantId: 'f', name: 'Friend', branch: 'dash' }]);
    expect(overlapsForTask(overlaps, task('t2', 'other'))).toEqual([]);
  });
});

describe('scope and pull request helpers', () => {
  it('lists files outside a task scope', () => {
    expect(filesOutsideScope(['scripts/player/jump.gd', 'scenes/main.tscn'], ['scripts/player/**'])).toEqual(['scenes/main.tscn']);
    expect(filesOutsideScope(['anything'], [])).toEqual([]);
  });

  it('prefers the open pull request for a branch', () => {
    const status = github([pull(2, 'jump', [], 'merged'), pull(5, 'jump', []), pull(4, 'dash', [], 'closed')]);
    expect(pullForBranch(status, 'jump')?.number).toBe(5);
    expect(pullForBranch(status, 'dash')?.number).toBe(4);
    expect(pullForBranch(status, null)).toBeNull();
  });

  it('reads repositories from names and URLs', () => {
    expect(parseRepoRef('lossa551/ProjectCollaborationTool')).toEqual({ owner: 'lossa551', name: 'ProjectCollaborationTool' });
    expect(parseRepoRef('https://github.com/lossa551/ProjectCollaborationTool.git')).toEqual({ owner: 'lossa551', name: 'ProjectCollaborationTool' });
    expect(parseRepoRef('git@github.com:lossa551/ProjectCollaborationTool.git')).toEqual({ owner: 'lossa551', name: 'ProjectCollaborationTool' });
    expect(parseRepoRef('https://github.com/lossa551/ProjectCollaborationTool/')).toEqual({ owner: 'lossa551', name: 'ProjectCollaborationTool' });
    expect(parseRepoRef('not a repo')).toBeNull();
  });
});

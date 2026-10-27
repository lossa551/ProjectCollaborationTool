import { describe, expect, it } from 'vitest';
import {
  EMPTY_GITHUB_STATUS,
  approvalActivity,
  filterBoard,
  lockWaitActivity,
  locksAfterCommit,
  taskBlockers,
  taskUnverified,
  type ChatInfo,
  type ChatMessage,
  type Criterion,
  type Lock,
  type Participant,
  type PlanItem,
  type PullRequest,
  type Task,
} from '../src/index.js';

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: id,
  stage: 'implementing',
  owner: null,
  scope: [],
  readFirst: [],
  branch: null,
  featureId: null,
  criteria: [],
  budget: null,
  createdAt: 0,
  updatedAt: 0,
  version: 1,
  ...extra,
});

const criterion = (state: Criterion['state'], text = 'It works'): Criterion => ({ id: `${state}-${text}`, text, state, evidence: '', by: null, at: null });

const chat = (id: string, extra: Partial<ChatInfo> = {}): ChatInfo => ({
  id,
  title: `Chat ${id}`,
  agentId: 'builder',
  taskId: null,
  createdBy: { id: 'me', name: 'Martin', kind: 'human' },
  handoff: null,
  branchedFrom: null,
  worktree: null,
  state: 'idle',
  activity: null,
  context: null,
  budget: null,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

const lock = (path: string, holderId: string, extra: Partial<Lock> = {}): Lock => ({
  id: `lock-${holderId}-${path}`,
  path,
  kind: 'soft',
  holder: {
    id: holderId,
    name: holderId === 'me' ? 'Martin' : holderId === 'agent-1' ? 'Builder' : 'Lina',
    kind: holderId.startsWith('agent') ? 'agent' : 'human',
  },
  taskId: null,
  chatId: null,
  reason: null,
  acquiredAt: 0,
  heartbeatAt: 0,
  abandoned: false,
  ...extra,
});

const pull = (branch: string, extra: Partial<PullRequest> = {}): PullRequest => ({
  number: 1,
  title: 'PR',
  url: 'https://github.com/o/r/pull/1',
  state: 'open',
  draft: false,
  author: 'x',
  branch,
  base: 'main',
  mergeable: 'mergeable',
  review: 'none',
  checks: 'success',
  checkRuns: [],
  files: [],
  updatedAt: 0,
  ...extra,
});

const input = (extra: Partial<Parameters<typeof filterBoard>[0]> = {}) => ({
  tasks: [] as Task[],
  chats: [] as ChatInfo[],
  messages: {} as Record<string, ChatMessage[]>,
  github: EMPTY_GITHUB_STATUS,
  locks: [] as Lock[],
  planning: [] as PlanItem[],
  ...extra,
});

const ids = (tasks: Task[]) => tasks.map((t) => t.id);

describe('board search', () => {
  const tasks = [
    task('jump', { title: 'Double jump', branch: 'feat/jump', owner: { id: 'me', name: 'Martin', kind: 'human' } }),
    task('menu', { title: 'Pause menu', criteria: [criterion('untested', 'Esc opens the menu')] }),
    task('save', { title: 'Save games', featureId: 'f1' }),
  ];
  const planning = [{ id: 'f1', kind: 'feature', title: 'Persistence', body: 'Slots on disk' } as PlanItem];

  it('narrows by every word, case-insensitively, over title, branch, owner, criteria and feature', () => {
    const all = input({ tasks, planning });
    expect(ids(filterBoard(all, 'me', 'JUMP', []))).toEqual(['jump']);
    expect(ids(filterBoard(all, 'me', 'martin double', []))).toEqual(['jump']);
    expect(ids(filterBoard(all, 'me', 'esc', []))).toEqual(['menu']);
    expect(ids(filterBoard(all, 'me', 'slots', []))).toEqual(['save']);
    expect(ids(filterBoard(all, 'me', 'double menu', []))).toEqual([]);
    expect(ids(filterBoard(all, 'me', '   ', []))).toEqual(['jump', 'menu', 'save']);
  });

  it('combines filters with each other and with search', () => {
    const all = input({ tasks, planning });
    expect(ids(filterBoard(all, 'me', '', ['mine']))).toEqual(['jump']);
    expect(ids(filterBoard(all, 'me', '', ['unverified']))).toEqual(['menu']);
    expect(ids(filterBoard(all, 'me', '', ['mine', 'unverified']))).toEqual([]);
    expect(ids(filterBoard(all, 'me', 'pause', ['unverified']))).toEqual(['menu']);
    expect(ids(filterBoard(all, 'me', 'save', ['unverified']))).toEqual([]);
  });
});

describe('board filters', () => {
  it('Mine: tasks you own, or an agent you started is working on', () => {
    const tasks = [task('a'), task('b'), task('c', { owner: { id: 'lina', name: 'Lina', kind: 'human' } })];
    const chats = [chat('x', { taskId: 'b', state: 'working' }), chat('y', { taskId: 'c', state: 'idle' })];
    expect(ids(filterBoard(input({ tasks, chats }), 'me', '', ['mine']))).toEqual(['b']);
    expect(ids(filterBoard(input({ tasks, chats }), null, '', ['mine']))).toEqual([]);
  });

  it('Agents: agent owner, busy chat, unmerged copy, or agent locks', () => {
    const tasks = [task('owned', { owner: { id: 'agent-1', name: 'Builder', kind: 'agent' } }), task('busy'), task('copy'), task('locked'), task('idle')];
    const worktree = {
      branch: 'agent/x',
      base: 'main',
      baseCommit: 'abcd',
      folder: '/w',
      owner: { id: 'me', name: 'Martin' },
      truncated: false,
      commits: 1,
      uncommitted: 0,
      head: null,
      updatedAt: 0,
    };
    const chats = [
      chat('1', { taskId: 'busy', state: 'working' }),
      chat('2', { taskId: 'copy', worktree: { ...worktree, files: [{ path: 'a.ts', change: 'modified' }] } }),
      chat('3', { taskId: 'idle', worktree: { ...worktree, files: [] } }),
    ];
    const locks = [lock('b.ts', 'agent-1', { taskId: 'locked' }), lock('c.ts', 'me', { taskId: 'idle' })];
    expect(ids(filterBoard(input({ tasks, chats, locks }), 'me', '', ['agents']))).toEqual(['owned', 'busy', 'copy', 'locked']);
  });

  it('Blocked: failing criterion, pull request trouble, approval or lock wait', () => {
    const tasks = [
      task('failing', { criteria: [criterion('failing')] }),
      task('checks', { branch: 'feat/checks' }),
      task('approval'),
      task('pending'),
      task('lockwait'),
      task('fine', { branch: 'feat/fine', criteria: [criterion('verified')] }),
    ];
    const github = { ...EMPTY_GITHUB_STATUS, pulls: [pull('feat/checks', { checks: 'failure' }), pull('feat/fine')] };
    const chats = [
      chat('a', { taskId: 'approval', state: 'waiting', activity: approvalActivity('Edit menu.gd') }),
      chat('p', { taskId: 'pending' }),
      chat('l', { taskId: 'lockwait', state: 'waiting', activity: lockWaitActivity('Lina', 'art/hero.psd') }),
    ];
    const messages = { p: [{ id: 'm', approval: { action: 'Run npm test', reason: '', state: 'pending', decidedBy: null } } as unknown as ChatMessage] };
    const all = input({ tasks, github, chats, messages });
    expect(ids(filterBoard(all, 'me', '', ['blocked']))).toEqual(['failing', 'checks', 'approval', 'pending', 'lockwait']);
    expect(taskBlockers(all, tasks[1]!)).toEqual(['checks failing']);
    expect(taskBlockers(all, tasks[3]!)).toEqual(['waiting on approval']);
    expect(taskBlockers(all, tasks[4]!)).toEqual(['waiting on a lock']);
  });

  it('Unverified: untested criteria, or testing/done with nothing to check', () => {
    expect(taskUnverified(task('a', { criteria: [criterion('verified'), criterion('untested', 'b')] }))).toBe(true);
    expect(taskUnverified(task('b', { criteria: [criterion('verified')] }))).toBe(false);
    expect(taskUnverified(task('c', { criteria: [criterion('failing')] }))).toBe(false);
    expect(taskUnverified(task('d', { stage: 'implementing' }))).toBe(false);
    expect(taskUnverified(task('e', { stage: 'done' }))).toBe(true);
  });
});

describe('locks after a commit', () => {
  const builder: Participant = {
    id: 'agent-1',
    name: 'Builder',
    kind: 'agent',
    status: 'active',
    focus: null,
    connectedAt: 0,
    agent: { profileId: 'builder', startedBy: 'Martin', startedById: 'me' },
  };

  it('offers your locks on files with nothing left to commit, including folders', () => {
    const locks = [lock('src/a.ts', 'me'), lock('src/b.ts', 'me'), lock('art', 'me'), lock('src/c.ts', 'lina')];
    const result = locksAfterCommit({ locks, chats: [], participants: [] }, 'me', ['src/a.ts'], ['src/B.ts', 'art/hero.psd']);
    expect(result.yours.map((l) => l.path)).toEqual(['src/a.ts']);
    expect(result.agents).toEqual([]);
  });

  it('frees committed files locked by an idle agent on your PC working in your folder', () => {
    const chats = [chat('c1'), chat('c2', { state: 'working' }), chat('c3', { worktree: { files: [] } as unknown as ChatInfo['worktree'] })];
    const locks = [
      lock('src/a.ts', 'agent-1', { chatId: 'c1' }),
      lock('src/notcommitted.ts', 'agent-1', { chatId: 'c1' }),
      lock('src/b.ts', 'agent-1', { chatId: 'c2' }),
      lock('src/c.ts', 'agent-1', { chatId: 'c3' }),
      lock('src/d.ts', 'agent-1', { chatId: 'c1' }),
    ];
    const result = locksAfterCommit({ locks, chats, participants: [builder] }, 'me', ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], ['src/d.ts']);
    expect(result.agents.map((l) => l.path)).toEqual(['src/a.ts']);
  });

  it('leaves agents started on someone else’s PC alone', () => {
    const other = { ...builder, agent: { profileId: 'builder', startedBy: 'Lina', startedById: 'lina' } };
    const locks = [lock('src/a.ts', 'agent-1', { chatId: 'c1' })];
    expect(locksAfterCommit({ locks, chats: [chat('c1')], participants: [other] }, 'me', ['src/a.ts'], []).agents).toEqual([]);
    expect(locksAfterCommit({ locks, chats: [chat('c1')], participants: [builder] }, null, ['src/a.ts'], []).agents).toEqual([]);
  });
});

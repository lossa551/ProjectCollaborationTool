import { describe, expect, it } from 'vitest';
import {
  EMPTY_GITHUB_STATUS,
  featureCounts,
  findOverlaps,
  groupActivity,
  lockWaitActivity,
  needsYou,
  parseLockWait,
  sinceLastHere,
  whoIsDoing,
  approvalActivity,
  type Activity,
  type ChatInfo,
  type ChatMessage,
  type Lock,
  type Participant,
  type PlanItem,
  type PullRequest,
  type SessionState,
  type Task,
  type Workspace,
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

const lock = (path: string, holderId: string, extra: Partial<Lock> = {}): Lock => ({
  id: `lock-${path}`,
  path,
  kind: 'exclusive',
  holder: { id: holderId, name: holderId === 'me' ? 'Martin' : 'Lina', kind: 'human' },
  taskId: null,
  chatId: null,
  reason: null,
  acquiredAt: 0,
  heartbeatAt: 0,
  abandoned: false,
  ...extra,
});

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

const pull = (number: number, branch: string, extra: Partial<PullRequest> = {}): PullRequest => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
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

const ws = (branch: string, paths: string[]): Workspace => ({
  branch,
  base: 'origin/main',
  files: paths.map((path) => ({ path, change: 'modified' })),
  truncated: false,
  updatedAt: 0,
});

const plan = (id: string, extra: Partial<PlanItem> = {}): PlanItem => ({
  id,
  kind: 'feature',
  title: id,
  body: '',
  requirements: '',
  dependencies: '',
  criteria: '',
  tasks: '',
  createdBy: 'Lina',
  createdAt: 0,
  updatedAt: 0,
  approvedAt: null,
  approvedBy: null,
  milestoneId: null,
  rank: null,
  assign: {},
  ...extra,
});

const base = (extra: Partial<SessionState> = {}) => ({
  participants: [] as Participant[],
  tasks: [] as Task[],
  locks: [] as Lock[],
  github: { ...EMPTY_GITHUB_STATUS, defaultBranch: 'main' },
  workspaces: {} as Record<string, Workspace>,
  agents: [
    {
      id: 'builder',
      name: 'Builder',
      connection: { type: 'cli' as const, tool: 'claude-code' as const, model: null },
      responsibilities: '',
      allowedPaths: [],
      approvals: { editInScope: 'allow' as const, editOutsideScope: 'ask' as const, commands: 'ask' as const },
      createdAt: 0,
      updatedAt: 0,
    },
  ],
  chats: [] as ChatInfo[],
  messages: {} as Record<string, ChatMessage[]>,
  planning: [] as PlanItem[],
  issueMarks: {},
  memory: [],
  activity: [] as Activity[],
  ...extra,
});

describe('lock wait activity', () => {
  it('reads back the path the runner writes', () => {
    expect(parseLockWait(lockWaitActivity('Martin and Lina', 'art/jump sheet.psd'))).toBe('art/jump sheet.psd');
    expect(parseLockWait('Editing a.gd')).toBeNull();
    expect(parseLockWait(null)).toBeNull();
  });
});

describe('needsYou', () => {
  it('lists an approval from the chat state when its messages are not loaded', () => {
    const input = base({ chats: [chat('c1', { state: 'waiting', activity: approvalActivity('Run godot --headless') })] });
    const items = needsYou(input, 'me', []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'approval', text: 'Builder asks to run godot --headless', target: { screen: 'chat', chatId: 'c1' } });
  });

  it('lists each pending approval card once the messages are loaded', () => {
    const message = (id: string, state: 'pending' | 'approved'): ChatMessage => ({
      id,
      chatId: 'c1',
      author: { id: 'a', name: 'Builder', kind: 'agent' },
      kind: 'approval',
      text: '',
      streaming: false,
      tool: null,
      approval: { action: 'Edit menu.gd', reason: '', state, decidedBy: null },
      checkpoint: null,
      at: 0,
      updatedAt: 0,
    });
    const input = base({
      chats: [chat('c1', { state: 'waiting', activity: approvalActivity('Edit menu.gd') })],
      messages: { c1: [message('m1', 'approved'), message('m2', 'pending')] },
    });
    expect(needsYou(input, 'me', []).map((i) => i.id)).toEqual(['approval:m2']);
  });

  it('asks you to release a lock an agent waits on, but not someone else’s', () => {
    const input = base({
      chats: [chat('c1', { state: 'waiting', activity: lockWaitActivity('Martin', 'art/Jump.psd') })],
      locks: [lock('art/jump.psd', 'me')],
    });
    const [item] = needsYou(input, 'me', []);
    expect(item).toMatchObject({ kind: 'lock-wait', act: { type: 'release-lock', lockId: 'lock-art/jump.psd' } });
    expect(needsYou(input, 'lina', [])).toEqual([]);
  });

  it('flags only your own pull requests in trouble', () => {
    const input = base({
      tasks: [task('jump', { owner: { id: 'me', name: 'Martin', kind: 'human' }, branch: 'task/jump' })],
      workspaces: { me: ws('main', []) },
      github: {
        ...EMPTY_GITHUB_STATUS,
        defaultBranch: 'main',
        pulls: [
          pull(3, 'task/jump', { checks: 'failure' }),
          pull(4, 'task/menu', { mergeable: 'conflicting' }),
          pull(5, 'main', { checks: 'failure' }),
        ],
      },
    });
    expect(needsYou(input, 'me', []).map((i) => i.text)).toEqual(['PR #3 PR 3: checks failing']);
  });

  it('flags files in your workspace outside your task', () => {
    const input = base({
      tasks: [task('Jumping', { branch: 'task/jump', scope: ['scripts/player/**'] })],
      workspaces: { me: ws('task/jump', ['scripts/player/jump.gd', 'ui/menu.gd']) },
    });
    const [item] = needsYou(input, 'me', []);
    expect(item).toMatchObject({ kind: 'outside-scope', text: 'Your workspace has 1 file outside "Jumping"', detail: 'ui/menu.gd' });
  });

  it('flags overlaps you are part of, abandoned locks of others, and plans waiting for approval', () => {
    const input = base({
      workspaces: { me: ws('task/a', ['a.gd']), lina: ws('task/b', ['a.gd']) },
      locks: [lock('b.png', 'lina', { abandoned: true }), lock('c.png', 'me', { abandoned: true })],
      planning: [plan('Inventory', { tasks: 'Bag UI\nPickup' }), plan('Empty'), plan('Done', { tasks: 'x', approvedAt: 1 })],
    });
    const overlaps = findOverlaps({
      workspaces: Object.entries(input.workspaces).map(([participantId, workspace]) => ({ participantId, name: participantId, workspace })),
      github: input.github,
      locks: [],
    });
    expect(needsYou(input, 'me', overlaps).map((i) => i.kind)).toEqual(['overlap', 'abandoned-lock', 'plan']);
  });
});

describe('featureCounts', () => {
  it('counts features by state', () => {
    const planning = [plan('a'), plan('b'), plan('idea', { kind: 'idea' })];
    const tasks = [
      task('t', {
        featureId: 'b',
        stage: 'testing',
        criteria: [{ id: 'c', text: 'x', state: 'failing', evidence: '', by: null, at: null }],
      }),
    ];
    expect(featureCounts({ planning, tasks })).toEqual({ blocked: 1, unverified: 0, ready: 0, 'in-progress': 0, planning: 1 });
  });
});

describe('whoIsDoing', () => {
  it('gives people their checkout and task, agents their busy chat', () => {
    const participants: Participant[] = [
      { id: 'me', name: 'Martin', kind: 'human', status: 'active', focus: null, connectedAt: 0, agent: null },
      { id: 'b', name: 'Builder', kind: 'agent', status: 'active', focus: null, connectedAt: 0, agent: { profileId: 'builder', startedBy: 'me' } },
    ];
    const rows = whoIsDoing({
      participants,
      tasks: [task('Jumping', { branch: 'task/jump' }), task('Menu')],
      locks: [lock('a.png', 'b')],
      workspaces: { me: ws('task/jump', ['a', 'b']) },
      chats: [chat('c1', { taskId: 'Menu', state: 'working', activity: 'Editing menu.gd' })],
    });
    expect(rows[0]).toMatchObject({ task: { id: 'Jumping' }, branch: 'task/jump', files: 2 });
    expect(rows[1]).toMatchObject({ task: { id: 'Menu' }, activity: 'Editing menu.gd', chatId: 'c1', locks: [{ path: 'a.png' }] });
  });
});

describe('sinceLastHere', () => {
  const act = (at: number, actorName: string, text: string): Activity => ({ id: `${at}`, at, actorName, text, taskId: null });

  it('groups what changed after the given time and leaves out your own changes', () => {
    const groups = sinceLastHere(
      base({
        tasks: [task('Jumping', { criteria: [{ id: 'c', text: 'Double jump works', state: 'failing', evidence: '', by: 'Lina', at: 20 }] })],
        activity: [
          act(5, 'Lina', 'moved "Old" to Done'),
          act(15, 'Lina', 'moved "Jumping" to Review'),
          act(16, 'Lina', 'moved "Jumping" to Testing'),
          act(17, 'Martin', 'moved "Menu" to Done'),
        ],
        github: { ...EMPTY_GITHUB_STATUS, pulls: [pull(3, 'x', { state: 'merged', updatedAt: 30 }), pull(2, 'y', { state: 'merged', updatedAt: 1 })] },
        chats: [chat('c1', { updatedAt: 40 })],
        planning: [plan('Inventory', { createdAt: 12 })],
      }),
      10,
      'Martin',
    );
    expect(groups.map((g) => g.key)).toEqual(['stages', 'pulls', 'criteria', 'agents', 'plans', 'people']);
    expect(groups[0]!.lines.map((l) => l.text)).toEqual(['Testing: "Jumping"']);
    expect(groups[1]!.lines.map((l) => l.text)).toEqual(['#3 PR 3: merged']);
    expect(groups[2]!.lines[0]!.text).toBe('Failing: Double jump works ("Jumping", Lina)');
    expect(groups[5]!.lines.map((l) => l.text)).toEqual(['Lina: 2 changes']);
  });

  it('leaves out new issues that Home lists to triage', () => {
    const issue = (number: number) => ({
      number,
      title: `Issue ${number}`,
      url: `https://github.com/martin/game/issues/${number}`,
      author: 'lina',
      labels: [],
      assignees: [],
      body: '',
      comments: 0,
      createdAt: 20,
      updatedAt: 20,
    });
    const state = base({ github: { ...EMPTY_GITHUB_STATUS, issues: [issue(7), issue(8)] } });
    expect(sinceLastHere(state, 10, 'Martin').find((g) => g.key === 'issues')!.lines).toHaveLength(2);
    const lines = sinceLastHere(state, 10, 'Martin', { leaveOutIssues: new Set([7]) }).find((g) => g.key === 'issues')!.lines;
    expect(lines.map((l) => l.text)).toEqual(['#8 Issue 8 (lina)']);
    expect(sinceLastHere(state, 10, 'Martin', { leaveOutIssues: new Set([7, 8]) }).some((g) => g.key === 'issues')).toBe(false);
  });
});

describe('groupActivity', () => {
  it('folds runs of lock events by one person into one line', () => {
    const entry = (id: string, at: number, actorName: string, text: string): Activity => ({ id, at, actorName, text, taskId: 't' });
    const grouped = groupActivity([
      entry('1', 0, 'Builder', 'locked scripts/player/jump.gd'),
      entry('2', 1000, 'Builder', 'locked scripts/player/run.gd'),
      entry('3', 2000, 'Builder', 'locked scripts/player/anim/idle.gd (exclusive)'),
      entry('4', 3000, 'Lina', 'locked ui/menu.gd'),
      entry('5', 4000, 'Lina', 'moved "Menu" to Review'),
    ]);
    expect(grouped.map((g) => [g.actorName, g.text, g.count])).toEqual([
      ['Builder', 'locked 3 files in scripts/player', 3],
      ['Lina', 'locked ui/menu.gd', 1],
      ['Lina', 'moved "Menu" to Review', 1],
    ]);
    expect(grouped[0]!.id).toBe('3');
  });
});

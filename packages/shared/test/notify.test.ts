import { describe, expect, it } from 'vitest';
import {
  AGENT_ERROR_PREFIX,
  EMPTY_GITHUB_STATUS,
  NoticeTracker,
  approvalActivity,
  lockWaitActivity,
  standingNotices,
  type ChatInfo,
  type ChatMessage,
  type Lock,
  type NoticeInput,
  type PullRequest,
  type Task,
} from '../src/index.js';

const me = { id: 'me', name: 'Martin', kind: 'human' as const };
const lina = { id: 'lina', name: 'Lina', kind: 'human' as const };

const chat = (id: string, extra: Partial<ChatInfo> = {}): ChatInfo => ({
  id,
  title: `Chat ${id}`,
  agentId: 'builder',
  taskId: null,
  createdBy: me,
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

const message = (id: string, chatId: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  chatId,
  author: { id: 'agent', name: 'Builder', kind: 'agent' },
  kind: 'text',
  text: '',
  streaming: false,
  tool: null,
  approval: null,
  checkpoint: null,
  at: 0,
  updatedAt: 0,
  ...extra,
});

const lock = (path: string, holder = me): Lock => ({
  id: `lock-${path}`,
  path,
  kind: 'exclusive',
  holder,
  taskId: null,
  chatId: null,
  reason: null,
  acquiredAt: 0,
  heartbeatAt: 0,
  abandoned: false,
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
  duplicateCheck: null,
  createdAt: 0,
  updatedAt: 0,
  version: 1,
  ...extra,
});

const state = (extra: Partial<NoticeInput> = {}): NoticeInput => ({
  status: 'connected',
  you: { ...me, status: 'active', focus: null, connectedAt: 0, agent: null },
  session: { id: 's1', name: 'Game', createdAt: 0 },
  participants: [],
  tasks: [],
  locks: [],
  github: { ...EMPTY_GITHUB_STATUS, defaultBranch: 'main' },
  workspaces: {},
  agents: [
    {
      id: 'builder',
      name: 'Builder',
      connection: { type: 'cli', tool: 'claude-code', model: null },
      responsibilities: '',
      allowedPaths: [],
      approvals: { editInScope: 'allow', editOutsideScope: 'ask', commands: 'ask' },
      createdAt: 0,
      updatedAt: 0,
    },
  ],
  chats: [],
  messages: {},
  planning: [],
  issueMarks: {},
  ...extra,
});

/** A tracker that has seen `first` as the session's baseline. */
function tracking(first: NoticeInput) {
  const tracker = new NoticeTracker();
  expect(tracker.update(first, { joiner: true })).toEqual([]);
  return tracker;
}

describe('standingNotices', () => {
  it('tells about approvals only in chats you started or opened', () => {
    const waiting = { state: 'waiting' as const, activity: approvalActivity('Run godot --headless') };
    const input = state({
      chats: [chat('mine', waiting), chat('theirs', { ...waiting, createdBy: lina }), chat('opened', { ...waiting, createdBy: lina })],
      messages: {
        opened: [message('m1', 'opened', { kind: 'approval', approval: { action: 'Edit a.gd', reason: '', state: 'pending', decidedBy: null } })],
      },
    });
    const notices = standingNotices(input);
    expect(notices.map((n) => [n.kind, n.target])).toEqual([
      ['approval', { screen: 'chat', chatId: 'mine' }],
      ['approval', { screen: 'chat', chatId: 'opened' }],
    ]);
    expect(notices[1]!.body).toBe('Builder asks to edit a.gd (Chat opened)');
  });

  it('tells you when anyone waits for your lock, and when your agent waits for someone else', () => {
    const input = state({
      locks: [lock('art/hero.psd'), lock('scenes/main.tscn', lina)],
      chats: [
        chat('a', { createdBy: lina, state: 'waiting', activity: lockWaitActivity('Martin', 'art/hero.psd') }),
        chat('b', { state: 'waiting', activity: lockWaitActivity('Lina', 'scenes/main.tscn') }),
      ],
    });
    expect(standingNotices(input).map((n) => [n.kind, n.title])).toEqual([
      ['lock-wait', 'Waiting for your lock'],
      ['agent', 'Builder is stuck'],
    ]);
  });

  it('tells about failing checks and conflicts on your pull requests only', () => {
    const input = state({
      tasks: [task('t', { owner: me, branch: 'feat/jump' })],
      github: {
        ...EMPTY_GITHUB_STATUS,
        defaultBranch: 'main',
        pulls: [
          pull(1, 'feat/jump', { checks: 'failure', mergeable: 'conflicting', review: 'changes_requested' }),
          pull(2, 'feat/other', { checks: 'failure' }),
        ],
      },
    });
    expect(standingNotices(input).map((n) => n.key)).toEqual(['pull:1:checks failing', 'pull:1:conflicts']);
  });
});

describe('NoticeTracker', () => {
  it('starts quiet and then shows each new thing once', () => {
    const waiting = { state: 'waiting' as const, activity: approvalActivity('Run tests') };
    const tracker = tracking(state({ chats: [chat('old', waiting)] }));
    const next = state({ chats: [chat('old', waiting), chat('new', waiting)] });
    expect(tracker.update(next, { joiner: true }).map((n) => n.key)).toEqual(['approval:new']);
    expect(tracker.update(next, { joiner: true })).toEqual([]);
  });

  it('shows the same thing again after it went away and came back', () => {
    const waiting = chat('c', { state: 'waiting', activity: approvalActivity('Run tests') });
    const tracker = tracking(state({ chats: [waiting] }));
    expect(tracker.update(state({ chats: [{ ...waiting, state: 'working', activity: null }] }), { joiner: true })).toEqual([]);
    expect(tracker.update(state({ chats: [waiting] }), { joiner: true })).toHaveLength(1);
  });

  it('tells when an agent in your chat finishes a turn, or fails', () => {
    const tracker = tracking(state({ chats: [chat('c', { state: 'working' }), chat('d', { state: 'working', createdBy: lina })] }));
    const done = tracker.update(state({ chats: [chat('c', { updatedAt: 5 }), chat('d', { createdBy: lina })] }), { joiner: true });
    expect(done).toEqual([{ key: 'turn:c:5', kind: 'agent', title: 'Builder finished', body: 'Chat c', target: { screen: 'chat', chatId: 'c' } }]);

    tracker.update(state({ chats: [chat('c', { state: 'working' })] }), { joiner: true });
    const failed = tracker.update(
      state({
        chats: [chat('c', { updatedAt: 9 })],
        messages: { c: [message('n', 'c', { kind: 'notice', text: `${AGENT_ERROR_PREFIX}API key missing` })] },
      }),
      { joiner: true },
    );
    expect(failed).toMatchObject([{ kind: 'agent', title: 'Builder is stuck', body: 'API key missing (Chat c)' }]);
  });

  it('tells a joiner when the host goes offline and comes back, but not the host', () => {
    for (const joiner of [true, false]) {
      const tracker = tracking(state());
      const off = tracker.update(state({ status: 'reconnecting' }), { joiner });
      expect(tracker.update(state({ status: 'reconnecting' }), { joiner })).toEqual([]);
      const back = tracker.update(state(), { joiner });
      expect([...off, ...back].map((n) => n.key)).toEqual(joiner ? ['host-offline', 'host-back'] : []);
    }
  });

  it('starts over for a new session', () => {
    const waiting = { state: 'waiting' as const, activity: approvalActivity('Run tests') };
    const tracker = tracking(state());
    expect(tracker.update(state({ session: { id: 's2', name: 'Other', createdAt: 0 }, chats: [chat('c', waiting)] }), { joiner: true })).toEqual([]);
  });
});

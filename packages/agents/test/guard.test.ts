import { describe, expect, it } from 'vitest';
import { DEFAULT_APPROVALS, DEFAULT_LOCK_RULES, type AgentProfile, type Lock, type Task } from '@pct/shared';
import { checkCommand, checkEdit, type GuardContext } from '@pct/agents';

const agent: AgentProfile = {
  id: 'a1',
  name: 'Builder',
  connection: { type: 'api', provider: 'deepseek', model: 'deepseek-chat', baseUrl: null },
  responsibilities: '',
  allowedPaths: ['scripts/**'],
  approvals: DEFAULT_APPROVALS,
  createdAt: 0,
  updatedAt: 0,
};
const task: Task = {
  id: 't1',
  title: 'Player movement',
  stage: 'implementing',
  owner: null,
  scope: ['scripts/player/**'],
  readFirst: [],
  branch: null,
  featureId: null,
  criteria: [],
  budget: null,
  duplicateCheck: null,
  createdAt: 0,
  updatedAt: 0,
  version: 1,
};
const lock = (path: string, kind: Lock['kind'], holder = 'friend'): Lock => ({
  id: path,
  path,
  kind,
  holder: { id: holder, name: holder === 'friend' ? 'Friend' : 'Builder', kind: 'human' },
  taskId: null,
  chatId: null,
  reason: null,
  acquiredAt: 0,
  heartbeatAt: 0,
  abandoned: false,
});
const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  agent,
  selfId: 'me',
  task,
  handoffScope: [],
  locks: [],
  lockRules: DEFAULT_LOCK_RULES,
  ...over,
});

describe('guard', () => {
  it('allows edits inside both the agent’s and the task’s paths', () => {
    expect(checkEdit(ctx(), 'scripts/player/move.gd')).toMatchObject({ verdict: 'allow', path: 'scripts/player/move.gd', lockKind: 'soft' });
  });

  it('asks for edits outside the task, naming which paths it is outside', () => {
    const decision = checkEdit(ctx(), 'scripts/ui/menu.gd');
    expect(decision.verdict).toBe('ask');
    expect(decision.reasons.join()).toContain('the paths of "Player movement"');
  });

  it('follows the approval rules set for the agent', () => {
    const strict = { ...agent, approvals: { editInScope: 'ask', editOutsideScope: 'deny', commands: 'deny' } as const };
    expect(checkEdit(ctx({ agent: strict }), 'scripts/player/move.gd').verdict).toBe('ask');
    expect(checkEdit(ctx({ agent: strict }), 'docs/a.md').verdict).toBe('deny');
    expect(checkCommand({ agent: strict }, 'npm test').verdict).toBe('deny');
    expect(checkCommand({ agent }, 'npm test').verdict).toBe('ask');
  });

  it('uses the handoff’s paths when there is no task', () => {
    expect(checkEdit(ctx({ task: null, handoffScope: ['scripts/ai/**'] }), 'scripts/ai/brain.gd').verdict).toBe('allow');
    expect(checkEdit(ctx({ task: null, handoffScope: ['scripts/ai/**'] }), 'scripts/player/x.gd').verdict).toBe('ask');
  });

  it('never edits files others locked exclusively, and asks about soft locks', () => {
    expect(checkEdit(ctx({ locks: [lock('scripts/player/hero.png', 'soft')] }), 'scripts/player/hero.png').verdict).toBe('deny');
    expect(checkEdit(ctx({ locks: [lock('scripts/player/move.gd', 'exclusive')] }), 'scripts/player/move.gd').verdict).toBe('deny');
    const soft = checkEdit(ctx({ locks: [lock('scripts/player/move.gd', 'soft')] }), 'scripts/player/move.gd');
    expect(soft.verdict).toBe('ask');
    expect(soft.reasons.join()).toContain('Friend is also editing');
    // Its own locks do not count.
    expect(checkEdit(ctx({ locks: [lock('scripts/player/move.gd', 'exclusive', 'me')] }), 'scripts/player/move.gd').verdict).toBe('allow');
  });

  it('refuses paths outside the project and inside .git', () => {
    expect(checkEdit(ctx(), '../secrets.txt')).toMatchObject({ verdict: 'deny', path: null });
    expect(checkEdit(ctx({ agent: { ...agent, allowedPaths: [] }, task: null }), '.git/config').verdict).toBe('deny');
  });
});

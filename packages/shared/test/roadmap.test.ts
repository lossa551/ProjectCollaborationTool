import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MILESTONES,
  EMPTY_GITHUB_STATUS,
  PlanItem,
  PlanOp,
  Y,
  applyPlanOp,
  currentMilestone,
  daysUntil,
  milestoneRisk,
  moveFeature,
  readMilestones,
  readPlanning,
  roadmap,
  type ChatInfo,
  type PullRequest,
  type Task,
} from '@pct/shared';

const ID = (n: number) => `feature-${n}`;

function docWith(...titles: string[]): Y.Doc {
  const doc = new Y.Doc();
  titles.forEach((title, i) => applyPlanOp(doc, { op: 'create', id: ID(i + 1), kind: 'feature', title }, 'Martin', 100 + i));
  return doc;
}

const lanesOf = (doc: Y.Doc, extra: { tasks?: Task[]; chats?: ChatInfo[]; pulls?: PullRequest[] } = {}, now = Date.now()) =>
  roadmap(
    {
      planning: readPlanning(doc),
      milestones: readMilestones(doc),
      tasks: extra.tasks ?? [],
      github: { ...EMPTY_GITHUB_STATUS, pulls: extra.pulls ?? [] },
      chats: extra.chats ?? [],
      agents: [],
    },
    now,
  );

const titles = (doc: Y.Doc) => Object.fromEntries(lanesOf(doc).map((l) => [l.milestone.title, l.features.map((f) => f.item.title)]));

const task = (id: string, featureId: string, stage: Task['stage'], extra: Partial<Task> = {}): Task => ({
  id,
  title: id,
  stage,
  owner: null,
  scope: [],
  readFirst: [],
  branch: null,
  featureId,
  criteria: [],
  budget: null,
  duplicateCheck: null,
  createdAt: 0,
  updatedAt: 0,
  version: 1,
  ...extra,
});

describe('roadmap', () => {
  it('opens an older project with Now, Next and Later and every feature in Now, in creation order', () => {
    const doc = docWith('Jump', 'Grapple', 'Inventory');
    applyPlanOp(doc, { op: 'create', id: 'idea-0001', kind: 'idea', title: 'Pets' }, 'Martin', 50);
    expect(readMilestones(doc).map((m) => m.title)).toEqual(['Now', 'Next', 'Later']);
    expect(titles(doc)).toEqual({ Now: ['Jump', 'Grapple', 'Inventory'], Next: [], Later: [] });
    // Nothing is written until someone changes a milestone.
    expect(doc.getMap('milestones').size).toBe(0);
  });

  it('reorders and moves features between milestones', () => {
    const doc = docWith('Jump', 'Grapple', 'Inventory');
    const move = (id: string, to: string, before: string | null) =>
      applyPlanOp(doc, moveFeature(readPlanning(doc), readMilestones(doc), id, to, before), 'Martin');
    move(ID(3), 'now', ID(1));
    expect(titles(doc).Now).toEqual(['Inventory', 'Jump', 'Grapple']);
    move(ID(1), 'next', null);
    expect(titles(doc)).toEqual({ Now: ['Inventory', 'Grapple'], Next: ['Jump'], Later: [] });
    // A new feature joins the end of the first milestone.
    applyPlanOp(doc, { op: 'create', id: ID(4), kind: 'feature', title: 'Save game' }, 'Martin', 999);
    expect(titles(doc).Now).toEqual(['Inventory', 'Grapple', 'Save game']);
  });

  it('syncs a reorder and a stage pick made at the same time by two people', () => {
    const a = docWith('Jump', 'Grapple');
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    applyPlanOp(a, moveFeature(readPlanning(a), readMilestones(a), ID(2), 'now', ID(1)), 'Martin');
    applyPlanOp(a, { op: 'assign', id: ID(1), stage: 'implementing', who: { kind: 'agent', id: 'builder', name: 'Builder' } }, 'Martin');
    applyPlanOp(b, { op: 'assign', id: ID(1), stage: 'review', who: { kind: 'human', id: 'p-lina', name: 'Lina' } }, 'Lina');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    for (const doc of [a, b]) {
      expect(titles(doc).Now).toEqual(['Grapple', 'Jump']);
      expect(readPlanning(doc).find((i) => i.id === ID(1))!.assign).toEqual({
        implementing: { kind: 'agent', id: 'builder', name: 'Builder' },
        review: { kind: 'human', id: 'p-lina', name: 'Lina' },
      });
    }
  });

  it('edits milestones; features of a deleted one go to the first, and the last one stays', () => {
    const doc = docWith('Jump');
    applyPlanOp(doc, moveFeature(readPlanning(doc), readMilestones(doc), ID(1), 'later', null), 'Martin');
    expect(applyPlanOp(doc, { op: 'milestone', id: 'demo-1', title: 'Demo', goal: 'Playable level', target: '2026-12-01', order: 0.5 }, 'Martin')).toBe(true);
    applyPlanOp(doc, { op: 'milestone', id: 'now', title: 'Prototype' }, 'Martin');
    expect(readMilestones(doc).map((m) => m.title)).toEqual(['Prototype', 'Demo', 'Next', 'Later']);
    expect(readMilestones(doc)[1]).toMatchObject({ goal: 'Playable level', target: '2026-12-01' });

    applyPlanOp(doc, { op: 'milestone-delete', id: 'later' }, 'Martin');
    expect(titles(doc)).toEqual({ Prototype: ['Jump'], Demo: [], Next: [] });
    for (const id of ['now', 'demo-1']) applyPlanOp(doc, { op: 'milestone-delete', id }, 'Martin');
    expect(applyPlanOp(doc, { op: 'milestone-delete', id: 'next' }, 'Martin')).toBe(false);
    expect(readMilestones(doc).map((m) => m.id)).toEqual(['next']);
    // Changing a milestone that does not exist without a title does nothing.
    expect(applyPlanOp(doc, { op: 'milestone', id: 'gone-1', goal: 'x' }, 'Martin')).toBe(false);
  });

  it('rejects bad dates and keeps an item readable when its picks are garbage', () => {
    expect(PlanOp.safeParse({ op: 'milestone', id: 'now', target: '1 Dec' }).success).toBe(false);
    const parsed = PlanItem.parse({ id: ID(1), kind: 'feature', title: 'x', createdBy: 'M', createdAt: 0, updatedAt: 0, assign: { review: 'Lina' } });
    expect(parsed.assign).toEqual({});
    expect(DEFAULT_MILESTONES.map((m) => m.id)).toEqual(['now', 'next', 'later']);
  });

  it('shows each feature’s tasks, criteria, pull requests, owners, agents and next task', () => {
    const doc = docWith('Jump', 'Grapple');
    applyPlanOp(doc, { op: 'text', id: ID(2), field: 'dependencies', value: 'Jump' }, 'Martin');
    const owner = { id: 'p-martin', name: 'Martin', kind: 'human' as const };
    const tasks = [
      task('t1', ID(1), 'done', { createdAt: 1, criteria: [{ id: 'c1', text: 'a', state: 'verified', evidence: '', by: null, at: null }] }),
      task('t2', ID(1), 'review', { createdAt: 2, owner, branch: 'jump' }),
      task('t3', ID(1), 'planning', { createdAt: 3, criteria: [{ id: 'c2', text: 'b', state: 'untested', evidence: '', by: null, at: null }] }),
    ];
    const pull = { number: 7, branch: 'jump', state: 'open', updatedAt: 1 } as PullRequest;
    const chat = { id: 'chat-1', taskId: 't2', agentId: 'x', state: 'working', updatedAt: 1 } as ChatInfo;
    const [now] = lanesOf(doc, { tasks, pulls: [pull], chats: [chat] });
    const [jump, grapple] = now!.features;
    expect(jump).toMatchObject({ tasksDone: 1, criteria: 2, owners: [owner], agents: [{ name: 'Agent', chatId: 'chat-1', state: 'working' }] });
    expect(jump!.pulls.map((p) => p.number)).toEqual([7]);
    expect(jump!.next).toMatchObject({ task: { id: 't2' }, stage: 'review' });
    expect(grapple!.status.state).toBe('blocked');
    expect(grapple!.status.waitingOn.map((d) => d.title)).toEqual(['Jump']);
    expect(grapple!.next).toBeNull();
    expect(now).toMatchObject({ done: 0, blocked: 1 });
  });

  it('flags a milestone at risk when blocked features remain close to its date, and overdue after it', () => {
    const now = new Date(2026, 9, 26, 15).getTime();
    expect(daysUntil('2026-10-26', now)).toBe(0);
    expect(daysUntil('2026-10-30', now)).toBe(4);
    expect(daysUntil('2026-10-20', now)).toBe(-6);
    expect(milestoneRisk({ daysLeft: 4, done: 1, blocked: 1, total: 3 })).toBe('at-risk');
    expect(milestoneRisk({ daysLeft: 4, done: 1, blocked: 0, total: 3 })).toBeNull();
    expect(milestoneRisk({ daysLeft: 30, done: 1, blocked: 1, total: 3 })).toBeNull();
    expect(milestoneRisk({ daysLeft: -1, done: 1, blocked: 0, total: 3 })).toBe('overdue');
    expect(milestoneRisk({ daysLeft: -1, done: 3, blocked: 0, total: 3 })).toBeNull();
  });

  it('picks the first milestone with unfinished features as the current one', () => {
    const doc = docWith('Jump', 'Grapple');
    applyPlanOp(doc, moveFeature(readPlanning(doc), readMilestones(doc), ID(2), 'next', null), 'Martin');
    const tasks = [task('t1', ID(1), 'done')];
    expect(currentMilestone(lanesOf(doc, { tasks }))!.milestone.id).toBe('next');
    expect(currentMilestone(lanesOf(new Y.Doc()))).toBeNull();
  });
});

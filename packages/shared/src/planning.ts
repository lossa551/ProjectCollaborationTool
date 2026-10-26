import * as Y from 'yjs';
import { z } from 'zod';
import { itemsOf, readItems, setItemText } from './docs.js';
import { CRITERIA_LIMIT, CriterionText, ParticipantKind, STAGE_LABELS, ReadList, TaskScope, TaskStage, TaskTitle, type Task } from './model.js';
import { normalizePath } from './paths.js';

// The planning space (screen 4): features, ideas and notes in one shared Yjs
// document. A feature is written up together (requirements, dependencies,
// acceptance criteria, implementation tasks); approving it creates the tasks
// on the board, and from then on its progress is read from those tasks.

export const PlanKind = z.enum(['feature', 'idea', 'note']);
export type PlanKind = z.infer<typeof PlanKind>;

export const PLAN_KIND_LABELS: Record<PlanKind, string> = { feature: 'Feature', idea: 'Idea', note: 'Note' };

/** The parts of a plan item that are free text, edited live by everyone. */
export const PlanTextField = z.enum(['body', 'requirements', 'dependencies', 'criteria', 'tasks']);
export type PlanTextField = z.infer<typeof PlanTextField>;

export const PlanTitle = z.string().trim().min(1).max(200);
export const PLAN_TEXT_LIMIT = 50_000;

/** The stages someone can be picked for on the roadmap; done needs nobody. */
export const AssignStage = TaskStage.exclude(['done']);
export type AssignStage = z.infer<typeof AssignStage>;

/** Who does one stage of a feature: a person (participant id) or an agent (profile id). */
export const Assignee = z.object({
  kind: ParticipantKind,
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
});
export type Assignee = z.infer<typeof Assignee>;

// Milestones (issue #42): the lanes of the roadmap. They live in the planning
// document next to the items, in their own map. Until someone changes them a
// project has Now, Next and Later; those have fixed ids, so two people who
// start editing them at the same time do not end up with two sets.

export const MilestoneTitle = z.string().trim().min(1).max(100);
export const MilestoneGoal = z.string().trim().max(300);
/** A calendar day, YYYY-MM-DD. */
export const TargetDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const Milestone = z.object({
  id: z.string(),
  title: z.string().max(100),
  goal: z.string().default(''),
  target: TargetDate.nullable().default(null),
  order: z.number(),
  createdAt: z.number().default(0),
});
export type Milestone = z.infer<typeof Milestone>;

export const DEFAULT_MILESTONES: Milestone[] = [
  { id: 'now', title: 'Now', goal: '', target: null, order: 0, createdAt: 0 },
  { id: 'next', title: 'Next', goal: '', target: null, order: 1, createdAt: 0 },
  { id: 'later', title: 'Later', goal: '', target: null, order: 2, createdAt: 0 },
];

export const MILESTONE_LIMIT = 30;

export const PlanItem = z.object({
  id: z.string(),
  kind: PlanKind,
  title: z.string().max(200),
  /** The write-up: what and why. */
  body: z.string().default(''),
  /** One per line. */
  requirements: z.string().default(''),
  /** One per line; a line naming another feature links to it. */
  dependencies: z.string().default(''),
  /** One per line; they go onto the tasks when the plan is approved. */
  criteria: z.string().default(''),
  /** One task per line: a title, optionally followed by "|" and its allowed paths. */
  tasks: z.string().default(''),
  createdBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  approvedAt: z.number().nullable().default(null),
  approvedBy: z.string().nullable().default(null),
  /** The milestone a feature belongs to; one that is gone or unset means the first. */
  milestoneId: z.string().nullable().default(null),
  /** Position inside its milestone; unset ones follow, in creation order. */
  rank: z.number().nullable().default(null),
  /** Who does each stage, picked on the roadmap. */
  assign: z.partialRecord(AssignStage, Assignee).catch({}).default({}),
});
export type PlanItem = z.infer<typeof PlanItem>;

const ItemId = z.string().min(8).max(64);
const MilestoneId = z.string().min(3).max(64);

/** One change to the planning space; applied to the Yjs document by whoever makes it. */
export const PlanOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), id: ItemId, kind: PlanKind, title: PlanTitle }),
  z.object({ op: z.literal('set'), id: ItemId, kind: PlanKind.optional(), title: PlanTitle.optional() }),
  z.object({
    op: z.literal('text'),
    id: ItemId,
    field: PlanTextField,
    value: z.string().max(PLAN_TEXT_LIMIT),
    /** The text the editor started from; see setText. */
    base: z.string().max(PLAN_TEXT_LIMIT).optional(),
  }),
  z.object({ op: z.literal('approve'), id: ItemId }),
  z.object({ op: z.literal('delete'), id: ItemId }),
  /** Puts these features in this milestone, in this order. */
  z.object({ op: z.literal('order'), milestoneId: MilestoneId, ids: z.array(ItemId).max(1000) }),
  z.object({ op: z.literal('assign'), id: ItemId, stage: AssignStage, who: Assignee.nullable() }),
  /** Creates a milestone (title needed) or changes one. */
  z.object({
    op: z.literal('milestone'),
    id: MilestoneId,
    title: MilestoneTitle.optional(),
    goal: MilestoneGoal.optional(),
    target: TargetDate.nullable().optional(),
    order: z.number().finite().optional(),
  }),
  z.object({ op: z.literal('milestone-delete'), id: MilestoneId }),
]);
export type PlanOp = z.infer<typeof PlanOp>;

/** Approving a feature: the tasks to create, each with its acceptance criteria. */
export const PlanApproval = z.object({
  featureId: ItemId,
  tasks: z
    .array(z.object({ title: TaskTitle, scope: TaskScope, readFirst: ReadList.default([]), criteria: z.array(CriterionText).max(CRITERIA_LIMIT) }))
    .min(1)
    .max(50),
});
export type PlanApproval = z.infer<typeof PlanApproval>;

const ASSIGN_PREFIX = 'assign:';

/** An item as stored: stage picks are kept as one "assign:<stage>" key each. */
const StoredPlanItem = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null) return raw;
  const assign: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith(ASSIGN_PREFIX)) assign[key.slice(ASSIGN_PREFIX.length)] = value;
  }
  return { ...raw, assign };
}, PlanItem);

export function readPlanning(doc: Y.Doc): PlanItem[] {
  return readItems(doc, 'planning', StoredPlanItem).sort((a, b) => a.createdAt - b.createdAt);
}

const milestonesOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('milestones');

/** The milestones in order; Now, Next and Later until someone changes them. */
export function readMilestones(doc: Y.Doc): Milestone[] {
  const out: Milestone[] = [];
  for (const [id, entry] of milestonesOf(doc).entries()) {
    if (!(entry instanceof Y.Map)) continue;
    const parsed = Milestone.safeParse({ ...entry.toJSON(), id });
    if (parsed.success) out.push(parsed.data);
  }
  if (out.length === 0) return DEFAULT_MILESTONES.map((m) => ({ ...m }));
  return out.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Writes the default milestones before the first change to them. */
function materializeMilestones(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  const map = milestonesOf(doc);
  if (map.size > 0) return map;
  for (const m of DEFAULT_MILESTONES) {
    const entry = new Y.Map<unknown>();
    map.set(m.id, entry);
    for (const [key, value] of Object.entries(m)) if (key !== 'id') entry.set(key, value);
  }
  return map;
}

function applyMilestoneOp(doc: Y.Doc, op: Extract<PlanOp, { op: 'milestone' | 'milestone-delete' }>, now: number): boolean {
  const map = materializeMilestones(doc);
  const entry = map.get(op.id);
  if (op.op === 'milestone-delete') {
    // The last one stays: features always need a lane.
    if (!(entry instanceof Y.Map) || map.size <= 1) return false;
    map.delete(op.id);
    return true;
  }
  if (!(entry instanceof Y.Map)) {
    if (!op.title || map.size >= MILESTONE_LIMIT) return false;
    const created = new Y.Map<unknown>();
    map.set(op.id, created);
    created.set('title', op.title);
    created.set('goal', op.goal ?? '');
    created.set('target', op.target ?? null);
    created.set('order', op.order ?? Math.max(...readMilestones(doc).map((m) => m.order)) + 1);
    created.set('createdAt', now);
    return true;
  }
  if (op.title !== undefined) entry.set('title', op.title);
  if (op.goal !== undefined) entry.set('goal', op.goal);
  if (op.target !== undefined) entry.set('target', op.target);
  if (op.order !== undefined) entry.set('order', op.order);
  return true;
}

/** Applies a change; returns false when the item it refers to is gone. */
export function applyPlanOp(doc: Y.Doc, op: PlanOp, by: string, now = Date.now()): boolean {
  const items = itemsOf(doc, 'planning');
  let ok = true;
  doc.transact(() => {
    if (op.op === 'milestone' || op.op === 'milestone-delete') {
      ok = applyMilestoneOp(doc, op, now);
      return;
    }
    if (op.op === 'order') {
      // Ranks are rewritten for the whole lane, so they never run out of room
      // between two neighbours. Not a content change: updatedAt stays.
      op.ids.forEach((id, rank) => {
        const item = items.get(id);
        if (!(item instanceof Y.Map)) return;
        item.set('milestoneId', op.milestoneId);
        item.set('rank', rank);
      });
      return;
    }
    if (op.op === 'create') {
      if (items.has(op.id)) return;
      const item = new Y.Map<unknown>();
      items.set(op.id, item);
      item.set('kind', op.kind);
      item.set('title', op.title);
      item.set('createdBy', by);
      item.set('createdAt', now);
      item.set('updatedAt', now);
      for (const field of PlanTextField.options) item.set(field, new Y.Text());
      return;
    }
    const item = items.get(op.id);
    if (!(item instanceof Y.Map)) {
      ok = false;
      return;
    }
    switch (op.op) {
      case 'set':
        if (op.kind) item.set('kind', op.kind);
        if (op.title) item.set('title', op.title);
        break;
      case 'text':
        setItemText(item, op.field, op.value, op.base);
        break;
      case 'approve':
        item.set('approvedAt', now);
        item.set('approvedBy', by);
        break;
      case 'assign':
        // One key per stage on the item itself, so picks for different stages merge.
        if (op.who) item.set(`${ASSIGN_PREFIX}${op.stage}`, { ...op.who });
        else item.delete(`${ASSIGN_PREFIX}${op.stage}`);
        break;
      case 'delete':
        items.delete(op.id);
        return;
    }
    item.set('updatedAt', now);
  });
  return ok;
}

/** Non-empty lines, without list markers like "- ", "* ", "1." or "[ ]". */
export function planLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
        .replace(/^\[[ xX]?\]\s*/, '')
        .trim(),
    )
    .filter(Boolean);
}

export interface PlannedTask {
  title: string;
  scope: string[];
  readFirst: string[];
}

const pathList = (text: string | undefined, limit: number) =>
  (text ?? '')
    .split(/[,\s]+/)
    .flatMap((p) => {
      const path = normalizePath(p);
      return path ? [path] : [];
    })
    .slice(0, limit);

/** The implementation tasks of a plan: "Title | path/a/**, path/b.gd | files/to/read.md". */
export function plannedTasks(text: string): PlannedTask[] {
  return planLines(text).flatMap((line) => {
    const [head, scope, read] = line.split('|');
    const title = head!.trim().slice(0, 200);
    if (!title) return [];
    return [{ title, scope: pathList(scope, 100), readFirst: pathList(read, 50) }];
  });
}

/**
 * Where a feature stands. Before its tasks exist it is in planning; after, it
 * is as far along as its least finished task.
 */
export type FeatureState = 'planning' | 'in-progress' | 'blocked' | 'unverified' | 'ready';

export const FEATURE_STATE_LABELS: Record<FeatureState, string> = {
  planning: 'Planning',
  'in-progress': 'In progress',
  blocked: 'Blocked',
  unverified: 'Not verified',
  ready: 'Ready',
};

export interface FeatureStatus {
  stage: TaskStage;
  state: FeatureState;
  /** Why it is blocked or not verified, in a few words. */
  reason: string | null;
  tasks: Task[];
  verified: number;
  failing: number;
  untested: number;
  /** Features this one depends on that are not done yet. */
  waitingOn: PlanItem[];
}

/** The features a feature's dependency lines name, matched by title. */
export function featureDependencies(item: PlanItem, items: PlanItem[]): PlanItem[] {
  const byTitle = new Map(items.filter((i) => i.kind === 'feature' && i.id !== item.id).map((i) => [i.title.trim().toLowerCase(), i]));
  return planLines(item.dependencies).flatMap((line) => {
    const match = byTitle.get(line.toLowerCase());
    return match ? [match] : [];
  });
}

/** A feature's stage: planning until its tasks exist, then that of its least finished task. */
export function featureStage(item: PlanItem, tasks: Task[]): TaskStage {
  const order = TaskStage.options;
  const own = tasks.filter((t) => t.featureId === item.id);
  if (own.length === 0) return 'planning';
  return own.reduce<TaskStage>((min, t) => (order.indexOf(t.stage) < order.indexOf(min) ? t.stage : min), 'done');
}

export function featureStatus(item: PlanItem, items: PlanItem[], tasks: Task[]): FeatureStatus {
  const own = tasks.filter((t) => t.featureId === item.id);
  const criteria = own.flatMap((t) => t.criteria);
  const verified = criteria.filter((c) => c.state === 'verified').length;
  const failing = criteria.filter((c) => c.state === 'failing').length;
  const untested = criteria.length - verified - failing;
  const stage = featureStage(item, tasks);
  const waitingOn = featureDependencies(item, items).filter((dep) => featureStage(dep, tasks) !== 'done');

  let state: FeatureState;
  let reason: string | null = null;
  if (failing > 0) {
    state = 'blocked';
    reason = `${failing} failing ${failing === 1 ? 'criterion' : 'criteria'}`;
  } else if (waitingOn.length > 0 && stage !== 'done') {
    state = 'blocked';
    reason = `Waiting on ${waitingOn.map((d) => d.title).join(', ')}`;
  } else if (own.length === 0) {
    state = 'planning';
  } else if (stage === 'done' && untested === 0) {
    state = 'ready';
  } else if ((stage === 'testing' || stage === 'done') && untested > 0) {
    state = 'unverified';
    reason = `${untested} not tested`;
  } else {
    state = 'in-progress';
    reason = STAGE_LABELS[stage];
  }
  return { stage, state, reason, tasks: own, verified, failing, untested, waitingOn };
}

/** The plan as text, for an agent asked to work on or discuss it. */
export function renderPlan(item: PlanItem): string {
  const lines = [`${PLAN_KIND_LABELS[item.kind]}: ${item.title}`];
  const section = (title: string, text: string) => {
    if (text.trim()) lines.push('', `${title}:`, text.trim());
  };
  section('Description', item.body);
  section('Requirements', item.requirements);
  section('Dependencies', item.dependencies);
  section('Acceptance criteria', item.criteria);
  section('Implementation tasks', item.tasks);
  return lines.join('\n');
}

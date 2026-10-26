import * as Y from 'yjs';
import { z } from 'zod';
import { itemsOf, readItems, setItemText } from './docs.js';
import { STAGE_LABELS, TaskStage, type Task } from './model.js';
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
});
export type PlanItem = z.infer<typeof PlanItem>;

const ItemId = z.string().min(8).max(64);

/** One change to the planning space; applied to the Yjs document by whoever makes it. */
export const PlanOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), id: ItemId, kind: PlanKind, title: PlanTitle }),
  z.object({ op: z.literal('set'), id: ItemId, kind: PlanKind.optional(), title: PlanTitle.optional() }),
  z.object({ op: z.literal('text'), id: ItemId, field: PlanTextField, value: z.string().max(PLAN_TEXT_LIMIT) }),
  z.object({ op: z.literal('approve'), id: ItemId }),
  z.object({ op: z.literal('delete'), id: ItemId }),
]);
export type PlanOp = z.infer<typeof PlanOp>;

export function readPlanning(doc: Y.Doc): PlanItem[] {
  return readItems(doc, 'planning', PlanItem).sort((a, b) => a.createdAt - b.createdAt);
}

/** Applies a change; returns false when the item it refers to is gone. */
export function applyPlanOp(doc: Y.Doc, op: PlanOp, by: string, now = Date.now()): boolean {
  const items = itemsOf(doc, 'planning');
  let ok = true;
  doc.transact(() => {
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
        setItemText(item, op.field, op.value);
        break;
      case 'approve':
        item.set('approvedAt', now);
        item.set('approvedBy', by);
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
}

/** The implementation tasks of a plan: "Title | path/a/**, path/b.gd". */
export function plannedTasks(text: string): PlannedTask[] {
  return planLines(text).flatMap((line) => {
    const bar = line.indexOf('|');
    const title = (bar >= 0 ? line.slice(0, bar) : line).trim().slice(0, 200);
    if (!title) return [];
    const scope =
      bar >= 0
        ? line
            .slice(bar + 1)
            .split(/[,\s]+/)
            .flatMap((p) => {
              const path = normalizePath(p);
              return path ? [path] : [];
            })
            .slice(0, 100)
        : [];
    return [{ title, scope }];
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

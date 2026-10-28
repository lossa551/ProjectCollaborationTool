import { randomUUID } from 'node:crypto';
import {
  CRITERION_STATE_LABELS,
  STAGE_LABELS,
  formatCost,
  mergeCriteria,
  type CriterionState,
  type DuplicateCheck,
  type Participant,
  type Task,
  type TaskChanges,
  type TaskStage,
} from '@pct/shared';

// The shared task board: validates changes and describes them for the
// activity feed. Pure in-memory logic; the server persists and broadcasts.

export type BoardResult =
  | { ok: true; task: Task; descriptions: string[]; conflicts: string[] }
  | { ok: false; message: string };

export class TaskBoard {
  private readonly tasks = new Map<string, Task>();

  constructor(tasks: Task[] = []) {
    for (const task of tasks) this.tasks.set(task.id, task);
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  create(
    input: {
      id?: string;
      title: string;
      stage?: TaskStage;
      scope?: string[];
      readFirst?: string[];
      featureId?: string | null;
      criteria?: { id: string; text: string }[];
    },
    now = Date.now(),
  ): BoardResult {
    // A replayed create (the client did not see our answer before it dropped) changes nothing.
    const existing = input.id ? this.tasks.get(input.id) : undefined;
    if (existing) return { ok: true, task: existing, descriptions: [], conflicts: [] };
    const task: Task = {
      id: input.id ?? randomUUID(),
      title: input.title,
      stage: input.stage ?? 'planning',
      owner: null,
      scope: input.scope ?? [],
      readFirst: input.readFirst ?? [],
      branch: null,
      featureId: input.featureId ?? null,
      criteria: mergeCriteria([], uniqueIds(input.criteria ?? [])),
      budget: null,
      duplicateCheck: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.tasks.set(task.id, task);
    return { ok: true, task, descriptions: [`added "${task.title}"`], conflicts: [] };
  }

  /**
   * Applies changes. A new owner must be connected right now, so a task is
   * never assigned to someone who is not in the session. A field whose value
   * is no longer what the client expected was changed by someone else in the
   * meantime: that field keeps their value and is reported as a conflict.
   */
  update(
    taskId: string,
    requested: TaskChanges,
    findParticipant: (id: string) => Participant | undefined,
    expected: TaskChanges = {},
    now = Date.now(),
  ): BoardResult {
    const current = this.tasks.get(taskId);
    if (!current) return { ok: false, message: 'That task no longer exists' };

    const conflicts: string[] = [];
    const changes: TaskChanges = { ...requested };
    const clash = (field: keyof TaskChanges, same: boolean, what: string) => {
      if (changes[field] === undefined || expected[field] === undefined || same) return;
      delete changes[field];
      conflicts.push(what);
    };
    clash('title', expected.title === current.title, `"${current.title}" was renamed by someone else`);
    clash('stage', expected.stage === current.stage, `"${current.title}" was moved to ${STAGE_LABELS[current.stage]} by someone else`);
    clash('ownerId', (expected.ownerId ?? null) === (current.owner?.id ?? null), `"${current.title}" was reassigned by someone else`);
    clash('scope', (expected.scope ?? []).join('\n') === current.scope.join('\n'), `the paths of "${current.title}" were changed by someone else`);
    clash(
      'readFirst',
      (expected.readFirst ?? []).join('\n') === current.readFirst.join('\n'),
      `the files to read for "${current.title}" were changed by someone else`,
    );
    clash('branch', (expected.branch ?? null) === current.branch, `the branch of "${current.title}" was changed by someone else`);
    clash(
      'criteria',
      criteriaKey(expected.criteria ?? []) === criteriaKey(current.criteria),
      `the acceptance criteria of "${current.title}" were changed by someone else`,
    );

    clash('budget', (expected.budget ?? null) === current.budget, `the budget of "${current.title}" was changed by someone else`);

    const next: Task = { ...current };
    const descriptions: string[] = [];

    if (changes.title !== undefined && changes.title !== current.title) {
      next.title = changes.title;
      descriptions.push(`renamed "${current.title}" to "${changes.title}"`);
    }
    if (changes.stage !== undefined && changes.stage !== current.stage) {
      next.stage = changes.stage;
      descriptions.push(`moved "${next.title}" to ${STAGE_LABELS[changes.stage]}`);
    }
    if (changes.ownerId !== undefined && changes.ownerId !== (current.owner?.id ?? null)) {
      if (changes.ownerId === null) {
        next.owner = null;
        descriptions.push(`unassigned "${next.title}"`);
      } else {
        const owner = findParticipant(changes.ownerId);
        if (!owner) return { ok: false, message: 'That person or agent is not in the session' };
        next.owner = { id: owner.id, name: owner.name, kind: owner.kind };
        descriptions.push(`assigned "${next.title}" to ${owner.name}`);
      }
    }
    if (changes.scope !== undefined && changes.scope.join('\n') !== current.scope.join('\n')) {
      next.scope = changes.scope;
      descriptions.push(`changed the scope of "${next.title}"`);
    }
    if (changes.readFirst !== undefined && changes.readFirst.join('\n') !== current.readFirst.join('\n')) {
      next.readFirst = changes.readFirst;
      descriptions.push(`changed the files to read for "${next.title}"`);
    }
    if (changes.branch !== undefined && changes.branch !== current.branch) {
      next.branch = changes.branch;
      descriptions.push(
        changes.branch === null ? `unlinked the branch of "${next.title}"` : `linked "${next.title}" to branch ${changes.branch}`,
      );
    }

    if (changes.criteria !== undefined && criteriaKey(changes.criteria) !== criteriaKey(current.criteria)) {
      next.criteria = mergeCriteria(current.criteria, uniqueIds(changes.criteria));
      descriptions.push(`changed the acceptance criteria of "${next.title}"`);
    }

    if (changes.budget !== undefined && changes.budget !== current.budget) {
      next.budget = changes.budget;
      descriptions.push(
        changes.budget === null ? `removed the budget of "${next.title}"` : `set a ${formatCost(changes.budget)} budget for "${next.title}"`,
      );
    }

    if (descriptions.length === 0) return { ok: true, task: current, descriptions, conflicts };
    next.updatedAt = now;
    next.version = current.version + 1;
    this.tasks.set(taskId, next);
    return { ok: true, task: next, descriptions, conflicts };
  }

  /** Records a test result for one criterion. The latest result wins. */
  verify(
    taskId: string,
    criterionId: string,
    result: { state: CriterionState; evidence: string },
    by: string,
    now = Date.now(),
  ): BoardResult {
    const current = this.tasks.get(taskId);
    if (!current) return { ok: false, message: 'That task no longer exists' };
    const criterion = current.criteria.find((c) => c.id === criterionId);
    if (!criterion) return { ok: false, message: 'That acceptance criterion no longer exists' };
    const evidence = result.evidence.trim();
    if (criterion.state === result.state && criterion.evidence === evidence) {
      return { ok: true, task: current, descriptions: [], conflicts: [] };
    }
    const next: Task = {
      ...current,
      criteria: current.criteria.map((c) => (c.id === criterionId ? { ...c, state: result.state, evidence, by, at: now } : c)),
      updatedAt: now,
      version: current.version + 1,
    };
    this.tasks.set(taskId, next);
    const what = result.state === 'untested' ? 'marked as not tested' : `recorded ${CRITERION_STATE_LABELS[result.state].toLowerCase()}`;
    return { ok: true, task: next, descriptions: [`${what}: "${criterion.text}" on "${next.title}"`], conflicts: [] };
  }

  /** Records the answer to the review-time duplicate question; the latest answer wins. */
  duplicateCheck(taskId: string, check: Omit<DuplicateCheck, 'at'>, now = Date.now()): BoardResult {
    const current = this.tasks.get(taskId);
    if (!current) return { ok: false, message: 'That task no longer exists' };
    const next: Task = { ...current, duplicateCheck: { ...check, answer: check.answer.trim(), at: now }, updatedAt: now, version: current.version + 1 };
    this.tasks.set(taskId, next);
    const what =
      check.verdict === 'duplicate'
        ? 'may add something that already exists'
        : check.verdict === 'clear'
          ? 'adds nothing that already exists'
          : 'could not be checked for duplicates';
    return { ok: true, task: next, descriptions: [`${check.by} says "${next.title}" ${what}`], conflicts: [] };
  }

  delete(taskId: string): BoardResult {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, message: 'That task no longer exists' };
    this.tasks.delete(taskId);
    return { ok: true, task, descriptions: [`deleted "${task.title}"`], conflicts: [] };
  }
}

const criteriaKey = (criteria: { id: string; text: string }[]) => JSON.stringify(criteria.map(({ id, text }) => [id, text]));

/** A repeated id would make two criteria share one result; the first one wins. */
function uniqueIds<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.id) && seen.add(item.id));
}

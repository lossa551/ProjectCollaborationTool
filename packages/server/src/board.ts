import { randomUUID } from 'node:crypto';
import { STAGE_LABELS, type Participant, type Task, type TaskChanges, type TaskStage } from '@pct/shared';

// The shared task board: validates changes and describes them for the
// activity feed. Pure in-memory logic; the server persists and broadcasts.

export type BoardResult =
  | { ok: true; task: Task; descriptions: string[] }
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

  create(input: { title: string; stage?: TaskStage; scope?: string[] }, now = Date.now()): BoardResult {
    const task: Task = {
      id: randomUUID(),
      title: input.title,
      stage: input.stage ?? 'planning',
      owner: null,
      scope: input.scope ?? [],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.tasks.set(task.id, task);
    return { ok: true, task, descriptions: [`added "${task.title}"`] };
  }

  /**
   * Applies changes. A new owner must be connected right now, so a task is
   * never assigned to someone who is not in the session.
   */
  update(
    taskId: string,
    changes: TaskChanges,
    findParticipant: (id: string) => Participant | undefined,
    now = Date.now(),
  ): BoardResult {
    const current = this.tasks.get(taskId);
    if (!current) return { ok: false, message: 'That task no longer exists' };

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

    if (descriptions.length === 0) return { ok: true, task: current, descriptions };
    next.updatedAt = now;
    next.version = current.version + 1;
    this.tasks.set(taskId, next);
    return { ok: true, task: next, descriptions };
  }

  delete(taskId: string): BoardResult {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, message: 'That task no longer exists' };
    this.tasks.delete(taskId);
    return { ok: true, task, descriptions: [`deleted "${task.title}"`] };
  }
}

import type { Activity, Lock, LockRules, SessionInfo, Task } from '@pct/shared';

// Where the server keeps durable state. The in-memory store is the first
// implementation; SQLite comes next (issue #4), and Postgres when the server
// moves to a hosted machine. All of them implement this interface.

export interface Storage {
  loadSession(): Promise<SessionInfo | null>;
  saveSession(session: SessionInfo): Promise<void>;
  listTasks(): Promise<Task[]>;
  saveTask(task: Task): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  listLocks(): Promise<Lock[]>;
  saveLock(lock: Lock): Promise<void>;
  deleteLock(lockId: string): Promise<void>;
  /** Null until someone changes the rules; the server then uses the defaults. */
  loadLockRules(): Promise<LockRules | null>;
  saveLockRules(rules: LockRules): Promise<void>;
  /** Append-only log of what happened, for the activity feed and later undo. */
  appendActivity(entry: Activity): Promise<void>;
  /** The most recent entries, oldest first. */
  listActivity(limit?: number): Promise<Activity[]>;
  close(): Promise<void>;
}

export class MemoryStorage implements Storage {
  private session: SessionInfo | null = null;
  private readonly tasks = new Map<string, Task>();
  private readonly locks = new Map<string, Lock>();
  private lockRules: LockRules | null = null;
  private readonly activity: Activity[] = [];

  async loadSession() {
    return this.session;
  }

  async saveSession(session: SessionInfo) {
    this.session = session;
  }

  async listTasks() {
    return [...this.tasks.values()];
  }

  async saveTask(task: Task) {
    this.tasks.set(task.id, task);
  }

  async deleteTask(taskId: string) {
    this.tasks.delete(taskId);
  }

  async listLocks() {
    return [...this.locks.values()];
  }

  async saveLock(lock: Lock) {
    this.locks.set(lock.id, lock);
  }

  async deleteLock(lockId: string) {
    this.locks.delete(lockId);
  }

  async loadLockRules() {
    return this.lockRules;
  }

  async saveLockRules(rules: LockRules) {
    this.lockRules = rules;
  }

  async appendActivity(entry: Activity) {
    this.activity.push(entry);
  }

  async listActivity(limit = 100) {
    return this.activity.slice(-limit);
  }

  async close() {}
}

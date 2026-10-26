import type { Activity, Lock, LockRules, ParticipantKind, RepoRef, SessionInfo, Task } from '@pct/shared';

// Where the server keeps durable state. The in-memory store is the first
// implementation; SqliteStorage keeps it on disk, and Postgres when the server
// moves to a hosted machine. All of them implement this interface.

/**
 * A person or agent the server has seen before. The client proves it is the
 * same one by presenting the token whose hash is stored here.
 */
export interface Identity {
  id: string;
  name: string;
  kind: ParticipantKind;
  createdAt: number;
  lastSeenAt: number;
}

export interface Storage {
  loadSession(): Promise<SessionInfo | null>;
  saveSession(session: SessionInfo): Promise<void>;
  /** The session secret, kept so invite codes stay valid across restarts. */
  loadSecret(): Promise<string | null>;
  saveSecret(secret: string): Promise<void>;
  findIdentity(tokenHash: string): Promise<Identity | null>;
  saveIdentity(tokenHash: string, identity: Identity): Promise<void>;
  listTasks(): Promise<Task[]>;
  saveTask(task: Task): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  listLocks(): Promise<Lock[]>;
  saveLock(lock: Lock): Promise<void>;
  deleteLock(lockId: string): Promise<void>;
  /** Null until someone changes the rules; the server then uses the defaults. */
  loadLockRules(): Promise<LockRules | null>;
  saveLockRules(rules: LockRules): Promise<void>;
  /** The GitHub repository the session is linked to. */
  loadGitHubRepo(): Promise<RepoRef | null>;
  saveGitHubRepo(repo: RepoRef | null): Promise<void>;
  /** Append-only log of what happened, for the activity feed and later undo. */
  appendActivity(entry: Activity): Promise<void>;
  /** The most recent entries, oldest first. */
  listActivity(limit?: number): Promise<Activity[]>;
  close(): Promise<void>;
}

export class MemoryStorage implements Storage {
  private session: SessionInfo | null = null;
  private secret: string | null = null;
  private readonly identities = new Map<string, Identity>();
  private readonly tasks = new Map<string, Task>();
  private readonly locks = new Map<string, Lock>();
  private lockRules: LockRules | null = null;
  private githubRepo: RepoRef | null = null;
  private readonly activity: Activity[] = [];

  async loadSession() {
    return this.session;
  }

  async saveSession(session: SessionInfo) {
    this.session = session;
  }

  async loadSecret() {
    return this.secret;
  }

  async saveSecret(secret: string) {
    this.secret = secret;
  }

  async findIdentity(tokenHash: string) {
    return this.identities.get(tokenHash) ?? null;
  }

  async saveIdentity(tokenHash: string, identity: Identity) {
    this.identities.set(tokenHash, identity);
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

  async loadGitHubRepo() {
    return this.githubRepo;
  }

  async saveGitHubRepo(repo: RepoRef | null) {
    this.githubRepo = repo;
  }

  async appendActivity(entry: Activity) {
    this.activity.push(entry);
  }

  async listActivity(limit = 100) {
    return this.activity.slice(-limit);
  }

  async close() {}
}

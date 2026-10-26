import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Activity, Lock, LockRules, ParticipantKind, RepoRef, SessionInfo, Task } from '@pct/shared';
import type { Identity, Storage } from './storage.js';

// Storage in one SQLite file, using the SQLite built into Node (and Electron),
// so nothing native has to be compiled. Records are stored as JSON and
// checked against the shared schemas when read back; a row that no longer
// fits (say, from a newer version) is skipped rather than crashing the server.

const SCHEMA_VERSION = 1;

const IdentityRecord = z.object({
  id: z.string(),
  name: z.string(),
  kind: ParticipantKind,
  createdAt: z.number(),
  lastSeenAt: z.number(),
});

export class SqliteStorage implements Storage {
  private readonly db: DatabaseSync;
  private open = true;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;');
    this.migrate();
  }

  private migrate() {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version > SCHEMA_VERSION) {
      throw new Error(`The session database was made by a newer version (schema ${version}). Update the app.`);
    }
    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS locks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS identities (token_hash TEXT PRIMARY KEY, data TEXT NOT NULL);
        PRAGMA user_version = 1;
      `);
    }
  }

  private getMeta<T>(key: string, schema: z.ZodType<T>): T | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? parseJson(row.value, schema) : null;
  }

  private setMeta(key: string, value: unknown) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  private all<T>(sql: string, schema: z.ZodType<T>, ...params: (string | number)[]): T[] {
    const rows = this.db.prepare(sql).all(...params) as { data: string }[];
    return rows.flatMap((row) => {
      const parsed = parseJson(row.data, schema);
      return parsed ? [parsed] : [];
    });
  }

  async loadSession() {
    return this.getMeta('session', SessionInfo);
  }

  async saveSession(session: SessionInfo) {
    this.setMeta('session', session);
  }

  async loadSecret() {
    return this.getMeta('secret', z.string());
  }

  async saveSecret(secret: string) {
    this.setMeta('secret', secret);
  }

  async findIdentity(tokenHash: string): Promise<Identity | null> {
    const row = this.db.prepare('SELECT data FROM identities WHERE token_hash = ?').get(tokenHash) as
      | { data: string }
      | undefined;
    return row ? parseJson(row.data, IdentityRecord) : null;
  }

  async saveIdentity(tokenHash: string, identity: Identity) {
    this.db
      .prepare('INSERT INTO identities (token_hash, data) VALUES (?, ?) ON CONFLICT(token_hash) DO UPDATE SET data = excluded.data')
      .run(tokenHash, JSON.stringify(identity));
  }

  async listTasks() {
    return this.all('SELECT data FROM tasks', Task);
  }

  async saveTask(task: Task) {
    this.db
      .prepare('INSERT INTO tasks (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(task.id, JSON.stringify(task));
  }

  async deleteTask(taskId: string) {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  }

  async listLocks() {
    return this.all('SELECT data FROM locks', Lock);
  }

  async saveLock(lock: Lock) {
    this.db
      .prepare('INSERT INTO locks (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(lock.id, JSON.stringify(lock));
  }

  async deleteLock(lockId: string) {
    this.db.prepare('DELETE FROM locks WHERE id = ?').run(lockId);
  }

  async loadLockRules() {
    return this.getMeta('lockRules', LockRules);
  }

  async saveLockRules(rules: LockRules) {
    this.setMeta('lockRules', rules);
  }

  async loadGitHubRepo() {
    return this.getMeta('githubRepo', RepoRef.nullable());
  }

  async saveGitHubRepo(repo: RepoRef | null) {
    this.setMeta('githubRepo', repo);
  }

  async appendActivity(entry: Activity) {
    this.db.prepare('INSERT INTO activity (data) VALUES (?)').run(JSON.stringify(entry));
  }

  async listActivity(limit = 100) {
    return this.all('SELECT data FROM (SELECT seq, data FROM activity ORDER BY seq DESC LIMIT ?) ORDER BY seq', Activity, limit);
  }

  async close() {
    if (!this.open) return;
    this.open = false;
    this.db.close();
  }
}

function parseJson<T>(text: string, schema: z.ZodType<T>): T | null {
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

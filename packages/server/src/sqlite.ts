import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  Activity,
  AgentProfile,
  BloatReport,
  ChatInfo,
  ChatMessage,
  Lock,
  LockRules,
  ParticipantKind,
  RepoRef,
  SessionInfo,
  Task,
  DocId,
  PriceTable,
  UsageRow,
  usageKey,
} from '@pct/shared';
import type { Identity, SessionAccess, Storage } from './storage.js';

// Storage in one SQLite file, using the SQLite built into Node (and Electron),
// so nothing native has to be compiled. Records are stored as JSON and
// checked against the shared schemas when read back; a row that no longer
// fits (say, from a newer version) is skipped rather than crashing the server.

/** The database layout this app writes; older files are upgraded when opened. */
export const SCHEMA_VERSION = 4;

const IdentityRecord = z.object({
  id: z.string(),
  name: z.string(),
  kind: ParticipantKind,
  createdAt: z.number(),
  lastSeenAt: z.number(),
});

const AccessRecord = z.object({
  issuedAt: z.number(),
  retired: z.array(z.object({ secret: z.string(), retiredAt: z.number() })),
  removed: z.array(z.object({ id: z.string(), name: z.string(), at: z.number() })),
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
    if (version < 2) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_messages (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS chat_messages_by_chat ON chat_messages (chat_id, seq);
        PRAGMA user_version = 2;
      `);
    }
    if (version < 3) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, state BLOB NOT NULL);
        PRAGMA user_version = 3;
      `);
    }
    if (version < 4) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS usage (key TEXT PRIMARY KEY, data TEXT NOT NULL);
        PRAGMA user_version = 4;
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

  async loadAccess(): Promise<SessionAccess | null> {
    return this.getMeta('access', AccessRecord);
  }

  async saveAccess(access: SessionAccess) {
    this.setMeta('access', access);
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

  async listAgents() {
    return this.all('SELECT data FROM agents', AgentProfile);
  }

  async saveAgent(agent: AgentProfile) {
    this.db
      .prepare('INSERT INTO agents (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(agent.id, JSON.stringify(agent));
  }

  async deleteAgent(agentId: string) {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
  }

  async listChats() {
    return this.all('SELECT data FROM chats', ChatInfo);
  }

  async saveChat(chat: ChatInfo) {
    this.db
      .prepare('INSERT INTO chats (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(chat.id, JSON.stringify(chat));
  }

  async deleteChat(chatId: string) {
    this.db.prepare('DELETE FROM chat_messages WHERE chat_id = ?').run(chatId);
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
  }

  async listChatMessages(chatId: string, limit = 500) {
    return this.all(
      'SELECT data FROM (SELECT seq, data FROM chat_messages WHERE chat_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq',
      ChatMessage,
      chatId,
      limit,
    );
  }

  async saveChatMessage(message: ChatMessage) {
    // A message keeps its place (seq) when it is updated.
    this.db
      .prepare(
        `INSERT INTO chat_messages (id, chat_id, seq, data)
         VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_messages), ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      )
      .run(message.id, message.chatId, JSON.stringify(message));
  }

  async loadDocs() {
    const rows = this.db.prepare('SELECT id, state FROM docs').all() as { id: string; state: Uint8Array }[];
    const out: Partial<Record<DocId, Uint8Array>> = {};
    for (const row of rows) {
      const id = DocId.safeParse(row.id);
      if (id.success) out[id.data] = new Uint8Array(row.state);
    }
    return out;
  }

  async saveDoc(docId: DocId, state: Uint8Array) {
    this.db
      .prepare('INSERT INTO docs (id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state')
      .run(docId, state);
  }

  async loadBloat() {
    return this.getMeta('bloat', BloatReport);
  }

  async saveBloat(report: BloatReport) {
    this.setMeta('bloat', report);
  }

  async listUsage() {
    return this.all('SELECT data FROM usage', UsageRow);
  }

  async saveUsage(row: UsageRow) {
    this.db
      .prepare('INSERT INTO usage (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data')
      .run(usageKey(row), JSON.stringify(row));
  }

  async loadPrices() {
    return this.getMeta('prices', PriceTable);
  }

  async savePrices(prices: PriceTable) {
    this.setMeta('prices', prices);
  }

  async appendActivity(entry: Activity) {
    this.db.prepare('INSERT INTO activity (data) VALUES (?)').run(JSON.stringify(entry));
  }

  async listActivity(limit = 100) {
    return this.all('SELECT data FROM (SELECT seq, data FROM activity ORDER BY seq DESC LIMIT ?) ORDER BY seq', Activity, limit);
  }

  /**
   * Writes a copy of the database to `file`, safely while the server runs
   * (VACUUM INTO reads one consistent snapshot). Refuses when the database
   * is damaged, so a bad file never replaces a good backup.
   */
  async backup(file: string) {
    checkIntegrity(this.db);
    mkdirSync(dirname(file), { recursive: true });
    const partial = `${file}.partial`;
    rmSync(partial, { force: true });
    try {
      this.db.prepare('VACUUM INTO ?').run(partial);
      renameSync(partial, file);
    } catch (error) {
      rmSync(partial, { force: true });
      throw error;
    }
  }

  async close() {
    if (!this.open) return;
    this.open = false;
    this.db.close();
  }
}

function checkIntegrity(db: DatabaseSync) {
  const rows = db.prepare('PRAGMA quick_check').all() as Record<string, unknown>[];
  const result = rows.map((row) => String(Object.values(row)[0])).join('; ');
  if (result !== 'ok') throw new Error(`The session database is damaged (${result.slice(0, 200)}).`);
}

/**
 * Opens a backup read-only and checks it: intact, made by a version this app
 * can read, and holding a session. Returns that session.
 */
export function inspectBackup(file: string): SessionInfo {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    checkIntegrity(db);
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version > SCHEMA_VERSION) throw new Error('That backup was made by a newer version of the app. Update the app first.');
    const row = db.prepare("SELECT value FROM meta WHERE key = 'session'").get() as { value: string } | undefined;
    const session = row ? parseJson(row.value, SessionInfo) : null;
    if (!session) throw new Error('That backup holds no session.');
    return session;
  } finally {
    db.close();
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

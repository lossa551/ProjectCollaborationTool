import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The sessions you hosted or joined on this PC, for the "Resume a session"
// list on the start screen. Each hosted session has its own SQLite file, so
// hosting a new one never replaces the last. Joined sessions keep their
// invite code. The file holds invite codes, which are credentials, so like
// the session cache it stays readable only by you.

export type SessionRole = 'host' | 'join';

export interface SavedSession {
  /** Local key: the hosted session's file name, or a hash of the joined server's address. */
  key: string;
  role: SessionRole;
  /** The session's id once known; it ties the entry to your project folder. */
  sessionId: string | null;
  name: string;
  /** The last invite code: the one you joined with, or the one you shared as host. */
  invite: string | null;
  /** The linked GitHub repository, as owner/name. */
  repo: string | null;
  lastUsedAt: number;
}

/** The single hosted session file used before sessions were listed. */
export const LEGACY_HOST_KEY = 'legacy';

/** Joined sessions kept; hosted sessions hold real work and are only removed when you forget them. */
const MAX_JOINED = 20;

export class SessionHistory {
  private sessions: SavedSession[];

  constructor(private readonly dir: string) {
    this.sessions = this.read();
  }

  private get file() {
    return join(this.dir, 'sessions.json');
  }

  private read(): SavedSession[] {
    try {
      const data: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(data) ? data.filter(isSavedSession) : [];
    } catch {
      return [];
    }
  }

  private write() {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.sessions, null, 2), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  /** Most recently used first. */
  list(): SavedSession[] {
    return [...this.sessions].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  get(key: string): SavedSession | null {
    return this.sessions.find((s) => s.key === key) ?? null;
  }

  /** Where a hosted session is saved. */
  hostFile(key: string): string {
    return key === LEGACY_HOST_KEY ? join(this.dir, 'hosted-session.sqlite') : join(this.dir, 'hosted', `${key}.sqlite`);
  }

  /** A key for a new hosted session; it is listed once save() is called. */
  newHostKey(): string {
    return randomUUID();
  }

  /** The key of a joined session, from its server address. */
  joinKey(url: string): string {
    return `join-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`;
  }

  /** Adds or updates an entry and marks it as just used. */
  save(entry: Omit<SavedSession, 'lastUsedAt'> & { lastUsedAt?: number }) {
    const saved: SavedSession = { ...entry, lastUsedAt: entry.lastUsedAt ?? Date.now() };
    this.sessions = [saved, ...this.sessions.filter((s) => s.key !== saved.key)];
    this.dedupe(saved);
    this.trim();
    this.write();
  }

  /** Changes details (name, repo, session id) without marking it as used. */
  update(key: string, changes: Partial<Pick<SavedSession, 'sessionId' | 'name' | 'invite' | 'repo'>>) {
    const current = this.get(key);
    if (!current) return;
    const next = { ...current, ...changes };
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    this.sessions = this.sessions.map((s) => (s.key === key ? next : s));
    this.dedupe(next);
    this.write();
  }

  /** Removes the entry, and a hosted session's saved board with it. */
  forget(key: string) {
    const entry = this.get(key);
    if (!entry) return;
    if (entry.role === 'host') removeDatabase(this.hostFile(key));
    this.sessions = this.sessions.filter((s) => s.key !== key);
    this.write();
  }

  /**
   * Lists the hosted session saved before this list existed, so it shows up
   * to resume. Its name comes from its database, read by the caller.
   */
  adoptLegacyHost(read: (file: string) => Promise<{ id: string; name: string } | null>): Promise<boolean> {
    const file = this.hostFile(LEGACY_HOST_KEY);
    if (this.get(LEGACY_HOST_KEY) || !existsSync(file)) return Promise.resolve(false);
    return read(file).then(
      (session) => {
        if (!session || this.get(LEGACY_HOST_KEY)) return false;
        this.save({ key: LEGACY_HOST_KEY, role: 'host', sessionId: session.id, name: session.name, invite: null, repo: null, lastUsedAt: 0 });
        return true;
      },
      () => false,
    );
  }

  /**
   * A joined session reached through a new address (a new invite) replaces
   * the older entry for it. Your own hosted sessions are never touched.
   */
  private dedupe(entry: SavedSession) {
    if (entry.role !== 'join' || !entry.sessionId) return;
    this.sessions = this.sessions.filter((s) => s === entry || s.role !== 'join' || s.sessionId !== entry.sessionId);
  }

  private trim() {
    const extra = new Set(this.list().filter((s) => s.role === 'join').slice(MAX_JOINED).map((s) => s.key));
    if (extra.size) this.sessions = this.sessions.filter((s) => !extra.has(s.key));
  }
}

function removeDatabase(file: string) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
}

function isSavedSession(value: unknown): value is SavedSession {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.key === 'string' &&
    /^[\w-]{1,80}$/.test(s.key) &&
    (s.role === 'host' || s.role === 'join') &&
    (s.sessionId === null || typeof s.sessionId === 'string') &&
    typeof s.name === 'string' &&
    (s.invite === null || typeof s.invite === 'string') &&
    (s.repo === null || typeof s.repo === 'string') &&
    typeof s.lastUsedAt === 'number'
  );
}

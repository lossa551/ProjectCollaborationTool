import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupInfo } from '../common/api';

// Backups of hosted sessions. The board, planning space, project memory,
// chats and activity live only in the host's SQLite file, so a copy is made
// on host start and once a day while hosting, and the newest few are kept.
// Each session has its own folder of backups, named by its key; a backup is
// named by its day, so there is at most one a day. Restoring first saves the
// current state as a backup too, so a restore can itself be undone.
// Snapshots are made by hand (say, before a big change), carry a label and
// are never deleted automatically.

/** What a backup is written from: the open session database. */
export interface BackupSource {
  backup(file: string): Promise<void>;
}

/** Daily backups kept per session. */
export const KEEP_DAILY = 7;
/** Copies made before a restore, kept per session. */
const KEEP_BEFORE_RESTORE = 3;

const DAILY = /^(\d{4}-\d{2}-\d{2})\.sqlite$/;
const BEFORE_RESTORE = /^(\d{4}-\d{2}-\d{2})-(\d{4})-before-restore\.sqlite$/;
const SNAPSHOT = /^(\d{4}-\d{2}-\d{2})-(\d{6})-snapshot\.sqlite$/;

/** What is kept next to a snapshot. */
interface SnapshotNote {
  label: string;
  /** The git tag made on your project folder's commit at the same time. */
  tag: string | null;
}

const kindOf = (name: string): BackupInfo['kind'] | null =>
  DAILY.test(name) ? 'daily' : BEFORE_RESTORE.test(name) ? 'before-restore' : SNAPSHOT.test(name) ? 'snapshot' : null;

function readNote(file: string): SnapshotNote | null {
  try {
    const data = JSON.parse(readFileSync(file.replace(/\.sqlite$/, '.json'), 'utf8')) as Partial<SnapshotNote>;
    return { label: typeof data.label === 'string' ? data.label : '', tag: typeof data.tag === 'string' ? data.tag : null };
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The local day, as the backup's name. */
export const dayName = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

export class SessionBackups {
  /**
   * @param folders Where backups go: the first is written to; the others
   *   (say, the default folder after a custom one was chosen) are still
   *   listed so older backups can be restored.
   */
  constructor(private readonly folders: () => string[]) {}

  private dir(key: string, folder = this.folders()[0]!) {
    return join(folder, key);
  }

  /** Every backup of a session, newest first. */
  list(key: string): BackupInfo[] {
    const seen = new Set<string>();
    const out: BackupInfo[] = [];
    for (const folder of this.folders()) {
      const dir = this.dir(key, folder);
      if (seen.has(dir)) continue;
      seen.add(dir);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const kind = kindOf(name);
        if (!kind) continue;
        try {
          const path = join(dir, name);
          const stat = statSync(path);
          const note = kind === 'snapshot' ? readNote(path) : null;
          out.push({ name, kind, path, madeAt: stat.mtimeMs, bytes: stat.size, label: note?.label || null, tag: note?.tag ?? null });
        } catch {
          // Removed meanwhile.
        }
      }
    }
    return out.sort((a, b) => b.madeAt - a.madeAt);
  }

  /** Makes today's backup unless there is one already; returns its path, or null when it existed. */
  async daily(key: string, source: BackupSource, now = new Date()): Promise<string | null> {
    const dir = this.dir(key);
    const file = join(dir, `${dayName(now)}.sqlite`);
    if (existsSync(file)) return null;
    mkdirSync(dir, { recursive: true });
    await source.backup(file);
    this.prune(dir);
    return file;
  }

  /** Makes a snapshot with a label; it is kept until you delete it. Returns its path. */
  async snapshot(key: string, source: BackupSource, label: string, tag: string | null, now = new Date()): Promise<string> {
    const dir = this.dir(key);
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const file = join(dir, `${dayName(now)}-${time}-snapshot.sqlite`);
    if (existsSync(file)) throw new Error('A snapshot was just made. Wait a second and try again.');
    mkdirSync(dir, { recursive: true });
    await source.backup(file);
    writeFileSync(file.replace(/\.sqlite$/, '.json'), JSON.stringify({ label, tag } satisfies SnapshotNote, null, 2));
    return file;
  }

  /** Deletes a snapshot you made. */
  deleteSnapshot(key: string, path: string) {
    const snapshot = this.list(key).find((b) => b.path === path && b.kind === 'snapshot');
    if (!snapshot) throw new Error('That snapshot is no longer there.');
    rmSync(snapshot.path, { force: true });
    rmSync(snapshot.path.replace(/\.sqlite$/, '.json'), { force: true });
  }

  /**
   * Replaces the session database with a backup. The database must not be in
   * use. The current one is saved as a backup first.
   */
  restore(key: string, backupPath: string, database: string, saveCurrent: (file: string) => Promise<void>, now = new Date()): Promise<void> {
    const backup = this.list(key).find((b) => b.path === backupPath);
    if (!backup) return Promise.reject(new Error('That backup is no longer there.'));
    const dir = this.dir(key);
    const before = join(dir, `${dayName(now)}-${pad(now.getHours())}${pad(now.getMinutes())}-before-restore.sqlite`);
    const save = existsSync(database) ? saveCurrent(before) : Promise.resolve();
    return save.then(() => {
      const partial = `${database}.restoring`;
      copyFileSync(backup.path, partial);
      for (const suffix of ['-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
      renameSync(partial, database);
      this.prune(dir);
    });
  }

  /** Keeps the newest daily backups and copies made before a restore; deletes the rest. Snapshots stay. */
  private prune(dir: string) {
    mkdirSync(dir, { recursive: true });
    const names = readdirSync(dir).sort().reverse();
    const daily = names.filter((n) => DAILY.test(n)).slice(KEEP_DAILY);
    const before = names.filter((n) => BEFORE_RESTORE.test(n)).slice(KEEP_BEFORE_RESTORE);
    for (const name of [...daily, ...before]) rmSync(join(dir, name), { force: true });
  }
}

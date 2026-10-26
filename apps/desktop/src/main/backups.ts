import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupInfo } from '../common/api';

// Backups of hosted sessions. The board, planning space, project memory,
// chats and activity live only in the host's SQLite file, so a copy is made
// on host start and once a day while hosting, and the newest few are kept.
// Each session has its own folder of backups, named by its key; a backup is
// named by its day, so there is at most one a day. Restoring first saves the
// current state as a backup too, so a restore can itself be undone.

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
        const kind = DAILY.test(name) ? 'daily' : BEFORE_RESTORE.test(name) ? 'before-restore' : null;
        if (!kind) continue;
        try {
          const stat = statSync(join(dir, name));
          out.push({ name, kind, path: join(dir, name), madeAt: stat.mtimeMs, bytes: stat.size });
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

  /** Keeps the newest daily backups and copies made before a restore; deletes the rest. */
  private prune(dir: string) {
    mkdirSync(dir, { recursive: true });
    const names = readdirSync(dir).sort().reverse();
    const daily = names.filter((n) => DAILY.test(n)).slice(KEEP_DAILY);
    const before = names.filter((n) => BEFORE_RESTORE.test(n)).slice(KEEP_BEFORE_RESTORE);
    for (const name of [...daily, ...before]) rmSync(join(dir, name), { force: true });
  }
}

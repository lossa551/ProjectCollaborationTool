import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStorage, inspectBackup } from '@pct/server';
import type { Lock, Task } from '@pct/shared';

const dirs: string[] = [];
function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'pct-'));
  dirs.push(dir);
  return join(dir, 'nested', 'session.sqlite');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const task: Task = {
  id: 't1',
  title: 'Player movement',
  stage: 'implementing',
  owner: { id: 'm', name: 'Martin', kind: 'human' },
  scope: ['scripts/player/**'],
  readFirst: [],
  branch: null,
  featureId: null,
  criteria: [],
  budget: null,
  createdAt: 1,
  updatedAt: 2,
  version: 3,
};
const lock: Lock = {
  id: 'l1',
  path: 'art/hero.png',
  kind: 'exclusive',
  holder: { id: 'm', name: 'Martin', kind: 'human' },
  taskId: 't1',
  chatId: null,
  reason: null,
  acquiredAt: 1,
  heartbeatAt: 2,
  abandoned: false,
};

describe('SqliteStorage', () => {
  it('keeps everything across reopening the file', async () => {
    const path = tempDb();
    const first = new SqliteStorage(path);
    await first.saveSession({ id: 's', name: 'Godot jam', createdAt: 1 });
    await first.saveSecret('secret');
    await first.saveTask(task);
    await first.saveTask({ ...task, id: 't2', title: 'Gone' });
    await first.deleteTask('t2');
    await first.saveLock(lock);
    await first.saveLockRules({ exclusivePatterns: ['*.tscn'] });
    await first.saveIdentity('hash', { id: 'm', name: 'Martin', kind: 'human', createdAt: 1, lastSeenAt: 2 });
    for (let i = 0; i < 5; i++) {
      await first.appendActivity({ id: `a${i}`, at: i, actorName: 'Martin', text: `did ${i}`, taskId: null });
    }
    await first.close();

    const second = new SqliteStorage(path);
    expect(await second.loadSession()).toEqual({ id: 's', name: 'Godot jam', createdAt: 1 });
    expect(await second.loadSecret()).toBe('secret');
    expect(await second.listTasks()).toEqual([task]);
    expect(await second.listLocks()).toEqual([lock]);
    expect(await second.loadLockRules()).toEqual({ exclusivePatterns: ['*.tscn'] });
    expect(await second.findIdentity('hash')).toMatchObject({ id: 'm', name: 'Martin' });
    expect(await second.findIdentity('other')).toBeNull();
    expect((await second.listActivity(3)).map((a) => a.text)).toEqual(['did 2', 'did 3', 'did 4']);
    await second.close();
  });

  it('keeps shared documents and the bloat check', async () => {
    const path = tempDb();
    const first = new SqliteStorage(path);
    await first.saveDoc('memory', new Uint8Array([1, 2, 3]));
    await first.saveDoc('memory', new Uint8Array([4, 5]));
    await first.saveBloat({
      ranBy: 'Martin',
      ranAt: 1,
      branch: 'main',
      scanned: 3,
      truncated: false,
      duplicates: [],
      unusedAssets: ['art/old.png'],
      unusedGameFiles: [],
      unusedDependencies: [],
      folderNotes: [],
    });
    await first.close();

    const second = new SqliteStorage(path);
    expect(await second.loadDocs()).toEqual({ memory: new Uint8Array([4, 5]) });
    expect((await second.loadBloat())?.unusedAssets).toEqual(['art/old.png']);
    await second.close();
  });

  it('starts empty', async () => {
    const storage = new SqliteStorage(':memory:');
    expect(await storage.loadSession()).toBeNull();
    expect(await storage.loadSecret()).toBeNull();
    expect(await storage.loadLockRules()).toBeNull();
    expect(await storage.listTasks()).toEqual([]);
    await storage.close();
    await storage.close();
  });

  it('backs up while open, and the copy holds everything', async () => {
    const path = tempDb();
    const live = new SqliteStorage(path);
    await live.saveSession({ id: 's', name: 'Godot jam', createdAt: 1 });
    await live.saveTask(task);
    await live.saveDoc('memory', new Uint8Array([7, 8]));
    const copy = join(path, '..', 'backups', 'one.sqlite');
    await live.backup(copy);
    // Still usable after the backup.
    await live.saveTask({ ...task, id: 't2' });
    await live.close();

    expect(inspectBackup(copy)).toEqual({ id: 's', name: 'Godot jam', createdAt: 1 });
    expect(existsSync(`${copy}.partial`)).toBe(false);
    const restored = new SqliteStorage(copy);
    expect(await restored.listTasks()).toEqual([task]);
    expect((await restored.loadDocs()).memory).toEqual(new Uint8Array([7, 8]));
    await restored.close();
  });

  it('refuses a backup that is not a session database', async () => {
    const path = tempDb();
    const empty = new SqliteStorage(path);
    await empty.close();
    expect(() => inspectBackup(path)).toThrow(/no session/);
    const junk = join(path, '..', 'junk.sqlite');
    writeFileSync(junk, 'not a database at all, just some text that is long enough');
    expect(() => inspectBackup(junk)).toThrow();
  });
});

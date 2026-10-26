import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStorage } from '@pct/server';
import { Y, applyMemoryOp, readMemory, type Task } from '@pct/shared';
import { KEEP_DAILY, SessionBackups, dayName } from '../src/main/backups';
import { writeMemoryFile } from '../src/main/memory-export';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'pct-backups-'));
  dirs.push(dir);
  return dir;
}

const task = (id: string, title: string): Task => ({
  id,
  title,
  stage: 'planning',
  owner: null,
  scope: [],
  readFirst: [],
  branch: null,
  featureId: null,
  criteria: [],
  createdAt: 1,
  updatedAt: 1,
  version: 1,
});

function memoryState(titles: string[]) {
  const doc = new Y.Doc();
  titles.forEach((title, i) => applyMemoryOp(doc, { op: 'create', id: `entry-${i}-0000`, kind: 'decision', title }, 'Martin', i));
  return Y.encodeStateAsUpdate(doc);
}

async function readBack(file: string) {
  const storage = new SqliteStorage(file);
  try {
    const doc = new Y.Doc();
    const memory = (await storage.loadDocs()).memory;
    if (memory) Y.applyUpdate(doc, memory);
    return { tasks: (await storage.listTasks()).map((t) => t.title), memory: readMemory(doc).map((e) => e.title) };
  } finally {
    await storage.close();
  }
}

describe('SessionBackups', () => {
  it('makes one backup a day and keeps the newest ones', async () => {
    const root = folder();
    const backups = new SessionBackups(() => [root]);
    const source = { backup: async (file: string) => writeFileSync(file, 'db') };
    for (let day = 1; day <= KEEP_DAILY + 3; day++) {
      expect(await backups.daily('key', source, new Date(2026, 9, day, 9))).not.toBeNull();
    }
    expect(await backups.daily('key', source, new Date(2026, 9, KEEP_DAILY + 3, 18))).toBeNull();
    const names = readdirSync(join(root, 'key')).sort();
    expect(names).toHaveLength(KEEP_DAILY);
    expect(names[0]).toBe(`${dayName(new Date(2026, 9, 4))}.sqlite`);
    expect(names.at(-1)).toBe('2026-10-10.sqlite');
  });

  it('restores the board and memory as they were, and keeps what it replaced', async () => {
    const root = folder();
    const database = join(root, 'hosted', 'key.sqlite');
    const backups = new SessionBackups(() => [join(root, 'custom'), join(root, 'backups')]);

    const live = new SqliteStorage(database);
    await live.saveSession({ id: 's1', name: 'Game', createdAt: 1 });
    await live.saveTask(task('t1', 'Player movement'));
    await live.saveDoc('memory', memoryState(['Use Godot 4']));
    await backups.daily('key', live, new Date(2026, 9, 25, 9));
    // Later that week the board and memory change.
    await live.deleteTask('t1');
    await live.saveTask(task('t2', 'Inventory'));
    await live.saveDoc('memory', memoryState(['Use Godot 4', 'Wrong turn']));
    await live.close();

    const [backup] = backups.list('key');
    expect(backup).toMatchObject({ name: '2026-10-25.sqlite', kind: 'daily' });
    await backups.restore('key', backup!.path, database, async (file) => {
      const current = new SqliteStorage(database);
      await current.backup(file);
      await current.close();
    }, new Date(2026, 9, 26, 15, 30));

    expect(await readBack(database)).toEqual({ tasks: ['Player movement'], memory: ['Use Godot 4'] });
    const saved = backups.list('key').find((b) => b.kind === 'before-restore');
    expect(saved?.name).toBe('2026-10-26-1530-before-restore.sqlite');
    expect(await readBack(saved!.path)).toEqual({ tasks: ['Inventory'], memory: ['Use Godot 4', 'Wrong turn'] });
  });

  it('lists backups from every folder, newest first, and only its own files', () => {
    const root = folder();
    const backups = new SessionBackups(() => [join(root, 'a'), join(root, 'b')]);
    for (const [dir, name, at] of [['a', '2026-10-20.sqlite', 2], ['b', '2026-10-19.sqlite', 1], ['b', 'notes.txt', 3]] as const) {
      const file = join(root, dir, 'key', name);
      rmSync(file, { force: true });
      mkdirSync(join(root, dir, 'key'), { recursive: true });
      writeFileSync(file, 'x');
      utimesSync(file, at * 1000, at * 1000);
    }
    expect(backups.list('key').map((b) => b.name)).toEqual(['2026-10-20.sqlite', '2026-10-19.sqlite']);
    expect(backups.list('other')).toEqual([]);
  });

  it('refuses to restore a file that is not one of the backups', async () => {
    const root = folder();
    const backups = new SessionBackups(() => [root]);
    await expect(backups.restore('key', join(root, 'elsewhere.sqlite'), join(root, 'db.sqlite'), async () => {})).rejects.toThrow(/no longer there/);
  });
});

describe('writeMemoryFile', () => {
  it('writes docs/project-memory.md, and only again when it changes', () => {
    const root = folder();
    const entry = { id: 'e1', kind: 'convention' as const, title: 'Tabs', body: '', createdBy: 'Martin', createdAt: 1, updatedAt: 1, source: null };
    expect(writeMemoryFile(root, [entry])).toBe(true);
    const file = join(root, 'docs', 'project-memory.md');
    expect(readFileSync(file, 'utf8')).toContain('### Tabs');
    expect(writeMemoryFile(root, [entry])).toBe(false);
    // A checkout with Windows line endings still counts as the same.
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
    expect(writeMemoryFile(root, [entry])).toBe(false);
    expect(writeMemoryFile(root, [{ ...entry, title: 'Spaces' }])).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});

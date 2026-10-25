import { afterEach, describe, expect, it } from 'vitest';
import { SessionClient, newIdentity, type SessionState } from '@pct/shared';
import { LockTable, MemoryStorage, startServer, type RunningServer } from '@pct/server';

const martin = { id: 'm', name: 'Martin', kind: 'human' as const };
const friend = { id: 'f', name: 'Friend', kind: 'human' as const };

describe('LockTable', () => {
  it('gives exclusive locks to files matching the rules and soft locks to the rest', () => {
    const table = new LockTable();
    const art = table.acquire('art\\menu.PSD', martin);
    const code = table.acquire('scripts/player.gd', martin);
    expect(art.ok && art.lock).toMatchObject({ path: 'art/menu.PSD', kind: 'exclusive' });
    expect(code.ok && code.lock.kind).toBe('soft');
  });

  it('never grants an exclusive lock twice', () => {
    const table = new LockTable();
    table.acquire('art/menu.psd', martin);
    const second = table.acquire('ART/menu.psd', friend);
    expect(second).toMatchObject({ ok: false, code: 'locked', message: 'art/menu.psd is locked by Martin' });
  });

  it('lets soft locks overlap but blocks exclusive on top of them', () => {
    const table = new LockTable();
    table.acquire('scripts/player.gd', martin);
    const overlap = table.acquire('scripts/player.gd', friend);
    expect(overlap.ok && overlap.description).toBe('locked scripts/player.gd, also edited by Martin');
    expect(table.acquire('scripts/player.gd', { ...friend, id: 'x', name: 'X' }, { exclusive: true }).ok).toBe(false);
  });

  it('upgrades your own soft lock to exclusive when nobody else holds the path', () => {
    const table = new LockTable();
    const first = table.acquire('scripts/player.gd', martin);
    const again = table.acquire('scripts/player.gd', martin, { exclusive: true });
    expect(again.ok && again.lock.id).toBe(first.ok && first.lock.id);
    expect(again.ok && again.lock.kind).toBe('exclusive');
    expect(table.list()).toHaveLength(1);
  });

  it('only lets the holder release, and anyone recover once abandoned', () => {
    const table = new LockTable();
    const result = table.acquire('art/menu.psd', martin, {}, 0);
    const id = result.ok ? result.lock.id : '';
    expect(table.release(id, 'f')).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(table.recover(id, 'f')).toMatchObject({ ok: false, code: 'not_allowed' });

    expect(table.sweep(60_000, 30_000)).toHaveLength(0);
    expect(table.sweep(60_000, 61_000).map((l) => l.id)).toEqual([id]);
    expect(table.recover(id, 'f')).toMatchObject({ ok: true, description: 'recovered art/menu.psd from Martin' });
    expect(table.list()).toHaveLength(0);
  });

  it('revives abandoned locks when the holder is seen again', () => {
    const table = new LockTable();
    table.acquire('art/menu.psd', martin, {}, 0);
    table.sweep(1000, 5000);
    expect(table.refresh('m', 6000)).toHaveLength(1);
    expect(table.list()[0]).toMatchObject({ abandoned: false, heartbeatAt: 6000 });
  });

  it('refuses paths outside the project', () => {
    expect(new LockTable().acquire('../x', martin)).toMatchObject({ ok: false, code: 'bad_message' });
  });
});

let server: RunningServer | null = null;
const clients: SessionClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await server?.close();
  server = null;
});

function waitFor(client: SessionClient, check: (state: SessionState) => boolean, timeoutMs = 3000) {
  return new Promise<SessionState>((resolve, reject) => {
    if (check(client.getState())) return resolve(client.getState());
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`timed out; last state: ${JSON.stringify(client.getState())}`));
    }, timeoutMs);
    const stop = client.subscribe((state) => {
      if (!check(state)) return;
      clearTimeout(timer);
      stop();
      resolve(state);
    });
  });
}

async function join(name: string) {
  const client = new SessionClient({ backoff: [50] });
  clients.push(client);
  client.connect({ url: server!.localUrl, secret: server!.secret, name, identity: newIdentity() });
  await waitFor(client, (s) => s.status === 'connected');
  return client;
}

describe('locks in a session', () => {
  it('shares locks and refuses a second exclusive lock', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const a = await join('Martin');
    const b = await join('Friend');

    a.acquireLock('art/hero.png');
    const seen = await waitFor(b, (s) => s.locks.length === 1);
    expect(seen.locks[0]).toMatchObject({ path: 'art/hero.png', kind: 'exclusive', holder: { name: 'Martin' } });

    b.acquireLock('art/hero.png');
    const refused = await waitFor(b, (s) => s.error !== null);
    expect(refused.error).toEqual({ code: 'locked', message: 'art/hero.png is locked by Martin' });

    b.releaseLock(seen.locks[0]!.id);
    await waitFor(b, (s) => s.error?.code === 'not_allowed');

    a.releaseLock(seen.locks[0]!.id);
    await waitFor(b, (s) => s.locks.length === 0);
  });

  it('links locks to tasks and unlinks them when the task is deleted', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const a = await join('Martin');
    a.createTask('Hero sprite');
    const { tasks } = await waitFor(a, (s) => s.tasks.length === 1);
    a.acquireLock('art/hero.png', { taskId: tasks[0]!.id });
    await waitFor(a, (s) => s.locks[0]?.taskId === tasks[0]!.id);
    a.deleteTask(tasks[0]!.id);
    await waitFor(a, (s) => s.tasks.length === 0 && s.locks[0]?.taskId === null);

    a.acquireLock('art/other.png', { taskId: 'missing' });
    await waitFor(a, (s) => s.error?.code === 'not_found');
  });

  it('marks locks abandoned when the holder disappears, and lets others recover them', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', heartbeatMs: 40, lockStaleMs: 150 });
    const a = await join('Martin');
    const b = await join('Friend');
    a.acquireLock('art/hero.png');
    const { locks } = await waitFor(b, (s) => s.locks.length === 1);

    // Still held while Martin is connected.
    await new Promise((r) => setTimeout(r, 300));
    expect(b.getState().locks[0]!.abandoned).toBe(false);

    a.disconnect();
    await waitFor(b, (s) => s.locks[0]?.abandoned === true);
    await waitFor(b, (s) => s.activity.some((e) => e.text === "Martin's lock on art/hero.png was abandoned"));

    b.recoverLock(locks[0]!.id);
    await waitFor(b, (s) => s.locks.length === 0);
    await waitFor(b, (s) => s.activity.some((e) => `${e.actorName} ${e.text}` === 'Friend recovered art/hero.png from Martin'));
  });

  it('applies new lock rules to new locks', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const a = await join('Martin');
    a.setLockRules({ exclusivePatterns: ['*.tscn', ' *.tscn ', 'levels/**'] });
    const { lockRules } = await waitFor(a, (s) => s.lockRules.exclusivePatterns.includes('*.tscn'));
    expect(lockRules.exclusivePatterns).toEqual(['*.tscn', 'levels/**']);
    a.acquireLock('scenes/main.tscn');
    a.acquireLock('art/hero.png');
    const state = await waitFor(a, (s) => s.locks.length === 2);
    expect(state.locks.map((l) => [l.path, l.kind])).toEqual([
      ['scenes/main.tscn', 'exclusive'],
      ['art/hero.png', 'soft'],
    ]);
  });

  it('keeps locks and rules across a restart', async () => {
    const storage = new MemoryStorage();
    server = await startServer({ port: 0, host: '127.0.0.1', storage });
    const { port, secret } = server;
    const a = await join('Martin');
    a.setLockRules({ exclusivePatterns: ['*.tscn'] });
    a.acquireLock('scenes/main.tscn');
    await waitFor(a, (s) => s.locks.length === 1);

    await server.close();
    server = await startServer({ port, host: '127.0.0.1', secret, storage });
    const back = await waitFor(a, (s) => s.status === 'connected');
    expect(back.locks.map((l) => l.path)).toEqual(['scenes/main.tscn']);
    expect(back.lockRules.exclusivePatterns).toEqual(['*.tscn']);
  });
});

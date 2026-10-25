import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionClient, newIdentity, type SessionState } from '@pct/shared';
import { SqliteStorage, startServer, type RunningServer } from '@pct/server';

let server: RunningServer | null = null;
const clients: SessionClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await server?.close();
  server = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

async function join(name: string, identity: string) {
  const client = new SessionClient({ backoff: [50] });
  clients.push(client);
  client.connect({ url: server!.localUrl, secret: server!.secret, name, identity });
  await waitFor(client, (s) => s.status === 'connected');
  return client;
}

function tempDb() {
  const dir = mkdtempSync(joinPath(tmpdir(), 'pct-'));
  dirs.push(dir);
  return joinPath(dir, 'session.sqlite');
}

describe('stable identity', () => {
  it('gives the same participant id after a reconnect, so tasks and locks stay yours', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', heartbeatMs: 40, lockStaleMs: 150 });
    const martinId = newIdentity();
    const watcher = await join('Friend', newIdentity());
    let martin = await join('Martin', martinId);
    const id = martin.getState().you!.id;

    martin.createTask('Hero sprite');
    const { tasks } = await waitFor(martin, (s) => s.tasks.length === 1);
    martin.updateTask(tasks[0]!.id, { ownerId: id });
    martin.acquireLock('art/hero.png', { taskId: tasks[0]!.id });
    await waitFor(watcher, (s) => s.locks.length === 1 && s.tasks[0]?.owner !== null);

    martin.disconnect();
    await waitFor(watcher, (s) => s.locks[0]?.abandoned === true);

    martin = await join('Martin', martinId);
    expect(martin.getState().you!.id).toBe(id);
    const back = await waitFor(watcher, (s) => s.locks[0]?.abandoned === false && s.participants.length === 2);
    expect(back.tasks[0]!.owner?.id).toBe(id);
    expect(back.participants.find((p) => p.name === 'Martin')?.id).toBe(id);

    // Martin can still release his own lock.
    martin.releaseLock(back.locks[0]!.id);
    await waitFor(watcher, (s) => s.locks.length === 0);
  });

  it('keeps people apart even when they use the same name', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const a = await join('Martin', newIdentity());
    const b = await join('Martin', newIdentity());
    expect(a.getState().you!.id).not.toBe(b.getState().you!.id);
    await waitFor(a, (s) => s.participants.length === 2);
  });

  it('replaces the old connection when the same identity joins twice', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const identity = newIdentity();
    const watcher = await join('Friend', newIdentity());
    const first = await join('Martin', identity);
    const second = await join('Martin', identity);

    const old = await waitFor(first, (s) => s.status === 'closed');
    expect(old.error?.code).toBe('replaced');
    expect(second.getState().status).toBe('connected');
    // Martin is still listed once, and stays listed after the old socket closes.
    await new Promise((r) => setTimeout(r, 100));
    expect(watcher.getState().participants.filter((p) => p.name === 'Martin')).toHaveLength(1);
    expect(server.participants()).toHaveLength(2);
  });

  it('keeps the secret, board and identities across a restart with SQLite', async () => {
    const path = tempDb();
    server = await startServer({ port: 0, host: '127.0.0.1', storage: new SqliteStorage(path), sessionName: 'Jam' });
    const { port, secret } = server;
    const identity = newIdentity();
    let martin = await join('Martin', identity);
    const id = martin.getState().you!.id;
    martin.createTask('Main menu');
    martin.acquireLock('art/menu.png');
    await waitFor(martin, (s) => s.tasks.length === 1 && s.locks.length === 1);
    martin.disconnect();
    await server.close();

    server = await startServer({ port, host: '127.0.0.1', storage: new SqliteStorage(path) });
    expect(server.secret).toBe(secret);
    expect(server.session.name).toBe('Jam');
    martin = await join('Martin', identity);
    const state = martin.getState();
    expect(state.you!.id).toBe(id);
    expect(state.tasks.map((t) => t.title)).toEqual(['Main menu']);
    expect(state.locks[0]).toMatchObject({ path: 'art/menu.png', holder: { id } });
    expect(state.activity.some((a) => a.text === 'added "Main menu"')).toBe(true);
  });

  it('renames the session when hosted again under a new name', async () => {
    const path = tempDb();
    server = await startServer({ port: 0, host: '127.0.0.1', storage: new SqliteStorage(path), sessionName: 'Jam' });
    await server.close();
    server = await startServer({ port: 0, host: '127.0.0.1', storage: new SqliteStorage(path), sessionName: 'Jam 2' });
    expect(server.session.name).toBe('Jam 2');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { SessionClient, newIdentity, type SessionState } from '@pct/shared';
import { MemoryStorage, startServer, type RunningServer } from '@pct/server';

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

function makeClient() {
  const client = new SessionClient({ backoff: [50] });
  clients.push(client);
  return client;
}

async function join(name: string, client = makeClient()) {
  client.connect({ url: server!.localUrl, secret: server!.secret, name, identity: newIdentity() });
  await waitFor(client, (s) => s.status === 'connected');
  return client;
}

const titles = (s: SessionState) => s.tasks.map((t) => `${t.title}:${t.stage}`).sort();

describe('offline changes', () => {
  it('keeps editing while the server is down and syncs on reconnect', async () => {
    const storage = new MemoryStorage();
    server = await startServer({ port: 0, host: '127.0.0.1', storage });
    const { port, secret } = server;
    const friend = await join('Friend');
    friend.createTask('Main menu');
    friend.createTask('Old idea');
    const { tasks } = await waitFor(friend, (s) => s.tasks.length === 2);
    const menu = tasks.find((t) => t.title === 'Main menu')!;
    const old = tasks.find((t) => t.title === 'Old idea')!;

    await server.close();
    await waitFor(friend, (s) => s.status === 'reconnecting');
    expect(friend.canEditTasks()).toBe(true);

    friend.createTask('Pause screen', { stage: 'implementing' });
    friend.updateTask(menu.id, { stage: 'review' });
    friend.deleteTask(old.id);
    const offline = friend.getState();
    expect(offline.pending).toBe(3);
    expect(titles(offline)).toEqual(['Main menu:review', 'Pause screen:implementing']);

    server = await startServer({ port, host: '127.0.0.1', secret, storage });
    await waitFor(friend, (s) => s.status === 'connected' && s.pending === 0);
    const synced = await waitFor(friend, (s) => titles(s).join() === 'Main menu:review,Pause screen:implementing');
    expect(synced.tasks.every((t) => t.version >= 1)).toBe(true);

    const martin = await join('Martin');
    expect(titles(martin.getState())).toEqual(['Main menu:review', 'Pause screen:implementing']);
  });

  it('keeps the other person’s change when both moved the same task', async () => {
    const storage = new MemoryStorage();
    server = await startServer({ port: 0, host: '127.0.0.1', storage });
    const { port, secret } = server;
    const friend = await join('Friend');
    friend.createTask('Inventory UI');
    const { tasks } = await waitFor(friend, (s) => s.tasks.length === 1);
    const id = tasks[0]!.id;

    // The friend loses the connection (their own network, not the server).
    const snapshot = friend.getSnapshot()!;
    friend.disconnect();
    const offline = makeClient();
    offline.connect({ url: 'ws://127.0.0.1:1/ws', secret, name: 'Friend', identity: newIdentity() }, snapshot);
    await waitFor(offline, (s) => s.status === 'reconnecting');
    offline.updateTask(id, { stage: 'testing', title: 'Inventory screen' });
    expect(offline.getState().pending).toBe(1);

    // Meanwhile Martin moves it to Review.
    const martin = await join('Martin');
    martin.updateTask(id, { stage: 'review' });
    await waitFor(martin, (s) => s.tasks[0]?.stage === 'review');

    // The friend comes back: the rename goes through, the move does not.
    const back = makeClient();
    back.connect({ url: server.localUrl, secret, name: 'Friend', identity: newIdentity() }, offline.getSnapshot()!);
    offline.disconnect();
    const conflicted = await waitFor(back, (s) => s.error?.code === 'conflict');
    expect(conflicted.error?.message).toBe('Not applied: "Inventory UI" was moved to Review by someone else.');
    const final = await waitFor(martin, (s) => s.tasks[0]?.title === 'Inventory screen');
    expect(final.tasks[0]!.stage).toBe('review');
    await waitFor(back, (s) => s.tasks[0]?.stage === 'review' && s.tasks[0]?.title === 'Inventory screen');
    void port;
  });

  it('does not create a task twice when a create is replayed', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const martin = await join('Martin');
    martin.createTask('Particles');
    const { tasks } = await waitFor(martin, (s) => s.tasks.length === 1);

    // Replaying the same create (as after a dropped connection) is harmless.
    const replay = makeClient();
    const snapshot = { ...martin.getSnapshot()!, queue: [{ type: 'task.create' as const, id: tasks[0]!.id, title: 'Particles' }] };
    replay.connect({ url: server.localUrl, secret: server.secret, name: 'Martin', identity: newIdentity() }, snapshot);
    await waitFor(replay, (s) => s.status === 'connected' && s.pending === 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(martin.getState().tasks).toHaveLength(1);
  });

  it('drops queued changes meant for a different session', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const martin = await join('Martin');
    const snapshot = {
      ...martin.getSnapshot()!,
      session: { id: 'another-session', name: 'Other', createdAt: 0 },
      queue: [{ type: 'task.create' as const, id: 'queued-task-1', title: 'Should not appear' }],
    };
    const client = makeClient();
    client.connect({ url: server.localUrl, secret: server.secret, name: 'Martin', identity: newIdentity() }, snapshot);
    await waitFor(client, (s) => s.status === 'connected');
    await new Promise((r) => setTimeout(r, 100));
    expect(martin.getState().tasks).toHaveLength(0);
  });

  it('keeps trying when the server is not up yet, then joins', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const { port, secret } = server;
    await server.close();
    const client = makeClient();
    client.connect({ url: `ws://127.0.0.1:${port}/ws`, secret, name: 'Friend', identity: newIdentity() });
    await waitFor(client, (s) => s.status === 'reconnecting');
    server = await startServer({ port, host: '127.0.0.1', secret });
    await waitFor(client, (s) => s.status === 'connected');
  });

  it('waits for the server before changing owners', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const martin = await join('Martin');
    martin.createTask('Particles');
    const { tasks } = await waitFor(martin, (s) => s.tasks.length === 1);
    const snapshot = martin.getSnapshot()!;
    const offline = makeClient();
    offline.connect({ url: 'ws://127.0.0.1:1/ws', secret: server.secret, name: 'Martin', identity: newIdentity() }, snapshot);
    await waitFor(offline, (s) => s.status === 'reconnecting');
    offline.updateTask(tasks[0]!.id, { ownerId: 'someone' });
    expect(offline.getState().pending).toBe(0);
  });
});

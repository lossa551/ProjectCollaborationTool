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

async function join(name: string, kind: 'human' | 'agent' = 'human') {
  const client = new SessionClient({ backoff: [50] });
  clients.push(client);
  client.connect({ url: server!.localUrl, secret: server!.secret, name, kind, identity: newIdentity() });
  await waitFor(client, (s) => s.status === 'connected');
  return client;
}

const feed = (state: SessionState) => state.activity.map((a) => `${a.actorName} ${a.text}`);

describe('task board', () => {
  it('syncs created, moved, assigned and deleted tasks to everyone', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const martin = await join('Martin');
    const friend = await join('Friend');

    martin.createTask('Player movement', { scope: ['scripts/player/**'] });
    let seen = await waitFor(friend, (s) => s.tasks.length === 1);
    const task = seen.tasks[0]!;
    expect(task).toMatchObject({ title: 'Player movement', stage: 'planning', owner: null, version: 1 });
    expect(task.scope).toEqual(['scripts/player/**']);

    const friendId = friend.getState().you!.id;
    martin.updateTask(task.id, { stage: 'implementing', ownerId: friendId });
    seen = await waitFor(friend, (s) => s.tasks[0]?.stage === 'implementing');
    expect(seen.tasks[0]!.owner).toEqual({ id: friendId, name: 'Friend', kind: 'human' });
    expect(seen.tasks[0]!.version).toBe(2);

    friend.deleteTask(task.id);
    await waitFor(martin, (s) => s.tasks.length === 0);
    const final = await waitFor(martin, (s) => feed(s).includes('Friend deleted "Player movement"'));
    expect(feed(final)).toEqual(
      expect.arrayContaining([
        'Martin added "Player movement"',
        'Martin moved "Player movement" to Implementing',
        'Martin assigned "Player movement" to Friend',
      ]),
    );
  });

  it('lets agents own tasks', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const martin = await join('Martin');
    const agent = await join('Claude Opus', 'agent');
    martin.createTask('Write the save system');
    const { tasks } = await waitFor(martin, (s) => s.tasks.length === 1);
    martin.updateTask(tasks[0]!.id, { ownerId: agent.getState().you!.id });
    const state = await waitFor(martin, (s) => s.tasks[0]?.owner !== null);
    expect(state.tasks[0]!.owner).toMatchObject({ name: 'Claude Opus', kind: 'agent' });
  });

  it('refuses an owner who is not in the session and updates to unknown tasks', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const martin = await join('Martin');
    martin.createTask('Inventory UI');
    const { tasks } = await waitFor(martin, (s) => s.tasks.length === 1);

    martin.updateTask(tasks[0]!.id, { ownerId: 'nobody' });
    const refused = await waitFor(martin, (s) => s.error !== null);
    expect(refused.error?.code).toBe('not_found');
    expect(refused.tasks[0]!.owner).toBeNull();

    martin.updateTask('missing', { title: 'Nope' });
    await waitFor(martin, (s) => s.error?.message === 'That task no longer exists');
  });

  it('gives late joiners the current board and recent activity', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const martin = await join('Martin');
    martin.createTask('Main menu');
    martin.createTask('Audio mixer', { stage: 'review' });
    await waitFor(martin, (s) => s.tasks.length === 2);

    const friend = await join('Friend');
    const state = friend.getState();
    expect(state.tasks.map((t) => [t.title, t.stage])).toEqual([
      ['Main menu', 'planning'],
      ['Audio mixer', 'review'],
    ]);
    expect(feed(state)).toContain('Martin added "Audio mixer"');
  });

  it('keeps the board across a server restart with the same storage', async () => {
    const storage = new MemoryStorage();
    server = await startServer({ port: 0, host: '127.0.0.1', storage });
    const { port, secret } = server;
    const martin = await join('Martin');
    martin.createTask('Level 1 layout');
    await waitFor(martin, (s) => s.tasks.length === 1);

    await server.close();
    await waitFor(martin, (s) => s.status === 'reconnecting');
    // The board stays visible while the server is away.
    expect(martin.getState().tasks).toHaveLength(1);

    server = await startServer({ port, host: '127.0.0.1', secret, storage });
    const back = await waitFor(martin, (s) => s.status === 'connected');
    expect(back.tasks.map((t) => t.title)).toEqual(['Level 1 layout']);
  });

  it('ignores updates that change nothing', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const martin = await join('Martin');
    martin.createTask('Particles');
    const { tasks } = await waitFor(martin, (s) => s.tasks.length === 1);
    martin.updateTask(tasks[0]!.id, { title: 'Particles', stage: 'planning' });
    martin.updateTask(tasks[0]!.id, { stage: 'testing' });
    const state = await waitFor(martin, (s) => feed(s).includes('Martin moved "Particles" to Testing'));
    expect(state.tasks[0]!.version).toBe(2);
    expect(feed(state)).toEqual([
      'Martin joined the session',
      'Martin added "Particles"',
      'Martin moved "Particles" to Testing',
    ]);
  });
});

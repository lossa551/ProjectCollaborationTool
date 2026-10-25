import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, SessionClient, newIdentity, type SessionState } from '@pct/shared';
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

function join(name: string, secret = server!.secret, kind: 'human' | 'agent' = 'human') {
  const client = new SessionClient({ backoff: [50] });
  clients.push(client);
  client.connect({ url: server!.localUrl, secret, name, kind, identity: newIdentity() });
  return client;
}

describe('session server', () => {
  it('lets two people join and see each other', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', sessionName: 'Test' });
    const martin = join('Martin');
    const martinState = await waitFor(martin, (s) => s.status === 'connected');
    expect(martinState.session?.name).toBe('Test');
    expect(martinState.participants.map((p) => p.name)).toEqual(['Martin']);

    const friend = join('Friend');
    const friendState = await waitFor(friend, (s) => s.status === 'connected');
    expect(friendState.participants.map((p) => p.name).sort()).toEqual(['Friend', 'Martin']);
    await waitFor(martin, (s) => s.participants.length === 2);
    expect(server.participants()).toHaveLength(2);
  });

  it('shows agents as participants too', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const martin = join('Martin');
    await waitFor(martin, (s) => s.status === 'connected');
    join('Claude Opus', server.secret, 'agent');
    const state = await waitFor(martin, (s) => s.participants.length === 2);
    expect(state.participants.find((p) => p.name === 'Claude Opus')?.kind).toBe('agent');
  });

  it('relays presence updates and departures', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const martin = join('Martin');
    const friend = join('Friend');
    await waitFor(martin, (s) => s.participants.length === 2);
    await waitFor(friend, (s) => s.participants.length === 2);

    friend.setPresence('idle', 'task:42');
    const updated = await waitFor(martin, (s) => s.participants.some((p) => p.focus === 'task:42'));
    expect(updated.participants.find((p) => p.name === 'Friend')?.status).toBe('idle');

    friend.disconnect();
    await waitFor(martin, (s) => s.participants.length === 1);
  });

  it('refuses a wrong secret without retrying', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const intruder = join('Intruder', 'wrong');
    const state = await waitFor(intruder, (s) => s.status === 'closed');
    expect(state.error?.code).toBe('bad_secret');
    expect(server.participants()).toHaveLength(0);
  });

  it('reconnects after the server restarts', async () => {
    const storage = new MemoryStorage();
    server = await startServer({ port: 0, host: '127.0.0.1', storage });
    const { port, secret } = server;
    const martin = join('Martin');
    const first = await waitFor(martin, (s) => s.status === 'connected');

    await server.close();
    await waitFor(martin, (s) => s.status === 'reconnecting');

    server = await startServer({ port, host: '127.0.0.1', secret, storage });
    const second = await waitFor(martin, (s) => s.status === 'connected');
    expect(second.session?.id).toBe(first.session?.id);
  });

  it('logs joins and leaves', async () => {
    const storage = new MemoryStorage();
    server = await startServer({ port: 0, host: '127.0.0.1', storage });
    const martin = join('Martin');
    await waitFor(martin, (s) => s.status === 'connected');
    martin.disconnect();
    await expect.poll(async () => (await storage.listActivity()).map((e) => `${e.actorName} ${e.text}`)).toEqual([
      'Martin joined the session',
      'Martin left the session',
    ]);
  });

  it('answers health checks', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', sessionName: 'Health' });
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(await res.json()).toEqual({ ok: true, protocol: PROTOCOL_VERSION, session: 'Health' });
  });
});

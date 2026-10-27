import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPROVALS, SessionClient, newIdentity, type SessionState } from '@pct/shared';
import { SqliteStorage, startServer, type RunningServer } from '@pct/server';

// New invite codes and removing someone from a session (issue #36).

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

/** Connects and waits until it is in, or turned away. */
async function connect(name: string, identity: string, secret: string, agent?: { profileId: string; startedBy: string; startedById?: string }) {
  const client = new SessionClient({ backoff: [50] });
  clients.push(client);
  /** The secrets the server sent, as the app saves them for Rejoin. */
  const saved: string[] = [];
  client.onMessage((m) => {
    if (m.type === 'session.secret') saved.push(m.secret);
  });
  client.connect({ url: server!.localUrl, secret, name, identity, ...(agent && { kind: 'agent', agent }) });
  await waitFor(client, (s) => s.status === 'connected' || s.status === 'closed');
  return { client, saved };
}

describe('new invite code', () => {
  it('refuses the old code for newcomers but keeps everyone who joined before', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const oldSecret = server.secret;
    const { client: martin } = await connect('Martin', newIdentity(), oldSecret);
    const friendId = newIdentity();
    const { client: friend, saved } = await connect('Friend', friendId, oldSecret);
    const offlineId = newIdentity();
    const { client: offline } = await connect('Sam', offlineId, oldSecret);
    offline.disconnect();

    const secret = await server.newSecret('Martin');
    expect(secret).not.toBe(oldSecret);
    expect(server.secret).toBe(secret);

    // Connected people get the new secret and stay connected.
    await waitFor(friend, () => saved.length === 1);
    expect(saved[0]).toBe(secret);
    expect(friend.getState().status).toBe('connected');
    await waitFor(martin, (s) => s.activity.some((a) => a.text.startsWith('made a new invite code')));

    // Someone holding only the old code is refused, with a clear message.
    const { client: stranger } = await connect('Stranger', newIdentity(), oldSecret);
    expect(stranger.getState().status).toBe('closed');
    expect(stranger.getState().error?.message).toMatch(/replaced by a new one/);

    // The friend's saved Rejoin (now carrying the new secret) still works.
    friend.disconnect();
    const { client: back } = await connect('Friend', friendId, saved[0]!);
    expect(back.getState().status).toBe('connected');

    // Someone offline when the code changed still gets back in with their old one, and is sent the new one.
    const { client: sam, saved: samSaved } = await connect('Sam', offlineId, oldSecret);
    expect(sam.getState().status).toBe('connected');
    await waitFor(sam, () => samSaved.length === 1);
    expect(samSaved[0]).toBe(secret);
  });

  it('keeps the new code and the refusals across a restart', async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'pct-'));
    dirs.push(dir);
    const path = joinPath(dir, 'session.sqlite');
    server = await startServer({ port: 0, host: '127.0.0.1', storage: new SqliteStorage(path) });
    const oldSecret = server.secret;
    const friendId = newIdentity();
    const { client: friend } = await connect('Friend', friendId, oldSecret);
    friend.disconnect();
    const secret = await server.newSecret(null);
    const port = server.port;
    await server.close();

    server = await startServer({ port, host: '127.0.0.1', storage: new SqliteStorage(path) });
    expect(server.secret).toBe(secret);
    const { client: stranger } = await connect('Stranger', newIdentity(), oldSecret);
    expect(stranger.getState().error?.code).toBe('bad_secret');
    const { client: back } = await connect('Friend', friendId, oldSecret);
    expect(back.getState().status).toBe('connected');
  });
});

describe('remove from session', () => {
  it('disconnects them and their agents, frees their locks and refuses their saved invite', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const secret = server.secret;
    const { client: martin } = await connect('Martin', newIdentity(), secret);
    const friendId = newIdentity();
    const { client: friend } = await connect('Friend', friendId, secret);
    const friendParticipant = friend.getState().you!.id;
    friend.acquireLock('art/hero.png');
    await waitFor(martin, (s) => s.locks.length === 1);
    // An agent running on the friend's PC.
    martin.saveAgent({
      name: 'Builder',
      connection: { type: 'cli', tool: 'claude-code', model: null },
      responsibilities: 'Builds things',
      allowedPaths: [],
      approvals: DEFAULT_APPROVALS,
    });
    const { agents } = await waitFor(martin, (s) => s.agents.length === 1);
    const { client: agent } = await connect('Builder', newIdentity(), secret, {
      profileId: agents[0]!.id,
      startedBy: 'Friend',
      startedById: friendParticipant,
    });
    expect(agent.getState().status).toBe('connected');

    const result = await server.removeParticipant(friendParticipant, 'Martin');
    expect(result).toEqual({ ok: true, name: 'Friend' });

    const gone = await waitFor(friend, (s) => s.status === 'closed');
    expect(gone.error?.code).toBe('removed');
    expect((await waitFor(agent, (s) => s.status === 'closed')).error?.code).toBe('removed');
    const after = await waitFor(martin, (s) => s.locks.length === 0 && s.participants.length === 1);
    const texts = after.activity.map((a) => a.text);
    expect(texts).toContain('removed Friend from the session');
    expect(texts).toContain("Friend's lock on art/hero.png was freed because they were removed from the session");
    expect(texts.filter((t) => t === 'left the session')).toHaveLength(0);

    // The saved invite no longer gets them in, nor an agent they start.
    const { client: retry } = await connect('Friend', friendId, secret);
    expect(retry.getState().error?.code).toBe('removed');
    expect(retry.getState().error?.message).toMatch(/new invite code/);
    const { client: agentRetry } = await connect('Builder', newIdentity(), secret, {
      profileId: agents[0]!.id,
      startedBy: 'Friend',
      startedById: friendParticipant,
    });
    expect(agentRetry.getState().error?.code).toBe('removed');

    // A code made after the removal is the host inviting them back; their old one still does not work.
    const fresh = await server.newSecret('Martin');
    const { client: stale } = await connect('Friend', friendId, secret);
    expect(stale.getState().error?.code).toBe('removed');
    const { client: welcome } = await connect('Friend', friendId, fresh);
    expect(welcome.getState().status).toBe('connected');
    expect(welcome.getState().you!.id).toBe(friendParticipant);
  });

  it('only removes people who are connected', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    expect(await server.removeParticipant('nobody', null)).toEqual({ ok: false, message: 'They are not in the session now.' });
  });
});

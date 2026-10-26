import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPROVALS, SessionClient, newIdentity, type SessionState } from '@pct/shared';
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
      reject(new Error(`timed out; last state: ${JSON.stringify(client.getState()).slice(0, 2000)}`));
    }, timeoutMs);
    const stop = client.subscribe((state) => {
      if (!check(state)) return;
      clearTimeout(timer);
      stop();
      resolve(state);
    });
  });
}

async function join(name: string, agent?: { profileId: string; startedBy: string }) {
  const client = new SessionClient({ backoff: [50] });
  clients.push(client);
  client.connect({ url: server!.localUrl, secret: server!.secret, name, kind: agent ? 'agent' : 'human', identity: newIdentity(), agent });
  await waitFor(client, (s) => s.status === 'connected' || s.status === 'closed');
  return client;
}

const builder = {
  name: 'Builder',
  connection: { type: 'cli' as const, tool: 'claude-code' as const, model: null },
  responsibilities: 'Builds things',
  allowedPaths: [],
  approvals: DEFAULT_APPROVALS,
};

describe('agent chats', () => {
  it('shares chats live and keeps them, with their messages, across a restart', async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'pct-'));
    dirs.push(dir);
    const path = joinPath(dir, 'session.sqlite');
    server = await startServer({ port: 0, host: '127.0.0.1', storage: new SqliteStorage(path) });
    const martin = await join('Martin');
    const friend = await join('Friend');
    martin.saveAgent(builder);
    const { agents } = await waitFor(friend, (s) => s.agents.length === 1);
    const chatId = martin.createChat({ agentId: agents[0]!.id, title: 'Menu' });
    await waitFor(friend, (s) => s.chats.length === 1);
    friend.openChat(chatId);
    martin.postChat(chatId, { kind: 'text', text: 'Hello agent' });
    await waitFor(friend, (s) => s.messages[chatId]?.[0]?.text === 'Hello agent');

    // An agent streams by updating its own message; it is stored when finished.
    const agent = await join('Builder', { profileId: agents[0]!.id, startedBy: 'Martin' });
    const id = agent.postChat(chatId, { kind: 'text', text: 'Work', streaming: true });
    agent.postChat(chatId, { id, kind: 'text', text: 'Working on it', streaming: false });
    await waitFor(friend, (s) => s.messages[chatId]?.[1]?.text === 'Working on it');

    // Nobody but the author changes a message; people only post text.
    friend.postChat(chatId, { id, kind: 'text', text: 'hijack' });
    await waitFor(friend, (s) => s.error?.code === 'not_allowed');
    martin.postChat(chatId, { kind: 'tool', text: '', tool: { name: 'x', summary: '', status: 'done', output: '' } });
    await waitFor(martin, (s) => s.error?.code === 'not_allowed');

    await server.close();
    server = await startServer({ port: 0, host: '127.0.0.1', storage: new SqliteStorage(path) });
    const back = await join('Martin');
    expect(back.getState().chats.map((c) => c.title)).toEqual(['Menu']);
    back.openChat(chatId);
    const state = await waitFor(back, (s) => (s.messages[chatId]?.length ?? 0) === 2);
    expect(state.messages[chatId]!.map((m) => m.text)).toEqual(['Hello agent', 'Working on it']);
  });

  it('expires an open request when its agent leaves', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const martin = await join('Martin');
    martin.saveAgent(builder);
    const { agents } = await waitFor(martin, (s) => s.agents.length === 1);
    const chatId = martin.createChat({ agentId: agents[0]!.id, title: 'Menu' });
    await waitFor(martin, (s) => s.chats.length === 1);
    martin.openChat(chatId);
    const agent = await join('Builder', { profileId: agents[0]!.id, startedBy: 'Martin' });
    agent.postChat(chatId, { kind: 'approval', text: 'Edit a', approval: { action: 'Edit a', reason: 'outside', state: 'pending' } });
    await waitFor(martin, (s) => s.messages[chatId]?.[0]?.approval?.state === 'pending');
    agent.disconnect();
    await waitFor(martin, (s) => s.messages[chatId]?.[0]?.approval?.state === 'expired');
  });

  it('turns away a runner for an agent that is not set up', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const ghost = await join('Ghost', { profileId: 'nope', startedBy: 'Martin' });
    expect(ghost.getState().status).toBe('closed');
  });
});

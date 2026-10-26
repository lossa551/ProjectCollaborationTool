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

  it('branches a chat from a message, copying the conversation up to it and keeping it across a restart', async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'pct-'));
    dirs.push(dir);
    const path = joinPath(dir, 'session.sqlite');
    server = await startServer({ port: 0, host: '127.0.0.1', storage: new SqliteStorage(path) });
    const martin = await join('Martin');
    const friend = await join('Friend');
    martin.saveAgent(builder);
    const { agents } = await waitFor(martin, (s) => s.agents.length === 1);
    const chatId = martin.createChat({ agentId: agents[0]!.id, title: 'Menu' });
    await waitFor(martin, (s) => s.chats.length === 1);
    martin.openChat(chatId);
    const agent = await join('Builder', { profileId: agents[0]!.id, startedBy: 'Martin' });
    // Each post waits for the last, so the order is the same for everyone.
    const first = martin.postChat(chatId, { kind: 'text', text: 'Plan the menu' });
    await waitFor(agent, (s) => s.messages[chatId]?.length === 1);
    const answer = agent.postChat(chatId, { kind: 'text', text: 'Use a grid' });
    agent.postChat(chatId, { kind: 'approval', text: 'Edit a', approval: { action: 'Edit a', reason: 'outside', state: 'pending' } });
    await waitFor(martin, (s) => s.messages[chatId]?.length === 3);
    martin.postChat(chatId, { kind: 'text', text: 'No, use a list' });
    await waitFor(martin, (s) => s.messages[chatId]?.length === 4);

    // Agents cannot branch, and the message must be in the chat.
    agent.branchChat({ fromChatId: chatId, fromMessageId: answer, title: 'x' });
    await waitFor(agent, (s) => s.error?.code === 'not_allowed');
    martin.branchChat({ fromChatId: chatId, fromMessageId: 'gone', title: 'x' });
    await waitFor(martin, (s) => s.error?.code === 'not_found');

    const branchId = friend.branchChat({ fromChatId: chatId, fromMessageId: answer, title: 'Menu (grid)' });
    const state = await waitFor(martin, (s) => s.chats.length === 2 && (s.messages[branchId]?.length ?? 0) === 3);
    const branch = state.chats.find((c) => c.id === branchId)!;
    expect(branch.branchedFrom).toEqual({ chatId, messageId: answer, title: 'Menu' });
    expect(branch.agentId).toBe(agents[0]!.id);
    const copied = state.messages[branchId]!;
    expect(copied.map((m) => m.text.split('.')[0])).toEqual(['Plan the menu', 'Use a grid', 'Friend branched this chat from "Menu"']);
    expect(copied.every((m) => m.chatId === branchId && m.id !== first && m.id !== answer)).toBe(true);
    expect(copied[2]!.kind).toBe('notice');
    // The original is untouched.
    expect(state.messages[chatId]!.map((m) => m.text)).toEqual(['Plan the menu', 'Use a grid', 'Edit a', 'No, use a list']);
    await waitFor(martin, (s) => s.activity.some((a) => a.text === 'branched "Menu" into "Menu (grid)"'));

    // A pending request is closed in the copy, and the chat's agent can post in the branch.
    const later = martin.getState().messages[chatId]![2]!.id;
    const second = martin.branchChat({ fromChatId: chatId, fromMessageId: later, title: 'Menu (asked)' });
    const withApproval = await waitFor(martin, (s) => (s.messages[second]?.length ?? 0) === 4);
    expect(withApproval.messages[second]![2]!.approval?.state).toBe('expired');
    expect(withApproval.messages[chatId]![2]!.approval?.state).toBe('pending');
    agent.postChat(branchId, { kind: 'text', text: 'Grid it is' });
    await waitFor(martin, (s) => s.messages[branchId]?.length === 4);

    await server.close();
    server = await startServer({ port: 0, host: '127.0.0.1', storage: new SqliteStorage(path) });
    const back = await join('Martin');
    expect(back.getState().chats.find((c) => c.id === branchId)?.branchedFrom?.chatId).toBe(chatId);
    back.openChat(branchId);
    const reloaded = await waitFor(back, (s) => (s.messages[branchId]?.length ?? 0) === 4);
    expect(reloaded.messages[branchId]!.map((m) => m.text)[3]).toBe('Grid it is');
  });

  it('turns away a runner for an agent that is not set up', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const ghost = await join('Ghost', { profileId: 'nope', startedBy: 'Martin' });
    expect(ghost.getState().status).toBe('closed');
  });

  it('shares an agent copy, which only the agent or the person whose PC holds it can change', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const martin = await join('Martin');
    const friend = await join('Friend');
    martin.saveAgent(builder);
    const { agents } = await waitFor(martin, (s) => s.agents.length === 1);
    const agent = await join('Builder', { profileId: agents[0]!.id, startedBy: 'Martin' });
    const chatId = martin.createChat({ agentId: agents[0]!.id, title: 'Jump' });
    await waitFor(agent, (s) => s.chats.some((c) => c.id === chatId));
    const copy = {
      branch: 'agent/jump-abc123',
      base: 'main',
      baseCommit: 'a'.repeat(40),
      folder: 'C:\\Users\\martin\\game-agents\\jump-abc123',
      owner: { id: martin.getState().you!.id, name: 'Martin' },
      files: [{ path: 'src/jump.gd', change: 'added' as const }],
      truncated: false,
      commits: 0,
      uncommitted: 1,
      head: null,
      updatedAt: 1,
    };
    agent.setChatWorktree(chatId, copy);
    const seen = await waitFor(friend, (s) => s.chats.find((c) => c.id === chatId)?.worktree?.branch === 'agent/jump-abc123');
    expect(seen.chats.find((c) => c.id === chatId)!.worktree).toEqual(copy);

    friend.setChatWorktree(chatId, null, 'discarded it');
    await waitFor(friend, (s) => s.error?.code === 'not_allowed');
    martin.setChatWorktree(chatId, null, 'merged agent/jump-abc123 into main');
    const after = await waitFor(friend, (s) => s.chats.find((c) => c.id === chatId)?.worktree === null && s.activity.some((a) => a.text.startsWith('merged')));
    expect(after.activity.find((a) => a.text.startsWith('merged'))).toMatchObject({ actorName: 'Martin', text: 'merged agent/jump-abc123 into main' });
    expect(after.activity.some((a) => a.text === 'discarded it')).toBe(false);
  });
});

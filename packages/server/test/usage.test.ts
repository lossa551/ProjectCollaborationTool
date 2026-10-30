import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPROVALS, DEFAULT_PRICES, SessionClient, commitDraftUsageId, newIdentity, notesDraftUsageId, type SessionState, type UsageReport } from '@pct/shared';
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
  connection: { type: 'cli' as const, tool: 'claude-code' as const, model: null, auth: 'plan' as const },
  responsibilities: 'Builds things',
  allowedPaths: [],
  approvals: DEFAULT_APPROVALS,
};

const call = (chatId: string, extra: Partial<UsageReport> = {}): UsageReport => ({
  chatId,
  model: 'claude-opus-5-5',
  source: 'reported',
  input: 100,
  output: 50,
  cacheRead: 1000,
  cacheWrite: 0,
  cost: 0.25,
  day: '2026-10-27',
  ...extra,
});

describe('agent usage', () => {
  it('adds up what a chat’s agent reports, keeps it across a restart, and shares prices and budgets', async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'pct-'));
    dirs.push(dir);
    const path = joinPath(dir, 'session.sqlite');
    server = await startServer({ port: 0, host: '127.0.0.1', storage: new SqliteStorage(path) });
    const martin = await join('Martin');
    const friend = await join('Friend');
    expect(friend.getState().prices).toEqual(DEFAULT_PRICES);
    martin.saveAgent(builder);
    martin.saveAgent({ ...builder, name: 'Reviewer' });
    const { agents } = await waitFor(martin, (s) => s.agents.length === 2);
    const taskId = martin.createTask('Double jump');
    await waitFor(martin, (s) => s.tasks.length === 1);
    const chatId = martin.createChat({ agentId: agents[0]!.id, title: 'Jump', taskId });
    await waitFor(friend, (s) => s.chats.length === 1);

    const agent = await join('Builder', { profileId: agents[0]!.id, startedBy: 'Martin' });
    agent.recordUsage(call(chatId));
    agent.recordUsage(call(chatId, { cost: 0.5 }));
    const state = await waitFor(friend, (s) => s.usage[0]?.calls === 2);
    expect(state.usage).toEqual([
      expect.objectContaining({ chatId, agentId: agents[0]!.id, taskId, calls: 2, input: 200, output: 100, cacheRead: 2000, cost: 0.75 }),
    ]);

    // Only the chat's own agent reports for it.
    const other = await join('Reviewer', { profileId: agents[1]!.id, startedBy: 'Martin' });
    other.recordUsage(call(chatId));
    await waitFor(other, (s) => s.error?.code === 'not_allowed');
    martin.recordUsage(call(chatId));
    await waitFor(martin, (s) => s.error?.code === 'not_allowed');

    // A commit message draft counts as the agent's own, for the task it names; nobody else reports under it.
    const draftId = commitDraftUsageId(agents[0]!.id);
    agent.recordUsage(call(draftId, { taskId }));
    await waitFor(friend, (s) => s.usage.some((r) => r.chatId === draftId));
    expect(friend.getState().usage.find((r) => r.chatId === draftId)).toMatchObject({ agentId: agents[0]!.id, taskId, calls: 1 });
    other.recordUsage(call(draftId));
    martin.recordUsage(call(commitDraftUsageId('someone')));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(friend.getState().usage.find((r) => r.chatId === draftId)?.calls).toBe(1);
    expect(friend.getState().usage).toHaveLength(2);

    // Folder note drafts count as the agent's own too, apart from its commit drafts.
    const notesId = notesDraftUsageId(agents[0]!.id);
    agent.recordUsage(call(notesId));
    await waitFor(friend, (s) => s.usage.some((r) => r.chatId === notesId));
    expect(friend.getState().usage.find((r) => r.chatId === notesId)).toMatchObject({ agentId: agents[0]!.id, taskId: null, calls: 1 });
    other.recordUsage(call(notesId));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(friend.getState().usage.find((r) => r.chatId === notesId)?.calls).toBe(1);

    martin.setPrices([{ model: 'deepseek', input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }]);
    await waitFor(friend, (s) => s.prices.length === 1);
    // An agent cannot raise its own budget.
    agent.updateTask(taskId, { budget: 300 });
    await waitFor(agent, (s) => s.error?.code === 'not_allowed');
    agent.updateChat(chatId, { budget: 300 });
    martin.updateTask(taskId, { budget: 5 });
    martin.updateChat(chatId, { budget: 1.5 });
    await waitFor(friend, (s) => s.tasks[0]?.budget === 5 && s.chats[0]?.budget === 1.5);
    const texts = friend.getState().activity.map((a) => a.text);
    expect(texts).toContain('set a $5.00 budget for "Double jump"');
    expect(texts).toContain('set a $1.50 budget for the chat "Jump"');
    expect(texts).toContain('changed the model prices');

    await server.close();
    server = await startServer({ port: 0, host: '127.0.0.1', storage: new SqliteStorage(path) });
    const back = await join('Martin');
    expect(back.getState().usage.find((r) => r.chatId === chatId)).toMatchObject({ calls: 2, cost: 0.75 });
    expect(back.getState().prices).toEqual([{ model: 'deepseek', input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }]);
    expect(back.getState().tasks[0]?.budget).toBe(5);
    expect(back.getState().chats[0]?.budget).toBe(1.5);
  });
});

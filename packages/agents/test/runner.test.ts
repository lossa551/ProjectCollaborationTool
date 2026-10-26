import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPROVALS, SessionClient, newIdentity, type AgentProfile, type SessionState } from '@pct/shared';
import { startServer, type RunningServer } from '@pct/server';
import { AgentRunner, type ModelAdapter, type ModelRequest, type ModelTurn } from '@pct/agents';

let server: RunningServer | null = null;
const clients: SessionClient[] = [];
const runners: AgentRunner[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  for (const client of clients.splice(0)) client.disconnect();
  await server?.close();
  server = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function waitFor(client: SessionClient, check: (state: SessionState) => boolean, timeoutMs = 4000) {
  return new Promise<SessionState>((resolve, reject) => {
    if (check(client.getState())) return resolve(client.getState());
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`timed out; last state: ${JSON.stringify(client.getState()).slice(0, 3000)}`));
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
  return client;
}

/** A model that plays back scripted turns and records what it was sent. */
class ScriptedModel implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly turns: ModelTurn[]) {}
  async complete(request: ModelRequest): Promise<ModelTurn> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const turn = this.turns.shift() ?? { text: 'Nothing more to do.', toolCalls: [], stop: 'end' };
    for (const part of turn.text.match(/.{1,5}/g) ?? []) request.onText(part);
    return turn;
  }
}

async function setup(turns: ModelTurn[], approvals = DEFAULT_APPROVALS) {
  server = await startServer({ port: 0, host: '127.0.0.1' });
  const root = mkdtempSync(joinPath(tmpdir(), 'pct-agent-'));
  dirs.push(root);
  const martin = await join('Martin');
  await waitFor(martin, (s) => s.status === 'connected');
  martin.saveAgent({
    name: 'Builder',
    connection: { type: 'api', provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: null },
    responsibilities: 'Implements gameplay code.',
    allowedPaths: ['src/**'],
    approvals,
  });
  const { agents } = await waitFor(martin, (s) => s.agents.length === 1);
  const profile = agents[0] as AgentProfile;

  const agentClient = await join('Builder', { profileId: profile.id, startedBy: 'Martin' });
  const model = new ScriptedModel(turns);
  const runner = new AgentRunner({
    client: agentClient,
    profileId: profile.id,
    startedBy: 'Martin',
    root,
    createModel: () => model,
    lockTimeoutMs: 2000,
  });
  runners.push(runner);
  runner.start();
  await waitFor(agentClient, (s) => s.status === 'connected');
  await waitFor(martin, (s) => s.participants.some((p) => p.agent?.profileId === profile.id));
  return { martin, agentClient, profile, model, root };
}

describe('agent runner', () => {
  it('answers in a shared chat, edits inside its scope and asks before editing outside it', async () => {
    const { martin, agentClient, profile, model, root } = await setup([
      { text: 'Writing the player script.', toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'src/player.gd', content: 'extends Node\n' } }], stop: 'tool_use' },
      { text: '', toolCalls: [{ id: 't2', name: 'write_file', input: { path: 'docs/notes.md', content: '# Notes\n' } }], stop: 'tool_use' },
      { text: 'Done: player script and notes.', toolCalls: [], stop: 'end' },
    ]);

    const chatId = martin.createChat({ agentId: profile.id, title: 'Player movement' });
    await waitFor(martin, (s) => s.chats.some((c) => c.id === chatId));
    martin.openChat(chatId);
    martin.postChat(chatId, { kind: 'text', text: 'Add a player script please' });

    // Inside src/**: written right away, under a lock held by the agent.
    await waitFor(martin, (s) => s.locks.some((l) => l.path === 'src/player.gd' && l.holder.name === 'Builder'));
    await waitFor(martin, (s) => (s.messages[chatId] ?? []).some((m) => m.tool?.summary === 'src/player.gd' && m.tool.status === 'done'));
    expect(readFileSync(joinPath(root, 'src/player.gd'), 'utf8')).toBe('extends Node\n');

    // Outside it: an approval card, and nothing written until a person decides.
    const asking = await waitFor(martin, (s) => (s.messages[chatId] ?? []).some((m) => m.approval?.state === 'pending'));
    const card = asking.messages[chatId]!.find((m) => m.approval?.state === 'pending')!;
    expect(card.approval!.reason).toContain('outside');
    expect(asking.chats.find((c) => c.id === chatId)?.state).toBe('waiting');
    expect(existsSync(joinPath(root, 'docs/notes.md'))).toBe(false);

    // The agent cannot approve its own request.
    agentClient.decideApproval(chatId, card.id, true);
    await waitFor(agentClient, (s) => s.error?.code === 'not_allowed');

    martin.decideApproval(chatId, card.id, true);
    const done = await waitFor(martin, (s) =>
      (s.messages[chatId] ?? []).some((m) => m.kind === 'text' && m.text === 'Done: player script and notes.' && !m.streaming),
    );
    expect(readFileSync(joinPath(root, 'docs/notes.md'), 'utf8')).toBe('# Notes\n');
    expect(done.messages[chatId]!.find((m) => m.id === card.id)?.approval).toMatchObject({ state: 'approved', decidedBy: 'Martin' });
    await waitFor(martin, (s) => s.chats.find((c) => c.id === chatId)?.state === 'idle');
    expect(martin.getState().chats.find((c) => c.id === chatId)?.context?.items.map((i) => i.label)).toContain('Role and rules');

    // The model saw the person's name and the tool results in order.
    expect(model.requests[0]!.messages[0]).toEqual({ role: 'user', text: 'Martin: Add a player script please' });
    expect(model.requests[0]!.system).toContain('Implements gameplay code.');
    expect(model.requests[2]!.messages.filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('refuses edits to a file someone else locked exclusively', async () => {
    const { martin, profile, model, root } = await setup([
      { text: '', toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'src/hero.png', content: 'x' } }], stop: 'tool_use' },
      { text: 'I could not change the sprite.', toolCalls: [], stop: 'end' },
    ]);
    martin.acquireLock('src/hero.png');
    await waitFor(martin, (s) => s.locks.some((l) => l.path === 'src/hero.png'));
    const chatId = martin.createChat({ agentId: profile.id, title: 'Sprite' });
    await waitFor(martin, (s) => s.chats.some((c) => c.id === chatId));
    martin.postChat(chatId, { kind: 'text', text: 'Recolor the hero' });
    martin.openChat(chatId);
    const state = await waitFor(martin, (s) => (s.messages[chatId] ?? []).some((m) => m.tool?.status === 'blocked'));
    expect(state.messages[chatId]!.find((m) => m.tool?.status === 'blocked')?.tool?.output).toContain('locked by Martin');
    await waitFor(martin, (s) => (s.messages[chatId] ?? []).some((m) => m.text === 'I could not change the sprite.'));
    expect(existsSync(joinPath(root, 'src/hero.png'))).toBe(false);
    const result = model.requests[1]!.messages.at(-1);
    expect(result).toMatchObject({ role: 'tool', results: [{ isError: true }] });
  });

  it('stops when a person asks it to, and answers a handoff', async () => {
    const { martin, profile } = await setup([
      { text: '', toolCalls: [{ id: 't1', name: 'run_command', input: { command: 'echo hi' } }], stop: 'tool_use' },
    ]);
    const chatId = martin.createChat({
      agentId: profile.id,
      title: 'Review',
      handoff: { fromChatId: null, fromName: 'Planner', stage: 'review', plan: 'Check the movement code', decisions: [], criteria: ['Jumps work'], scope: [], notes: '' },
    });
    await waitFor(martin, (s) => s.chats.some((c) => c.id === chatId));
    martin.openChat(chatId);
    martin.postChat(chatId, { kind: 'handoff', text: 'Handoff from Planner.\n\nAcceptance criteria:\n- Jumps work' });
    // Commands need approval by default; stop instead of answering.
    await waitFor(martin, (s) => (s.messages[chatId] ?? []).some((m) => m.approval?.state === 'pending'));
    martin.stopChat(chatId);
    const state = await waitFor(martin, (s) => (s.messages[chatId] ?? []).some((m) => m.kind === 'notice' && m.text === 'Stopped by Martin.'));
    expect(state.messages[chatId]!.find((m) => m.kind === 'approval')?.approval?.state).toBe('expired');
    await waitFor(martin, (s) => s.chats.find((c) => c.id === chatId)?.state === 'idle');
  });

  it('undoes files a command changed outside the agent’s paths unless a person keeps them', async () => {
    const command = `node -e "require('fs').writeFileSync('outside.txt','1')"`;
    const { martin, profile, root } = await setup(
      [
        { text: '', toolCalls: [{ id: 't1', name: 'run_command', input: { command } }], stop: 'tool_use' },
        { text: 'Ran it.', toolCalls: [], stop: 'end' },
      ],
      { ...DEFAULT_APPROVALS, commands: 'allow' },
    );
    execFileSync('git', ['init', '-q'], { cwd: root });
    const chatId = martin.createChat({ agentId: profile.id, title: 'Script' });
    await waitFor(martin, (s) => s.chats.some((c) => c.id === chatId));
    martin.openChat(chatId);
    martin.postChat(chatId, { kind: 'text', text: 'Run the generator' });
    const asking = await waitFor(martin, (s) => (s.messages[chatId] ?? []).some((m) => m.approval?.state === 'pending'));
    const card = asking.messages[chatId]!.find((m) => m.approval?.state === 'pending')!;
    expect(card.approval!.action).toBe('Keep 1 change the command made');
    expect(existsSync(joinPath(root, 'outside.txt'))).toBe(true);
    martin.decideApproval(chatId, card.id, false);
    await waitFor(martin, (s) => (s.messages[chatId] ?? []).some((m) => m.kind === 'notice' && m.text.includes('Undid changes the command made to outside.txt')));
    expect(existsSync(joinPath(root, 'outside.txt'))).toBe(false);
  });

  it('runs each agent on one PC at a time', async () => {
    const { profile } = await setup([]);
    const second = await join('Builder', { profileId: profile.id, startedBy: 'Friend' });
    const state = await waitFor(second, (s) => s.status === 'closed');
    expect(state.error?.code).toBe('agent_running');
    expect(state.error?.message).toContain("Martin's PC");
  });
});

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPROVALS, SessionClient, newIdentity, type AgentProfile, type SessionState } from '@pct/shared';
import { startServer, type RunningServer } from '@pct/server';
import { AgentRunner, type AgentRunnerOptions, type ModelAdapter, type ModelRequest, type ModelTurn } from '@pct/agents';

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

async function setup(turns: ModelTurn[], approvals = DEFAULT_APPROVALS, extra: Partial<AgentRunnerOptions> = {}) {
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
    ...extra,
  });
  runners.push(runner);
  runner.start();
  await waitFor(agentClient, (s) => s.status === 'connected');
  await waitFor(martin, (s) => s.participants.some((p) => p.agent?.profileId === profile.id));
  return { martin, agentClient, profile, model, root };
}

describe('agent runner', () => {
  it('knows project memory and the task’s criteria, and records test results', async () => {
    const { martin, agentClient, profile, model } = await setup([
      {
        text: 'Checked it.',
        toolCalls: [{ id: 't1', name: 'record_test_result', input: { criterion_id: 'c1', result: 'verified', evidence: 'npm test passed' } }],
        stop: 'tool_use',
      },
      { text: 'Recorded.', toolCalls: [], stop: 'end' },
    ]);
    martin.editMemory({ op: 'create', id: 'memory-000001', kind: 'convention', title: 'Tabs in GDScript' });
    await waitFor(agentClient, (s) => s.memory.length === 1);
    const taskId = martin.createTask('Double jump', { criteria: [{ id: 'c1', text: 'Second jump works' }] });
    await waitFor(martin, (s) => s.tasks.length === 1);
    const chatId = martin.createChat({ agentId: profile.id, title: 'Test the jump', taskId });
    await waitFor(martin, (s) => s.chats.some((c) => c.id === chatId));
    martin.postChat(chatId, { kind: 'text', text: 'Please verify the jump' });

    const state = await waitFor(martin, (s) => s.tasks[0]?.criteria[0]?.state === 'verified');
    expect(state.tasks[0]!.criteria[0]).toMatchObject({ evidence: 'npm test passed', by: 'Builder' });
    expect(model.requests[0]!.system).toContain('Tabs in GDScript');
    expect(model.requests[0]!.system).toContain('[c1] Not tested: Second jump works');
    const chat = await waitFor(martin, (s) => s.chats.find((c) => c.id === chatId)?.context?.items.some((i) => i.label === 'Project memory') === true);
    expect(chat.chats[0]!.context!.items.map((i) => i.label)).toContain('Task');
  });

  it('gets the folder notes and files to read for its task', async () => {
    const { martin, profile, model, root } = await setup([{ text: 'Read them.', toolCalls: [], stop: 'end' }]);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const write = (path: string, text: string) => {
      mkdirSync(joinPath(root, path, '..'), { recursive: true });
      writeFileSync(joinPath(root, path), text);
    };
    write('AGENTS.md', 'Godot game. Scripts live in src/.\n');
    write('src/player/AGENTS.md', 'Player movement. Start with `movement.gd`.\n');
    write('src/ui/AGENTS.md', 'Menus and HUD.\n');
    const taskId = martin.createTask('Double jump', { scope: ['src/player/**'], readFirst: ['src/player/movement.gd'] });
    await waitFor(martin, (s) => s.tasks.length === 1);
    const chatId = martin.createChat({ agentId: profile.id, title: 'Jump', taskId });
    await waitFor(martin, (s) => s.chats.some((c) => c.id === chatId));
    martin.postChat(chatId, { kind: 'text', text: 'Add a double jump' });

    const state = await waitFor(martin, (s) => s.chats.find((c) => c.id === chatId)?.context?.items.some((i) => i.label === 'Folder notes') === true);
    const system = model.requests[0]!.system;
    expect(system).toContain('--- AGENTS.md ---\nGodot game.');
    expect(system).toContain('--- src/player/AGENTS.md ---\nPlayer movement.');
    expect(system).not.toContain('Menus and HUD');
    expect(system).toContain('Read these first; start from them instead of exploring the project:\n- src/player/movement.gd');
    expect(state.chats[0]!.context!.items.find((i) => i.label === 'Folder notes')!.detail).toBe('AGENTS.md, src/player/AGENTS.md');
  });

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

  it('waits for a file someone else locked exclusively, then edits it once released', async () => {
    const { martin, profile, root } = await setup([
      { text: '', toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'src/hero.png', content: 'x' } }], stop: 'tool_use' },
      { text: 'Recolored.', toolCalls: [], stop: 'end' },
    ]);
    martin.acquireLock('src/hero.png', { reason: 'Painting the hero' });
    const locked = await waitFor(martin, (s) => s.locks.some((l) => l.path === 'src/hero.png'));
    const chatId = martin.createChat({ agentId: profile.id, title: 'Sprite' });
    await waitFor(martin, (s) => s.chats.some((c) => c.id === chatId));
    martin.postChat(chatId, { kind: 'text', text: 'Recolor the hero' });
    martin.openChat(chatId);

    const waiting = await waitFor(martin, (s) => s.chats.find((c) => c.id === chatId)?.state === 'waiting');
    expect(waiting.chats.find((c) => c.id === chatId)!.activity).toBe('Waiting for Martin to release src/hero.png');
    expect(waiting.messages[chatId]!.some((m) => m.kind === 'notice' && m.text.includes('locked for "Painting the hero"'))).toBe(true);
    expect(existsSync(joinPath(root, 'src/hero.png'))).toBe(false);

    martin.releaseLock(locked.locks[0]!.id);
    const agentLock = await waitFor(martin, (s) => s.locks.some((l) => l.holder.name === 'Builder'));
    expect(agentLock.locks.find((l) => l.holder.name === 'Builder')).toMatchObject({ kind: 'exclusive', chatId, reason: 'Sprite' });
    await waitFor(martin, (s) => (s.messages[chatId] ?? []).some((m) => m.text === 'Recolored.'));
    expect(readFileSync(joinPath(root, 'src/hero.png'), 'utf8')).toBe('x');
  });

  it('gives up waiting for a lock after a while and tells the model to ask', async () => {
    const { martin, profile, model, root } = await setup(
      [
        { text: '', toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'src/hero.png', content: 'x' } }], stop: 'tool_use' },
        { text: 'I could not change the sprite.', toolCalls: [], stop: 'end' },
      ],
      DEFAULT_APPROVALS,
      { lockWaitMs: 200 },
    );
    martin.acquireLock('src/hero.png');
    await waitFor(martin, (s) => s.locks.some((l) => l.path === 'src/hero.png'));
    const chatId = martin.createChat({ agentId: profile.id, title: 'Sprite' });
    await waitFor(martin, (s) => s.chats.some((c) => c.id === chatId));
    martin.postChat(chatId, { kind: 'text', text: 'Recolor the hero' });
    martin.openChat(chatId);
    const state = await waitFor(martin, (s) => (s.messages[chatId] ?? []).some((m) => m.tool?.status === 'blocked'));
    expect(state.messages[chatId]!.find((m) => m.tool?.status === 'blocked')?.tool?.output).toContain('still locked by Martin');
    await waitFor(martin, (s) => (s.messages[chatId] ?? []).some((m) => m.text === 'I could not change the sprite.'));
    expect(existsSync(joinPath(root, 'src/hero.png'))).toBe(false);
    expect(model.requests[1]!.messages.at(-1)).toMatchObject({ role: 'tool', results: [{ isError: true }] });
  });

  it('shows what it is doing, keeps locks on files it changed and frees the rest when the turn ends', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { martin, profile, model, root } = await setup([
      { text: '', toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'src/same.gd', content: 'same\n' } }], stop: 'tool_use' },
      { text: '', toolCalls: [{ id: 't2', name: 'write_file', input: { path: 'src/new.gd', content: 'new\n' } }], stop: 'tool_use' },
      { text: 'Done.', toolCalls: [], stop: 'end' },
    ]);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    execFileSync('node', ['-e', "require('fs').mkdirSync('src');require('fs').writeFileSync('src/same.gd','same\\n')"], { cwd: root });
    git('add', '.');
    git('commit', '-qm', 'start');
    // Hold the model before its second step so the activity line can be read.
    const complete = model.complete.bind(model);
    model.complete = async (request) => {
      if (model.requests.length === 1) await gate;
      return complete(request);
    };

    const chatId = martin.createChat({ agentId: profile.id, title: 'Scripts' });
    await waitFor(martin, (s) => s.chats.some((c) => c.id === chatId));
    martin.openChat(chatId);
    martin.postChat(chatId, { kind: 'text', text: 'Write the scripts' });
    await waitFor(martin, (s) => s.locks.some((l) => l.path === 'src/same.gd'));
    const working = await waitFor(martin, (s) => s.chats.find((c) => c.id === chatId)?.activity === 'Thinking');
    expect(working.chats.find((c) => c.id === chatId)!.state).toBe('working');
    release();

    const done = await waitFor(martin, (s) => s.chats.find((c) => c.id === chatId)?.state === 'idle' && s.locks.length === 1);
    expect(done.chats.find((c) => c.id === chatId)!.activity).toBeNull();
    expect(done.locks.map((l) => l.path)).toEqual(['src/new.gd']);
  });

  it('frees an agent’s locks on a task when the task is done, and lets a person free one sooner', async () => {
    const { martin, agentClient } = await setup([]);
    const taskId = martin.createTask('Enemy AI');
    await waitFor(agentClient, (s) => s.tasks.length === 1);
    agentClient.acquireLock('src/enemy.gd', { taskId });
    agentClient.acquireLock('src/boss.gd', { taskId });
    agentClient.acquireLock('src/other.gd');
    const held = await waitFor(martin, (s) => s.locks.length === 3);
    martin.releaseLock(held.locks.find((l) => l.path === 'src/boss.gd')!.id);
    await waitFor(martin, (s) => s.locks.length === 2);
    martin.updateTask(taskId, { stage: 'done' });
    const state = await waitFor(martin, (s) => s.activity.some((a) => a.text.includes('released because "Enemy AI" is done')));
    expect(state.locks.map((l) => l.path)).toEqual(['src/other.gd']);
  });

  it('stops when a person asks it to, and answers a handoff', async () => {
    const { martin, profile } = await setup([
      { text: '', toolCalls: [{ id: 't1', name: 'run_command', input: { command: 'echo hi' } }], stop: 'tool_use' },
    ]);
    const chatId = martin.createChat({
      agentId: profile.id,
      title: 'Review',
      handoff: { fromChatId: null, fromName: 'Planner', stage: 'review', plan: 'Check the movement code', decisions: [], criteria: ['Jumps work'], scope: [], readFirst: [], notes: '' },
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

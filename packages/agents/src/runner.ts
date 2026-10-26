import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  CLI_TOOLS,
  approvalActivity,
  lockWaitActivity,
  notesForPaths,
  samePath,
  type AgentProfile,
  type ApprovalState,
  type ChatAgentState,
  type ChatInfo,
  type ChatMessage,
  type ChatTool,
  type FolderNote,
  type Lock,
  type LockKind,
  type ServerMessage,
  type SessionClient,
  type Task,
  type ToolStatus,
} from '@pct/shared';
import { HookServer, parseClaudeLine, parseCodexLine, runCli, type CliEvent, type HookRequest } from './cli.js';
import { describeContext, systemPrompt, type ContextInput } from './context.js';
import { ProjectFiles } from './files.js';
import { checkCommand, checkEdit, othersLocks, type GuardContext } from './guard.js';
import { parseInput, type LoopMessage, type ModelAdapter, type ToolCall, type ToolResult } from './models/types.js';
import {
  AGENT_TOOLS,
  EditFileInput,
  ListFilesInput,
  ReadFileInput,
  RecordTestResultInput,
  RunCommandInput,
  SearchInput,
  WriteFileInput,
} from './tools.js';

// Runs one agent on this PC. It is connected to the session as its own
// participant (kind "agent") and answers in every chat that belongs to its
// profile: people's messages start a turn, its text streams into the chat,
// and each edit or command is checked against locks, scope and approval rules
// before it happens. Pending approvals wait for a person to decide in the chat.

export interface CliSettings {
  /** Path to bin/pct-hook.cjs. */
  hookScript: string;
  /** What runs the hook script: node, or Electron's own binary as node. */
  nodePath: string;
  /** Extra environment for the hook (e.g. ELECTRON_RUN_AS_NODE). */
  hookEnv?: Record<string, string>;
  /** Overrides the command per tool, e.g. a full path. */
  commands?: Partial<Record<'claude-code' | 'codex', string>>;
}

export interface AgentRunnerOptions {
  /** Connected (or connecting) with kind "agent" and this profile in its hello. */
  client: SessionClient;
  profileId: string;
  startedBy: string;
  /** The project folder the agent works in. */
  root: string;
  /** Model for API agents. Throws when it cannot be made (say, no API key). */
  createModel?: (agent: AgentProfile) => ModelAdapter;
  cli?: CliSettings;
  /** How long an approval card waits for a person. Default 30 minutes. */
  approvalTimeoutMs?: number;
  /** How long to wait for the server to grant a lock. Default 5 s. */
  lockTimeoutMs?: number;
  /** How long to wait for someone to release a file the agent needs. Default 10 minutes. */
  lockWaitMs?: number;
  /** Messages people posted at most this long before the agent started are still answered. Default 1 hour. */
  answerBacklogMs?: number;
  /** Most model round trips in one turn. Default 40. */
  maxSteps?: number;
  log?: (line: string) => void;
}

interface ChatRun {
  /** People's messages already passed to the agent. */
  handled: Set<string>;
  history: LoopMessage[] | null;
  filesRead: Set<string>;
  busy: boolean;
  again: boolean;
  abort: AbortController | null;
  stoppedBy: string | null;
  /** Claude Code session to resume, so the CLI keeps its own context. */
  cliSession: string | null;
  /** Edits a person approved in this run; not asked about again after it. */
  approvedPaths: Set<string>;
  /** Last state reported to the session. */
  state: ChatAgentState;
  /** Folder notes for the task's paths, read at the start of each turn. */
  folderNotes: FolderNote[];
}

/** Longest folder note passed on; notes are meant to be 10 to 30 lines. */
const NOTE_CHARS = 8000;

const STREAM_INTERVAL_MS = 200;

/** How the agent's activity line reads while a tool runs. */
const TOOL_ACTIVITY: Record<string, string> = {
  read_file: 'Reading',
  list_files: 'Looking through',
  search: 'Searching for',
  write_file: 'Writing',
  edit_file: 'Editing',
  run_command: 'Running',
  record_test_result: 'Recording a test result:',
};

const TOOL_LABEL: Record<string, string> = {
  read_file: 'Read',
  list_files: 'List',
  search: 'Search',
  write_file: 'Write',
  edit_file: 'Edit',
  run_command: 'Run',
  record_test_result: 'Test result',
};

export class AgentRunner {
  private readonly files: ProjectFiles;
  private readonly runs = new Map<string, ChatRun>();
  private readonly waiters = new Map<string, (state: ApprovalState) => void>();
  private readonly unsubscribe: (() => void)[] = [];
  private hook: HookServer | null = null;
  private stopped = false;

  constructor(private readonly options: AgentRunnerOptions) {
    this.files = new ProjectFiles(options.root);
  }

  private get client(): SessionClient {
    return this.options.client;
  }

  private log(line: string) {
    this.options.log?.(line);
  }

  start(): void {
    this.unsubscribe.push(this.client.onMessage((message) => this.handle(message)));
    // Already connected before start: open the chats now.
    if (this.client.getState().status === 'connected') this.openChats();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const off of this.unsubscribe.splice(0)) off();
    for (const run of this.runs.values()) run.abort?.abort();
    // Stopping: no turn is still going, whatever its run says.
    await this.releaseUnchanged(() => true, true);
    for (const resolve of this.waiters.values()) resolve('expired');
    this.waiters.clear();
    await this.hook?.stop();
    this.hook = null;
  }

  private profile(): AgentProfile | undefined {
    return this.client.getState().agents.find((a) => a.id === this.options.profileId);
  }

  private myChats(): ChatInfo[] {
    return this.client.getState().chats.filter((c) => c.agentId === this.options.profileId);
  }

  private chat(chatId: string): ChatInfo | undefined {
    return this.myChats().find((c) => c.id === chatId);
  }

  private run(chatId: string): ChatRun {
    let run = this.runs.get(chatId);
    if (!run) {
      run = {
        handled: new Set(),
        history: null,
        filesRead: new Set(),
        busy: false,
        again: false,
        abort: null,
        stoppedBy: null,
        cliSession: null,
        approvedPaths: new Set(),
        state: 'idle',
        folderNotes: [],
      };
      this.runs.set(chatId, run);
    }
    return run;
  }

  private openChats() {
    for (const chat of this.myChats()) this.client.openChat(chat.id);
  }

  private handle(message: ServerMessage) {
    if (this.stopped) return;
    switch (message.type) {
      case 'welcome':
        this.openChats();
        break;
      case 'chat.changed':
        if (message.chat.agentId === this.options.profileId && !this.runs.has(message.chat.id)) this.run(message.chat.id);
        break;
      case 'chat.history': {
        const chat = this.chat(message.chatId);
        if (!chat) break;
        const run = this.run(message.chatId);
        const firstLoad = run.history === null && !run.busy;
        // Answer only what came after the agent last spoke, and not too long ago.
        const cutoff = Date.now() - (this.options.answerBacklogMs ?? 60 * 60_000);
        let lastAgent = -1;
        message.messages.forEach((m, i) => {
          if (m.author.kind === 'agent') lastAgent = i;
        });
        // A chat branched just now answers its last message even if that was written long ago.
        const branchedAt = chat.branchedFrom ? chat.createdAt : 0;
        message.messages.forEach((m, i) => {
          if (!isPrompt(m)) return;
          if (!firstLoad || i < lastAgent || Math.max(m.at, branchedAt) < cutoff) run.handled.add(m.id);
        });
        if (message.messages.some((m) => isPrompt(m) && !run.handled.has(m.id))) this.schedule(message.chatId);
        break;
      }
      case 'chat.message': {
        const m = message.message;
        const waiter = this.waiters.get(m.id);
        if (waiter && m.approval && m.approval.state !== 'pending') {
          this.waiters.delete(m.id);
          waiter(m.approval.state);
        }
        if (this.chat(m.chatId) && isPrompt(m) && !this.run(m.chatId).handled.has(m.id)) this.schedule(m.chatId);
        break;
      }
      case 'chat.stopped': {
        const run = this.runs.get(message.chatId);
        if (run?.abort) {
          run.stoppedBy = message.by;
          run.abort.abort();
        }
        break;
      }
      default:
        break;
    }
  }

  private schedule(chatId: string) {
    const run = this.run(chatId);
    if (run.busy) {
      run.again = true;
      return;
    }
    void this.turn(chatId);
  }

  /** Handles everything people posted since the agent last answered, until nothing new is left. */
  private async turn(chatId: string) {
    const run = this.run(chatId);
    run.busy = true;
    try {
      do {
        run.again = false;
        const chat = this.chat(chatId);
        const agent = this.profile();
        if (!chat || !agent || this.stopped) break;
        const messages = this.client.getState().messages[chatId] ?? [];
        const fresh = messages.filter((m) => isPrompt(m) && !run.handled.has(m.id));
        if (fresh.length === 0) break;
        if (run.history === null) run.history = rebuildHistory(messages.filter((m) => !fresh.includes(m)));
        for (const m of fresh) run.handled.add(m.id);
        const prompt = fresh.map(formatPrompt).join('\n\n');

        run.abort = new AbortController();
        run.stoppedBy = null;
        run.approvedPaths.clear();
        run.folderNotes = await this.loadFolderNotes(chat);
        this.setState(chatId, 'working', 'Thinking');
        try {
          if (agent.connection.type === 'api') await this.runApi(chat, agent, run, prompt);
          else await this.runCliAgent(chat, agent, run, prompt, messages, fresh);
        } catch (error) {
          if (run.abort.signal.aborted) {
            this.notice(chatId, run.stoppedBy ? `Stopped by ${run.stoppedBy}.` : 'Stopped.');
          } else {
            this.notice(chatId, `Something went wrong: ${error instanceof Error ? error.message : String(error)}`);
            this.log(`agent ${agent.name} failed: ${String(error)}`);
          }
          repairHistory(run.history);
        }
        run.abort = null;
      } while (run.again && !this.stopped);
    } finally {
      run.busy = false;
      run.abort = null;
      if (!this.stopped) {
        this.setState(chatId, 'idle');
        await this.releaseUnchanged((lock) => lock.chatId === chatId);
      }
    }
  }

  /**
   * Frees the agent's locks on files it did not end up changing. Locks on
   * files with uncommitted changes stay until the work is committed, the
   * task is done, or a person releases them.
   */
  private async releaseUnchanged(which: (lock: Lock) => boolean, stopping = false) {
    const { locks, you } = this.client.getState();
    const mine = locks.filter((l) => l.holder.id === you?.id && which(l));
    if (mine.length === 0) return;
    const changed = [...(await this.files.changedFiles())];
    for (const lock of mine) {
      const busy = !stopping && lock.chatId !== null && this.runs.get(lock.chatId)?.busy;
      if (!busy && !changed.some((file) => samePath(file, lock.path))) this.client.releaseLock(lock.id);
    }
  }

  private guardContext(chat: ChatInfo, agent: AgentProfile): GuardContext {
    const state = this.client.getState();
    return {
      agent,
      selfId: state.you?.id ?? '',
      task: state.tasks.find((t) => t.id === chat.taskId) ?? null,
      handoffScope: chat.handoff?.scope ?? [],
      locks: state.locks,
      lockRules: state.lockRules,
    };
  }

  private setState(chatId: string, state: ChatAgentState, activity?: string) {
    const chat = this.chat(chatId);
    const agent = this.profile();
    if (!chat || !agent) return;
    const run = this.run(chatId);
    run.state = state;
    const task = this.client.getState().tasks.find((t) => t.id === chat.taskId) ?? null;
    const context = describeContext(
      this.contextInput(agent, chat, task),
      { filesRead: [...run.filesRead], conversation: JSON.stringify(run.history ?? []) },
    );
    this.client.setChatAgentState(chatId, state, context, activity);
  }

  /** Tells everyone what the agent is doing now, in one line. */
  private setActivity(chatId: string, text: string) {
    const run = this.run(chatId);
    if (run.state === 'idle') return;
    this.client.setChatAgentState(chatId, run.state, undefined, text.length > 300 ? `${text.slice(0, 299)}…` : text);
  }

  /** The notes of the folders the chat's task and handoff point at, read from the project folder now. */
  private async loadFolderNotes(chat: ChatInfo): Promise<FolderNote[]> {
    const task = this.client.getState().tasks.find((t) => t.id === chat.taskId);
    const paths = [...(task?.scope ?? []), ...(task?.readFirst ?? []), ...(chat.handoff?.scope ?? []), ...(chat.handoff?.readFirst ?? [])];
    const notes: FolderNote[] = [];
    for (const path of notesForPaths(await this.files.notePaths(), paths)) {
      try {
        const { abs } = await this.files.resolve(path);
        const text = await readFile(abs, 'utf8');
        notes.push({ path, text: text.length > NOTE_CHARS ? `${text.slice(0, NOTE_CHARS)}\n…` : text });
      } catch {
        // Deleted since git listed it: left out.
      }
    }
    return notes;
  }

  private contextInput(agent: AgentProfile, chat: ChatInfo, task: Task | null): ContextInput {
    return {
      agent,
      chat,
      task,
      startedBy: this.options.startedBy,
      memory: this.client.getState().memory,
      folderNotes: this.runs.get(chat.id)?.folderNotes ?? [],
      recordsResults: agent.connection.type === 'api',
    };
  }

  private notice(chatId: string, text: string) {
    this.client.postChat(chatId, { kind: 'notice', text });
  }

  private postTool(chatId: string, id: string, tool: ChatTool) {
    this.client.postChat(chatId, { id, kind: 'tool', text: '', tool: { ...tool, output: tool.output.slice(0, 4000) } });
  }

  /** Streams one assistant message into the chat, a few times a second. */
  private textWriter(chatId: string) {
    const id = randomUUID();
    let text = '';
    let posted = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (!text) return;
      posted = true;
      this.client.postChat(chatId, { id, kind: 'text', text, streaming: true });
    };
    return {
      append: (delta: string) => {
        text += delta;
        timer ??= setTimeout(flush, STREAM_INTERVAL_MS);
      },
      finish: (final: string) => {
        if (timer) clearTimeout(timer);
        timer = null;
        const body = final || text;
        if (!body.trim() && !posted) return;
        this.client.postChat(chatId, { id, kind: 'text', text: body, streaming: false });
      },
    };
  }

  /**
   * Shows an approval card and waits for a person. Resolves true only if
   * approved; false when denied, stopped or nobody answered in time.
   */
  private async askApproval(chatId: string, action: string, reason: string, signal: AbortSignal): Promise<boolean> {
    const id = randomUUID();
    const card = (state: ApprovalState) =>
      this.client.postChat(chatId, { id, kind: 'approval', text: action, approval: { action, reason, state } });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    const decided = new Promise<ApprovalState>((resolve) => {
      this.waiters.set(id, resolve);
      timeout = setTimeout(() => resolve('expired'), this.options.approvalTimeoutMs ?? 30 * 60_000);
      abort = () => resolve('expired');
      signal.addEventListener('abort', abort, { once: true });
    });
    card('pending');
    this.setState(chatId, 'waiting', approvalActivity(action));
    const state = await decided;
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    this.waiters.delete(id);
    if (state === 'expired') card('expired');
    if (!signal.aborted) this.setState(chatId, 'working');
    return state === 'approved';
  }

  /** Takes a lock on the path for the agent (or keeps the one it has). Returns why not, if it could not. */
  private async ensureLock(path: string, kind: LockKind, chat: ChatInfo): Promise<string | null> {
    const holds = () => {
      const { locks, you } = this.client.getState();
      return locks.some((l) => l.holder.id === you?.id && samePath(l.path, path) && (kind === 'soft' || l.kind === 'exclusive'));
    };
    if (holds()) return null;
    return new Promise((resolve) => {
      const done = (result: string | null) => {
        clearTimeout(timer);
        offState();
        offMessage();
        resolve(result);
      };
      const timer = setTimeout(() => done('the session server did not confirm the lock'), this.options.lockTimeoutMs ?? 5000);
      const offState = this.client.subscribe(() => {
        if (holds()) done(null);
      });
      const offMessage = this.client.onMessage((message) => {
        if (message.type === 'error' && (message.code === 'locked' || message.code === 'not_found')) done(message.message);
      });
      this.client.acquireLock(path, { taskId: chat.taskId, exclusive: kind === 'exclusive', chatId: chat.id, reason: chat.title });
    });
  }

  /**
   * Checks an edit before it happens: blocked, asked about, or allowed, and
   * then locked. Returns null when the edit may go ahead, else why not.
   */
  private async gateEdit(chat: ChatInfo, agent: AgentProfile, rawPath: string, signal: AbortSignal): Promise<{ path: string } | { blocked: string }> {
    let decision = checkEdit(this.guardContext(chat, agent), rawPath);
    if (decision.path && decision.verdict === 'deny') {
      // Held by someone who is still around, and nothing else in the way: wait for them.
      const ctx = this.guardContext(chat, agent);
      const holding = othersLocks(ctx, decision.path, decision.lockKind).blocking;
      const live = holding.filter((l) => !l.abandoned);
      const withoutThem = checkEdit({ ...ctx, locks: ctx.locks.filter((l) => !live.includes(l)) }, rawPath);
      if (live.length > 0 && withoutThem.verdict !== 'deny') {
        const problem = await this.waitForRelease(chat.id, decision.path, live, signal);
        if (problem) return { blocked: problem };
        decision = checkEdit(this.guardContext(chat, agent), rawPath);
      }
    }
    if (!decision.path || decision.verdict === 'deny') return { blocked: decision.reasons.join('; ') || 'not allowed' };
    const path = decision.path;
    if (decision.verdict === 'ask' && !this.run(chat.id).approvedPaths.has(path.toLowerCase())) {
      const approved = await this.askApproval(chat.id, `Edit ${path}`, decision.reasons.join('; '), signal);
      if (!approved) return { blocked: signal.aborted ? 'stopped' : `a person did not approve editing ${path}` };
      this.run(chat.id).approvedPaths.add(path.toLowerCase());
    }
    const lockProblem = await this.ensureLock(path, decision.lockKind, chat);
    if (lockProblem) return { blocked: lockProblem };
    return { path };
  }

  /**
   * Waits until the given locks are released (or recovered), so an agent does
   * not fail just because someone else is using a file for a while. Returns
   * why it gave up, or null once the file is free.
   */
  private async waitForRelease(chatId: string, path: string, holding: Lock[], signal: AbortSignal): Promise<string | null> {
    const ids = new Set(holding.map((l) => l.id));
    const names = [...new Set(holding.map((l) => l.holder.name))].join(' and ');
    const why = holding.map((l) => l.reason).find(Boolean);
    const waitMs = this.options.lockWaitMs ?? 10 * 60_000;
    const minutes = Math.max(1, Math.round(waitMs / 60_000));
    this.notice(
      chatId,
      `Waiting for ${names} to release ${path}${why ? ` (locked for "${why}")` : ''}. It goes on by itself once the lock is free; press Stop to give up.`,
    );
    this.setState(chatId, 'waiting', lockWaitActivity(names, path));
    const result = await new Promise<'free' | 'abandoned' | 'timeout' | 'stopped'>((resolve) => {
      const check = () => {
        const current = this.client.getState().locks.filter((l) => ids.has(l.id));
        if (current.length === 0) finish('free');
        else if (current.every((l) => l.abandoned)) finish('abandoned');
      };
      const finish = (value: 'free' | 'abandoned' | 'timeout' | 'stopped') => {
        clearTimeout(timer);
        off();
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => finish('stopped');
      const timer = setTimeout(() => finish('timeout'), waitMs);
      const off = this.client.subscribe(check);
      signal.addEventListener('abort', onAbort, { once: true });
      check();
    });
    if (!signal.aborted) this.setState(chatId, 'working', `Editing ${path}`);
    switch (result) {
      case 'free':
        return null;
      case 'stopped':
        return 'stopped';
      case 'abandoned':
        return `${path} is locked by ${names}, who stopped answering (recover the lock on Locks and GitHub first)`;
      case 'timeout':
        return `${path} is still locked by ${names} after ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
    }
  }

  private async gateCommand(chat: ChatInfo, agent: AgentProfile, command: string, signal: AbortSignal): Promise<string | null> {
    const decision = checkCommand({ agent }, command);
    if (decision.verdict === 'deny') return decision.reasons.join('; ');
    if (decision.verdict === 'ask') {
      const shown = command.length > 300 ? `${command.slice(0, 300)}…` : command;
      const approved = await this.askApproval(chat.id, `Run ${shown}`, decision.reasons.join('; '), signal);
      if (!approved) return signal.aborted ? 'stopped' : 'a person did not approve running this command';
    }
    return null;
  }

  /**
   * After a command or a CLI run: files it changed that the agent may not
   * change are shown for approval, and undone unless a person keeps them.
   * Files locked by someone else are always undone.
   */
  private async reviewChanges(chat: ChatInfo, agent: AgentProfile, before: Set<string>, what: string, signal: AbortSignal) {
    const after = await this.files.changedFiles();
    const fresh = [...after].filter((f) => !before.has(f) && !this.run(chat.id).approvedPaths.has(f.toLowerCase()));
    if (fresh.length === 0) return;
    const ctx = this.guardContext(chat, agent);
    const undo: string[] = [];
    const ask: { path: string; reason: string }[] = [];
    for (const file of fresh) {
      const decision = checkEdit(ctx, file);
      if (!decision.path) continue;
      if (decision.verdict === 'deny') {
        undo.push(decision.path);
        continue;
      }
      if (decision.verdict === 'ask') ask.push({ path: decision.path, reason: decision.reasons.join('; ') });
      else {
        const problem = await this.ensureLock(decision.path, decision.lockKind, chat);
        if (problem) undo.push(decision.path);
      }
    }
    if (ask.length > 0) {
      const list = ask.map((a) => `${a.path}: ${a.reason}`).join('\n');
      const keep = await this.askApproval(chat.id, `Keep ${ask.length} ${ask.length === 1 ? 'change' : 'changes'} ${what} made`, list, signal);
      if (keep) {
        for (const a of ask) {
          const kind = checkEdit(this.guardContext(chat, agent), a.path).lockKind;
          if (await this.ensureLock(a.path, kind, chat)) undo.push(a.path);
        }
      } else undo.push(...ask.map((a) => a.path));
    }
    const undone: string[] = [];
    for (const path of undo) {
      try {
        await this.files.revert(path);
        undone.push(path);
      } catch (error) {
        this.notice(chat.id, `Could not undo ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (undone.length > 0) this.notice(chat.id, `Undid changes ${what} made to ${undone.join(', ')}.`);
  }

  // Our own loop, for model APIs.

  private async runApi(chat: ChatInfo, agent: AgentProfile, run: ChatRun, prompt: string) {
    const factory = this.options.createModel;
    if (!factory) throw new Error('This PC cannot run API agents');
    const model = factory(agent);
    const history = run.history!;
    history.push({ role: 'user', text: prompt });
    const signal = run.abort!.signal;
    const maxSteps = this.options.maxSteps ?? 40;
    for (let step = 0; step < maxSteps; step++) {
      const current = this.chat(chat.id) ?? chat;
      const task = this.client.getState().tasks.find((t) => t.id === current.taskId) ?? null;
      const writer = this.textWriter(chat.id);
      const turn = await model.complete({
        system: systemPrompt(this.contextInput(agent, current, task)),
        messages: history,
        tools: AGENT_TOOLS,
        signal,
        onText: writer.append,
      });
      writer.finish(turn.text);
      if (turn.stop === 'refusal') {
        history.push({ role: 'assistant', text: turn.text, toolCalls: [] });
        this.notice(chat.id, 'The model declined to continue with this request.');
        return;
      }
      if (turn.stop === 'max_tokens' && turn.toolCalls.length > 0) {
        // A cut-off tool input must not run.
        history.push({ role: 'assistant', text: turn.text, toolCalls: [] });
        this.notice(chat.id, 'The answer was cut off before the agent finished; ask it to continue in smaller steps.');
        return;
      }
      history.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls, raw: turn.raw });
      if (turn.toolCalls.length === 0) return;
      const results: ToolResult[] = [];
      for (const call of turn.toolCalls) {
        if (signal.aborted) results.push({ id: call.id, content: 'Stopped by a person.', isError: true });
        else results.push(await this.executeTool(current, agent, run, call, signal));
      }
      history.push({ role: 'tool', results });
      this.setState(chat.id, 'working', 'Thinking');
      if (signal.aborted) throw new Error('stopped');
    }
    this.notice(chat.id, `Paused after ${maxSteps} steps. Send a message to let it continue.`);
  }

  private async executeTool(chat: ChatInfo, agent: AgentProfile, run: ChatRun, call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const id = randomUUID();
    const label = TOOL_LABEL[call.name] ?? call.name;
    const show = (summary: string, status: ToolStatus, output = '') => {
      if (status === 'running') this.setActivity(chat.id, `${TOOL_ACTIVITY[call.name] ?? label} ${summary}`);
      this.postTool(chat.id, id, { name: label, summary, status, output });
    };
    const ok = (content: string): ToolResult => ({ id: call.id, content, isError: false });
    const error = (content: string): ToolResult => ({ id: call.id, content, isError: true });
    const attempt = async (summary: string, work: () => Promise<string>): Promise<ToolResult> => {
      show(summary, 'running');
      try {
        const output = await work();
        show(summary, 'done', output.length > 600 ? `${output.slice(0, 600)}…` : output);
        return ok(output);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        show(summary, 'failed', message);
        return error(message);
      }
    };
    const blocked = (summary: string, why: string): ToolResult => {
      show(summary, 'blocked', why);
      return error(`Blocked: ${why}. Do not try to make this change another way; tell the people in the chat what you need.`);
    };

    switch (call.name) {
      case 'read_file': {
        const input = parseInput(ReadFileInput, call.input);
        if (!input.ok) return error(input.error);
        run.filesRead.add(input.value.path);
        return attempt(input.value.path, () => this.files.read(input.value.path, input.value.offset, input.value.limit));
      }
      case 'list_files': {
        const input = parseInput(ListFilesInput, call.input);
        if (!input.ok) return error(input.error);
        return attempt(input.value.path || 'project', () => this.files.list(input.value.path));
      }
      case 'search': {
        const input = parseInput(SearchInput, call.input);
        if (!input.ok) return error(input.error);
        return attempt(input.value.pattern, () => this.files.search(input.value.pattern, input.value.path));
      }
      case 'write_file':
      case 'edit_file': {
        const input = call.name === 'write_file' ? parseInput(WriteFileInput, call.input) : parseInput(EditFileInput, call.input);
        if (!input.ok) return error(input.error);
        const gate = await this.gateEdit(chat, agent, input.value.path, signal);
        if ('blocked' in gate) return blocked(input.value.path, gate.blocked);
        const value = input.value;
        return attempt(gate.path, () =>
          'content' in value ? this.files.write(gate.path, value.content) : this.files.edit(gate.path, value.old_text, value.new_text),
        );
      }
      case 'run_command': {
        const input = parseInput(RunCommandInput, call.input);
        if (!input.ok) return error(input.error);
        const command = input.value.command;
        const problem = await this.gateCommand(chat, agent, command, signal);
        if (problem) return blocked(command, problem);
        const before = await this.files.changedFiles();
        show(command, 'running');
        const result = await this.files.run(command, signal);
        const output = `${result.output}\n(exit code ${result.exitCode ?? 'none'})`;
        show(command, result.exitCode === 0 ? 'done' : 'failed', output);
        await this.reviewChanges(chat, agent, before, 'the command', signal);
        return result.exitCode === 0 ? ok(output) : error(output);
      }
      case 'record_test_result': {
        const input = parseInput(RecordTestResultInput, call.input);
        if (!input.ok) return error(input.error);
        const task = this.client.getState().tasks.find((t) => t.id === chat.taskId);
        const criterion = task?.criteria.find((c) => c.id === input.value.criterion_id);
        if (!task || !criterion) return error('This chat’s task has no acceptance criterion with that id.');
        const result = input.value.result === 'verified' ? 'Verified' : 'Failing';
        show(`${result}: ${criterion.text}`, 'done', input.value.evidence);
        this.client.verifyCriterion(task.id, criterion.id, input.value.result, input.value.evidence);
        return ok(`Recorded "${criterion.text}" as ${input.value.result}.`);
      }
      default:
        return error(`There is no tool called ${call.name}.`);
    }
  }

  // CLI agents.

  private async runCliAgent(chat: ChatInfo, agent: AgentProfile, run: ChatRun, prompt: string, messages: ChatMessage[], fresh: ChatMessage[]) {
    if (agent.connection.type !== 'cli') return;
    const settings = this.options.cli;
    if (!settings) throw new Error('This PC cannot run command-line agents');
    const tool = agent.connection.tool;
    const command = settings.commands?.[tool] ?? CLI_TOOLS[tool].command;
    const signal = run.abort!.signal;
    const task = this.client.getState().tasks.find((t) => t.id === chat.taskId) ?? null;
    const context = systemPrompt(this.contextInput(agent, chat, task));
    const before = await this.files.changedFiles();

    // Tool lines by the CLI's own tool ids.
    const toolMessages = new Map<string, { id: string; name: string; summary: string }>();
    let failure: string | null = null;
    const onEvent = (event: CliEvent) => {
      switch (event.type) {
        case 'session':
          run.cliSession = event.id;
          break;
        case 'text':
          this.client.postChat(chat.id, { kind: 'text', text: event.text });
          break;
        case 'tool': {
          const existing = toolMessages.get(event.id);
          const entry = existing ?? { id: randomUUID(), name: event.name, summary: event.summary };
          toolMessages.set(event.id, entry);
          if (!existing) {
            this.postTool(chat.id, entry.id, { name: entry.name, summary: entry.summary, status: 'running', output: '' });
            this.setActivity(chat.id, `${entry.name} ${entry.summary}`.trim());
          }
          break;
        }
        case 'tool_result': {
          const entry = toolMessages.get(event.id);
          if (entry) this.postTool(chat.id, entry.id, { name: entry.name, summary: entry.summary, status: event.failed ? 'failed' : 'done', output: event.output });
          break;
        }
        case 'error':
          failure = event.message;
          break;
      }
    };

    let result: { exitCode: number | null; stderr: string };
    if (tool === 'claude-code') {
      const hook = await this.hookServer();
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--settings', hook.claudeSettingsFile(settings.hookScript, settings.nodePath)];
      if (agent.connection.model) args.push('--model', agent.connection.model);
      if (run.cliSession) args.push('--resume', run.cliSession);
      // A new session (a branched chat, or after a restart) gets the conversation so far once.
      const earlier = run.cliSession ? '' : transcript(messages.filter((m) => !fresh.includes(m)));
      const fullPrompt = run.cliSession ? prompt : `${context}\n\n---\n\n${earlier ? `Conversation so far:\n${earlier}\n\n---\n\n` : ''}${prompt}`;
      result = await runCli({
        command,
        args,
        cwd: this.options.root,
        env: { ...process.env, ...settings.hookEnv, ...hook.env(chat.id) },
        prompt: fullPrompt,
        signal,
        parse: parseClaudeLine,
        onEvent,
      });
    } else {
      // Codex gets the recent conversation each time instead of resuming a session.
      const recent = transcript(messages, 20);
      const args = ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check'];
      if (agent.connection.model) args.push('-m', agent.connection.model);
      args.push('-');
      result = await runCli({
        command,
        args,
        cwd: this.options.root,
        env: { ...process.env },
        prompt: `${context}\n\n---\n\n${recent ? `Conversation so far:\n${recent}\n\n---\n\n` : ''}${prompt}`,
        signal,
        parse: parseCodexLine,
        onEvent,
      });
    }
    // Open tool lines of a stopped or failed run stay readable.
    for (const entry of toolMessages.values()) {
      if (signal.aborted) this.postTool(chat.id, entry.id, { name: entry.name, summary: entry.summary, status: 'failed', output: 'stopped' });
    }
    await this.reviewChanges(chat, agent, before, CLI_TOOLS[tool].label, new AbortController().signal);
    if (signal.aborted) throw new Error('stopped');
    if (failure || (result.exitCode !== 0 && result.exitCode !== null)) {
      const detail = failure ?? (result.stderr.trim().split('\n').slice(-3).join(' ') || `exit code ${result.exitCode}`);
      throw new Error(`${CLI_TOOLS[tool].label}: ${detail}`);
    }
    if (result.exitCode === null && !failure) throw new Error(`${CLI_TOOLS[tool].label} could not be started. Is it installed?`);
  }

  private async hookServer(): Promise<HookServer> {
    if (!this.hook) this.hook = new HookServer((request) => this.decideHook(request));
    await this.hook.start();
    return this.hook;
  }

  /** Claude Code asks before each tool use; the same checks as our own loop apply. */
  private async decideHook(request: HookRequest): Promise<{ allow: boolean; reason: string }> {
    const chat = this.chat(request.chatId);
    const agent = this.profile();
    const run = this.runs.get(request.chatId);
    if (!chat || !agent || !run?.abort) return { allow: false, reason: 'This chat is not running here.' };
    const signal = run.abort.signal;
    const input = request.toolInput;
    const deny = (reason: string) => {
      this.notice(chat.id, `Blocked ${request.toolName}: ${reason}.`);
      return { allow: false, reason: `Blocked by the collaboration app: ${reason}. Do not try another way; tell the people in the chat what you need.` };
    };
    switch (request.toolName) {
      case 'Write':
      case 'Edit':
      case 'MultiEdit':
      case 'NotebookEdit': {
        const raw = String(input.file_path ?? input.notebook_path ?? '');
        const rel = this.files.toRelative(raw);
        if (!rel) return deny(`${raw} is outside the project folder`);
        const gate = await this.gateEdit(chat, agent, rel, signal);
        if ('blocked' in gate) return deny(gate.blocked);
        run.approvedPaths.add(gate.path.toLowerCase());
        return { allow: true, reason: 'Checked by the collaboration app' };
      }
      case 'Bash': {
        const problem = await this.gateCommand(chat, agent, String(input.command ?? ''), signal);
        return problem ? deny(problem) : { allow: true, reason: 'Checked by the collaboration app' };
      }
      case 'Read':
      case 'NotebookRead': {
        const rel = this.files.toRelative(String(input.file_path ?? input.notebook_path ?? ''));
        if (rel) run.filesRead.add(rel);
        return { allow: true, reason: 'Reading is allowed' };
      }
      case 'Glob':
      case 'Grep':
      case 'LS':
      case 'TodoWrite':
      case 'Task':
      case 'WebSearch':
      case 'WebFetch':
      case 'ExitPlanMode':
        return { allow: true, reason: 'Allowed' };
      default: {
        // Other tools (MCP and the like) follow the command rule.
        const problem = await this.gateCommand(chat, agent, `${request.toolName} tool`, signal);
        return problem ? deny(problem) : { allow: true, reason: 'Checked by the collaboration app' };
      }
    }
  }
}

/** A message from a person that the agent should answer. */
function isPrompt(m: ChatMessage): boolean {
  return m.author.kind === 'human' && (m.kind === 'text' || m.kind === 'handoff') && m.text.trim() !== '';
}

function formatPrompt(m: ChatMessage): string {
  return m.kind === 'handoff' ? m.text : `${m.author.name}: ${m.text}`;
}

/** The chat's text messages as plain text, for CLI agents that do not keep the conversation themselves. */
function transcript(messages: ChatMessage[], limit = 50): string {
  return messages
    .filter((m) => m.kind === 'text' || m.kind === 'handoff')
    .slice(-limit)
    .map((m) => `${m.author.name}: ${m.text}`)
    .join('\n\n');
}

/** The conversation so far, from the chat, when the agent starts (or restarts) on it. */
function rebuildHistory(messages: ChatMessage[]): LoopMessage[] {
  const out: LoopMessage[] = [];
  for (const m of messages) {
    if (isPrompt(m)) out.push({ role: 'user', text: formatPrompt(m) });
    else if (m.author.kind === 'agent' && m.kind === 'text' && m.text.trim() && out.length > 0) {
      out.push({ role: 'assistant', text: m.text, toolCalls: [] });
    }
  }
  return out;
}

/** After a stop or failure, every tool call must still have a result, or the next request is invalid. */
function repairHistory(history: LoopMessage[] | null) {
  const last = history?.[history.length - 1];
  if (history && last?.role === 'assistant' && last.toolCalls.length > 0) {
    history.push({ role: 'tool', results: last.toolCalls.map((c) => ({ id: c.id, content: 'Stopped before this ran.', isError: true })) });
  }
}

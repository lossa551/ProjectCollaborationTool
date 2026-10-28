import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath, resolve as resolvePath } from 'node:path';
import {
  CLI_TOOLS,
  SETUP_CONFIG_PATH,
  WORKSPACE_FILE_LIMIT,
  AGENT_ERROR_PREFIX,
  approvalActivity,
  describeLayoutProblems,
  epicLayoutProblems,
  parseSetupConfig,
  unrealLayout,
  budgetsFor,
  commitDraftUsageId,
  formatCost,
  priceFor,
  tokenCost,
  usageDay,
  lockWaitActivity,
  notesForPaths,
  samePath,
  type AgentProfile,
  type ApprovalState,
  type ChatAgentState,
  type ChatInfo,
  type ChatMessage,
  type ChatTool,
  type ChatWorktree,
  type FolderNote,
  type Lock,
  type LockKind,
  type ServerMessage,
  type SessionClient,
  type Task,
  type TokenUsage,
  type ToolStatus,
  type UsageSource,
  type UndoMode,
  type SetupConfig,
} from '@pct/shared';
import { HookServer, parseClaudeLine, parseCodexLine, runCli, type CliEvent, type HookRequest } from './cli.js';
import { describeContext, systemPrompt, type ContextInput } from './context.js';
import {
  ENGINE_BRIDGES,
  LIVE_EDITOR_BRIDGES,
  EngineBridge,
  claudeEngineTool,
  classifyEngineCall,
  describeTests,
  findGodotProject,
  findTestFramework,
  godotTestCommand,
  parseTestOutput,
  readEngineAnswer,
  seedGodotCache,
  type EngineCall,
  type EngineServer,
  type EngineSettings,
} from './engine.js';
import {
  findUnrealProject,
  parseUnrealTestOutput,
  unrealReceiptChanges,
  unrealTestCommand,
  unrealToRepoPath,
  type UnrealProject,
} from './unreal.js';
import { ProjectFiles } from './files.js';
import { checkCommand, checkEdit, othersLocks, type GuardContext } from './guard.js';
import { parseInput, type LoopMessage, type ModelAdapter, type ToolCall, type ToolResult } from './models/types.js';
import {
  AGENT_TOOLS,
  EditFileInput,
  ListFilesInput,
  ReadFileInput,
  runTestsTool,
  RecordTestResultInput,
  RunCommandInput,
  RunTestsInput,
  SearchInput,
  WriteFileInput,
} from './tools.js';
import type { ToolSpec } from './models/types.js';
import {
  agentBranchName,
  canMakeWorktrees,
  isRepository,
  changedBetween,
  commitAll,
  createWorktree,
  defaultWorktreeFolder,
  headCommit,
  isAncestor,
  pickBase,
  removeWorktree,
  resetTo,
  revertCommit,
  worktreeReady,
  worktreeStatus,
} from './worktree.js';

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
  /** The person's project folder. Each chat works in its own copy of it (see worktrees). */
  root: string;
  /** The person whose PC runs the agent; owns the chats' copies. Defaults to startedBy with no id. */
  startedById?: string;
  /**
   * Each chat gets its own git worktree on an agent/... branch (the default).
   * folder says where a copy goes; false works in the project folder itself.
   */
  worktrees?: false | { folder?: (root: string, branch: string) => string };
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
  /**
   * The game engine on this PC for this agent: its MCP server and Godot's
   * executable (issue #10). Read at the start of each turn, so a change in
   * settings applies from the next turn. Leave out for no engine.
   */
  engine?: (agent: AgentProfile) => EngineSettings | null;
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
  /** Where this chat works: its own copy, or the project folder. Set at the start of its first turn. */
  files: ProjectFiles | null;
  /** The chat's copy, as last reported. */
  worktree: ChatWorktree | null;
  /** Said in the chat that its task is done but the copy has unmerged work. */
  doneNoticed: boolean;
  /** Its task was finished during a turn: look at the copy once the turn ends. */
  doneDuringTurn: boolean;
  /** Highest turn number checkpointed, so quick turns in a row do not wait for the server's echo. */
  lastTurn: number;
  /** Told to the agent with its next prompt, e.g. that a person undid one of its turns. */
  notes: string[];
  /** Per budget (see budgetsFor), how far a person said the agent may go past it. */
  budgetOk: Map<string, number>;
  /** Model calls of the CLI run going on now, by id, until the tool reports the run's usage. */
  live: Map<string, { model: string | null; usage: TokenUsage }>;
  /** Said in the chat instead of "Stopped." when the run was stopped for a reason. */
  stopNotice: string | null;
  /** The game engine for this turn; null when the project has none or this agent does not use it. */
  engine: ChatEngine | null;
  /** Said in the chat that the engine could not be reached, so it is not said every turn. */
  engineProblem: string | null;
}

/** A Godot (or Summer Engine) or Unreal project, as one chat sees it. */
interface ChatEngine {
  server: EngineServer | null;
  /** The project.godot folder, repo-relative ('' for an Unreal project). */
  godotDir: string;
  /** The Unreal project; null for a Godot one. */
  unreal: UnrealProject | null;
  /** The same folder on disk, in the folder the chat works in. */
  projectDir: string;
  /** The engine's tools for our own loop; empty for CLI agents (they get the server themselves). */
  tools: ToolSpec[];
  /** Runs the tests headless; null without Godot's path and a test add-on, or Unreal's editor. */
  testCommand: ((target?: string) => Promise<string>) | null;
  /** How the tests are run, for the agent's instructions. */
  testHint: string | null;
  /** The test add-on, as people know it. */
  testLabel: string;
}

/** The Godot MCP server's tools that take no project folder. */
const GODOT_NO_PROJECT = new Set(['get_debug_output', 'stop_project', 'get_godot_version', 'list_projects']);

/** How tool lines name each engine. */
const BRIDGE_SHORT: Record<EngineServer['kind'], string> = { godot: 'Godot', summer: 'Summer', unreal: 'Unreal' };

const BUDGET_PAUSED = 'Paused: the budget is used up. Raise the budget, or send a message to be asked again.';

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
  run_tests: 'Running the tests',
};

const TOOL_LABEL: Record<string, string> = {
  read_file: 'Read',
  list_files: 'List',
  search: 'Search',
  write_file: 'Write',
  edit_file: 'Edit',
  run_command: 'Run',
  record_test_result: 'Test result',
  run_tests: 'Tests',
};

export class AgentRunner {
  private readonly files: ProjectFiles;
  private readonly runs = new Map<string, ChatRun>();
  private readonly waiters = new Map<string, (state: ApprovalState) => void>();
  private readonly unsubscribe: (() => void)[] = [];
  private hook: HookServer | null = null;
  private stopped = false;
  /** The engine's MCP server, started on first use and shared by the agent's chats. */
  private bridge: EngineBridge | null = null;
  /** Claude Code's --mcp-config file for the engine server. */
  private mcpConfig: { file: string; text: string } | null = null;

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
    this.bridge?.close();
    this.bridge = null;
    if (this.mcpConfig) rmSync(this.mcpConfig.file, { force: true });
    this.mcpConfig = null;
  }

  /**
   * Answers one prompt outside any chat, with no tools: used to draft a
   * commit message. What the call uses counts for this agent and the task.
   */
  async draft(prompt: string, taskId: string | null, signal: AbortSignal, purpose = 'git commit messages'): Promise<string> {
    const agent = this.profile();
    if (!agent) throw new Error('This agent no longer exists.');
    // Every draft (commit messages, folder notes) counts as the agent's own usage.
    const usageId = commitDraftUsageId(agent.id);
    const record = (model: string, source: UsageSource, usage: TokenUsage, cost: number | null) =>
      this.client.recordUsage({ chatId: usageId, model, source, ...usage, cost, day: usageDay(Date.now()), taskId });
    const connection = agent.connection;
    if (connection.type === 'api') {
      const factory = this.options.createModel;
      if (!factory) throw new Error('This PC cannot run API agents');
      const turn = await factory(agent).complete({
        system: `You are ${agent.name}, writing ${purpose} for a project you work on with people.`,
        messages: [{ role: 'user', text: prompt }],
        tools: [],
        signal,
        onText: () => {},
      });
      if (turn.usage) record(turn.model ?? connection.model, connection.provider === 'ollama' ? 'free' : 'priced', turn.usage, null);
      if (turn.stop === 'refusal') throw new Error('The model declined to write a message.');
      return turn.text;
    }
    const settings = this.options.cli;
    if (!settings) throw new Error('This PC cannot run command-line agents');
    const tool = connection.tool;
    const command = settings.commands?.[tool] ?? CLI_TOOLS[tool].command;
    const fallbackModel = connection.model ?? tool;
    const texts: string[] = [];
    const live = new Map<string, { model: string | null; usage: TokenUsage }>();
    let reported = false;
    let failure: string | null = null;
    const onEvent = (event: CliEvent) => {
      if (event.type === 'text') texts.push(event.text);
      else if (event.type === 'error') failure = event.message;
      else if (event.type === 'progress') live.set(event.id, { model: event.model, usage: event.usage });
      else if (event.type === 'usage') {
        reported = true;
        record(event.model ?? fallbackModel, event.cost === null ? 'priced' : 'reported', event.usage, event.cost);
      }
    };
    let result: { exitCode: number | null; stderr: string };
    if (tool === 'claude-code') {
      // Through the hook with no chat behind it, so every tool is refused.
      const hook = await this.hookServer();
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--settings', hook.claudeSettingsFile(settings.hookScript, settings.nodePath)];
      if (connection.model) args.push('--model', connection.model);
      result = await runCli({ command, args, cwd: this.options.root, env: { ...process.env, ...settings.hookEnv, ...hook.env(usageId) }, prompt, signal, parse: parseClaudeLine, onEvent });
    } else {
      const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check'];
      if (connection.model) args.push('-m', connection.model);
      args.push('-');
      result = await runCli({ command, args, cwd: this.options.root, env: { ...process.env }, prompt, signal, parse: parseCodexLine, onEvent });
    }
    if (!reported) for (const call of live.values()) record(call.model ?? fallbackModel, 'priced', call.usage, null);
    if (signal.aborted) throw new Error('stopped');
    if (failure || (result.exitCode !== 0 && result.exitCode !== null)) {
      const detail = failure ?? (result.stderr.trim().split('\n').slice(-3).join(' ') || `exit code ${result.exitCode}`);
      throw new Error(`${CLI_TOOLS[tool].label}: ${detail}`);
    }
    if (result.exitCode === null) throw new Error(`${CLI_TOOLS[tool].label} could not be started. Is it installed?`);
    return texts.at(-1) ?? '';
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
        files: null,
        worktree: null,
        doneNoticed: false,
        doneDuringTurn: false,
        lastTurn: 0,
        notes: [],
        budgetOk: new Map(),
        live: new Map(),
        stopNotice: null,
        engine: null,
        engineProblem: null,
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
      case 'chat.removed': {
        const run = this.runs.get(message.chatId);
        this.runs.delete(message.chatId);
        if (run?.worktree) void this.retireWorktree(run.worktree);
        break;
      }
      case 'task.changed':
        if (message.task.stage === 'done') void this.taskDone(message.task);
        break;
      case 'chat.undo':
        if (this.chat(message.chatId)) void this.undoTurn(message.chatId, message.messageId, message.mode, message.by);
        break;
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
        const prompt = [...run.notes.splice(0), ...fresh.map(formatPrompt)].join('\n\n');

        run.abort = new AbortController();
        run.stoppedBy = null;
        run.stopNotice = null;
        run.approvedPaths.clear();
        try {
          await this.workspaceFor(chat, run);
          // Edits made in the copy by hand since the last turn are not part of this one.
          await this.saveCopy(run, 'Changes made in the copy between agent turns');
          run.folderNotes = await this.loadFolderNotes(chat);
          run.engine = await this.engineFor(chat, agent, run);
          this.setState(chatId, 'working', 'Thinking');
          if (agent.connection.type === 'api') await this.runApi(chat, agent, run, prompt);
          else await this.runCliAgent(chat, agent, run, prompt, messages, fresh);
        } catch (error) {
          if (run.abort.signal.aborted) {
            this.notice(chatId, run.stopNotice ?? (run.stoppedBy ? `Stopped by ${run.stoppedBy}.` : 'Stopped.'));
          } else {
            this.notice(chatId, `${AGENT_ERROR_PREFIX}${error instanceof Error ? error.message : String(error)}`);
            this.log(`agent ${agent.name} failed: ${String(error)}`);
          }
          repairHistory(run.history);
        }
        await this.checkpoint(chatId, run);
        run.abort = null;
      } while (run.again && !this.stopped);
    } finally {
      run.busy = false;
      run.abort = null;
      if (!this.stopped) {
        this.setState(chatId, 'idle');
        await this.reportWorktree(chatId);
        await this.releaseUnchanged((lock) => lock.chatId === chatId);
        const task = this.client.getState().tasks.find((t) => t.id === this.chat(chatId)?.taskId);
        if (run.doneDuringTurn && task?.stage === 'done') await this.taskDone(task);
        run.doneDuringTurn = false;
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
    // Each chat's own copy, or the project folder for locks taken outside a chat.
    const changedIn = new Map<string, string[]>();
    const changed = async (chatId: string | null) => {
      const key = chatId ?? '';
      let files = changedIn.get(key);
      if (!files) {
        const run = chatId ? this.runs.get(chatId) : undefined;
        files = run?.worktree && run.files ? await this.worktreeFiles(run) : [...(await (run?.files ?? this.files).changedFiles())];
        changedIn.set(key, files);
      }
      return files;
    };
    for (const lock of mine) {
      const busy = !stopping && lock.chatId !== null && this.runs.get(lock.chatId)?.busy;
      if (!busy && !(await changed(lock.chatId)).some((file) => samePath(file, lock.path))) this.client.releaseLock(lock.id);
    }
  }

  /** Files the chat's copy changed and nobody merged yet, committed or not. */
  private async worktreeFiles(run: ChatRun): Promise<string[]> {
    const worktree = run.worktree!;
    try {
      const status = await worktreeStatus(worktree.folder, { branch: worktree.base, commit: worktree.baseCommit });
      return status.files.map((f) => f.path);
    } catch {
      return worktree.files.map((f) => f.path);
    }
  }

  /** The person whose PC runs the agent, who owns its copies. */
  private owner(): ChatWorktree['owner'] {
    return { id: this.options.startedById ?? '', name: this.options.startedBy };
  }

  /**
   * Where the chat works. With git, its own copy of the project on an
   * agent/... branch: the one it had, or a new one started from the task's
   * branch (else the branch checked out in the project folder). Without git
   * (or with no commit yet) it works in the project folder.
   */
  private async workspaceFor(chat: ChatInfo, run: ChatRun): Promise<ProjectFiles> {
    const setting = this.options.worktrees;
    if (setting === false) return (run.files ??= this.files);
    // Summer Engine and the Unreal Editor edit the project they have open, which is the project folder: chats
    // that use them work there too. A chat that already has a copy keeps it (and is told the editor cannot reach it).
    const agent = this.profile();
    const bridge = agent ? this.options.engine?.(agent)?.server?.kind : undefined;
    if (!run.worktree && !chat.worktree && bridge && LIVE_EDITOR_BRIDGES.has(bridge)) {
      return (run.files = this.files);
    }
    const known = run.worktree ?? (chat.worktree?.owner.id === this.owner().id ? chat.worktree : null);
    if (known && run.files && (await worktreeReady(known.folder, known.branch))) return run.files;
    if (!(await canMakeWorktrees(this.options.root))) {
      // The chat header shows no copy, and the agent is told it works in the project folder.
      if (!run.files) {
        this.log(`${this.options.root} has no git history yet: chat ${chat.id} works in the project folder`);
        if (await isRepository(this.options.root)) {
          this.notice(
            chat.id,
            `${this.options.startedBy}'s project has no commit yet, so ${this.profile()?.name ?? 'the agent'} works directly in the project folder instead of a copy of its own. ` +
              'Make the first commit (offered at the top of this chat and on the GitHub page) and the next turn starts in its own copy.',
          );
        }
      }
      return (run.files = this.files);
    }
    const root = this.options.root;
    const task = this.client.getState().tasks.find((t) => t.id === chat.taskId) ?? null;
    const branch = known?.branch ?? agentBranchName(task?.title ?? chat.title, chat.id);
    const folder = known?.folder ?? (setting?.folder ?? defaultWorktreeFolder)(root, branch);
    const reused = known !== null && (await worktreeReady(folder, branch));
    const base = known ? { base: known.base, ref: known.baseCommit } : await pickBase(root, [task?.branch]);
    const { baseCommit } = await createWorktree({ root, folder, branch, from: base.ref });
    run.files = new ProjectFiles(resolvePath(folder));
    run.worktree = {
      branch,
      base: base.base,
      baseCommit,
      folder: resolvePath(folder),
      owner: this.owner(),
      files: known?.files ?? [],
      truncated: false,
      commits: known?.commits ?? 0,
      uncommitted: known?.uncommitted ?? 0,
      head: known?.head ?? null,
      updatedAt: Date.now(),
    };
    if (!reused) {
      // A Godot project's import cache comes along, so the engine does not import every asset again.
      await seedGodotCache(root, folder).catch((error: unknown) => this.log(`could not copy the Godot cache: ${String(error)}`));
    }
    if (!known) {
      const from = base.base ? `${base.base} at ${baseCommit.slice(0, 7)}` : baseCommit.slice(0, 7);
      this.notice(
        chat.id,
        `${this.profile()?.name ?? 'The agent'} works in its own copy of the project on branch ${branch}, started from ${from}. ` +
          `Its changes stay there until someone merges them, so ${this.options.startedBy}'s project folder is not touched ` +
          '(and uncommitted changes there are not in the copy).',
      );
    } else if (!reused) {
      this.notice(chat.id, `The agent's copy was missing, so it was made again from branch ${branch}.`);
    }
    await this.reportWorktree(chat.id);
    return run.files;
  }

  /** Commits anything uncommitted in the chat's copy. */
  private async saveCopy(run: ChatRun, message: string): Promise<void> {
    if (!run.worktree) return;
    try {
      await commitAll(run.worktree.folder, message);
    } catch (error) {
      this.log(`could not save ${run.worktree.folder}: ${String(error)}`);
    }
  }

  /** The chat's checkpoint messages, oldest first. */
  private checkpoints(chatId: string): ChatMessage[] {
    return (this.client.getState().messages[chatId] ?? []).filter((m) => m.kind === 'checkpoint' && m.checkpoint);
  }

  /**
   * Saves what the turn changed in the chat's copy as a commit, and posts a
   * checkpoint for it in the chat so people can undo the turn later. Turns
   * that changed nothing get none.
   */
  private async checkpoint(chatId: string, run: ChatRun) {
    const worktree = run.worktree;
    const chat = this.chat(chatId);
    if (!worktree || !chat) return;
    try {
      const parent = await headCommit(worktree.folder);
      const turn = Math.max(run.lastTurn, ...this.checkpoints(chatId).map((m) => m.checkpoint!.turn)) + 1;
      const commit = await commitAll(worktree.folder, `${chat.title} - turn ${turn}`);
      if (!commit || !parent) return;
      run.lastTurn = turn;
      const files = await changedBetween(worktree.folder, parent, commit);
      const count = `${files.length} ${files.length === 1 ? 'file' : 'files'}`;
      this.client.postChat(chatId, {
        kind: 'checkpoint',
        text: `Turn ${turn}: ${count} changed, saved as ${commit.slice(0, 7)} on ${worktree.branch}.`,
        checkpoint: {
          turn,
          commit,
          parent,
          branch: worktree.branch,
          files: files.slice(0, WORKSPACE_FILE_LIMIT),
          truncated: files.length > WORKSPACE_FILE_LIMIT,
          undone: null,
          revertCommit: null,
        },
      });
    } catch (error) {
      this.log(`could not save a checkpoint for chat ${chatId}: ${String(error)}`);
      this.notice(chatId, `Could not save this turn as a checkpoint, so it cannot be undone from here: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Undoes the turn of a checkpoint (a new commit puts its files back), or
   * takes the copy back to the end of that turn, as a person asked. Locks on
   * files that are no longer changed are freed, the chat and the activity
   * feed say who did it, and the agent is told with its next prompt.
   */
  private async undoTurn(chatId: string, messageId: string, mode: UndoMode, by: string) {
    const chat = this.chat(chatId);
    const checkpoint = this.checkpoints(chatId).find((m) => m.id === messageId)?.checkpoint;
    if (!chat || !checkpoint) return;
    const run = this.run(chatId);
    const agentName = this.profile()?.name ?? 'The agent';
    const turn = `turn ${checkpoint.turn}`;
    const fail = (why: string) => this.notice(chatId, `Could not ${mode === 'undo' ? `undo ${turn}` : `go back to ${turn}`} for ${by}: ${why}.`);
    const worktree = run.worktree ?? (chat.worktree?.owner.id === this.owner().id ? chat.worktree : null);
    if (run.busy) return fail(`${agentName} is working; wait until it finishes or stop it first`);
    if (!worktree || !(await worktreeReady(worktree.folder, worktree.branch))) return fail('the agent’s copy of the project is gone');
    if (worktree.branch !== checkpoint.branch) return fail(`that turn was made in another copy (${checkpoint.branch})`);
    if (mode === 'undo' && checkpoint.undone) return fail('it is already undone');

    run.busy = true;
    try {
      if (!run.worktree) {
        run.worktree = worktree;
        run.files = new ProjectFiles(worktree.folder);
      }
      await this.saveCopy(run, 'Changes made in the copy between agent turns');
      const folder = worktree.folder;
      let restored: string[];
      let revert: string | null = null;
      if (mode === 'undo') {
        revert = await revertCommit(folder, checkpoint.commit, `Undo turn ${checkpoint.turn} of ${chat.title} (${by})`);
        restored = checkpoint.files.map((f) => f.path);
      } else {
        const head = await headCommit(folder);
        if (!head || head === checkpoint.commit) return fail('the copy is already there');
        restored = (await changedBetween(folder, checkpoint.commit, head)).map((f) => f.path);
        await resetTo(folder, checkpoint.commit, `refs/pct-backup/${worktree.branch}/${Date.now()}`);
      }
      await this.markCheckpoints(chatId, folder, worktree.branch, { by, mode, messageId, revert });

      const list = listPaths(restored);
      if (mode === 'undo') {
        this.notice(chatId, `${by} undid turn ${checkpoint.turn}. Back to how they were before it: ${list}.`);
        run.notes.push(
          `Note from Foreus: ${by} undid your turn ${checkpoint.turn}. These files are back to how they were before it: ${list}. ` +
            'Read them again before you build on anything from that turn.',
        );
      } else {
        this.notice(
          chatId,
          `${by} took the copy back to the end of turn ${checkpoint.turn}. ${restored.length > 0 ? `Changed back: ${list}. ` : ''}` +
            'Later turns can be brought back with "Go back to here" on them.',
        );
        run.notes.push(
          `Note from Foreus: ${by} took your copy back to how it was at the end of your turn ${checkpoint.turn}; ` +
            `everything you changed after that is gone${restored.length > 0 ? ` (${list})` : ''}. Read files again before you build on later work.`,
        );
      }
      run.busy = false;
      const what = mode === 'undo' ? `undid turn ${checkpoint.turn} of "${chat.title}"` : `took "${chat.title}" back to turn ${checkpoint.turn}`;
      await this.reportWorktree(chatId, `${what} (${agentName}, ${restored.length} ${restored.length === 1 ? 'file' : 'files'})`, by);
      // Files only that turn touched are not changed any more: their locks go.
      await this.releaseUnchanged((lock) => lock.chatId === chatId);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      run.busy = false;
      // Someone posted while the copy was being changed.
      if (run.again && !this.stopped) {
        run.again = false;
        void this.turn(chatId);
      }
    }
  }

  /**
   * Brings every checkpoint of the copy's branch up to date with what the
   * copy holds now: a turn counts as undone when its commit is not in the
   * copy any more, or the commit that undid it is.
   */
  private async markCheckpoints(
    chatId: string,
    folder: string,
    branch: string,
    change: { by: string; mode: UndoMode; messageId: string; revert: string | null },
  ) {
    const head = await headCommit(folder);
    if (!head) return;
    for (const m of this.checkpoints(chatId)) {
      const checkpoint = m.checkpoint!;
      if (checkpoint.branch !== branch) continue;
      const revertCandidate = m.id === change.messageId && change.revert ? change.revert : checkpoint.revertCommit;
      const revertCommit = revertCandidate && (await isAncestor(folder, revertCandidate, head)) ? revertCandidate : null;
      const kept = !revertCommit && (await isAncestor(folder, checkpoint.commit, head));
      const undone = kept ? null : (checkpoint.undone ?? { by: change.by, at: Date.now(), how: change.mode });
      if (undone === checkpoint.undone && revertCommit === checkpoint.revertCommit) continue;
      this.client.postChat(chatId, { id: m.id, kind: 'checkpoint', text: m.text, checkpoint: { ...checkpoint, undone, revertCommit } });
    }
  }

  /** Tells everyone what the chat's copy holds now. */
  private async reportWorktree(chatId: string, note?: string, noteBy?: string) {
    const run = this.runs.get(chatId);
    const worktree = run?.worktree;
    if (!run || !worktree || !this.chat(chatId)) return;
    let next = worktree;
    try {
      const status = await worktreeStatus(worktree.folder, { branch: worktree.base, commit: worktree.baseCommit });
      next = { ...worktree, ...status, updatedAt: Date.now() };
    } catch (error) {
      this.log(`could not read the copy for chat ${chatId}: ${String(error)}`);
    }
    // Removed (task done, chat deleted) while reading: nothing to report.
    if (run.worktree !== worktree || !this.chat(chatId)) return;
    run.worktree = next;
    this.client.setChatWorktree(chatId, next, note, noteBy);
  }

  /**
   * A finished task: copies with nothing left to merge are removed with their
   * branch; the others stay, and the chat says what is left.
   */
  private async taskDone(task: Task) {
    for (const chat of this.myChats().filter((c) => c.taskId === task.id)) {
      const run = this.runs.get(chat.id);
      const worktree = run?.worktree ?? (chat.worktree?.owner.id === this.owner().id ? chat.worktree : null);
      if (!worktree) continue;
      if (run?.busy) {
        run.doneDuringTurn = true;
        continue;
      }
      let status;
      try {
        status = await worktreeStatus(worktree.folder, { branch: worktree.base, commit: worktree.baseCommit });
      } catch {
        continue;
      }
      if (status.commits === 0 && status.uncommitted === 0) {
        try {
          await removeWorktree(this.options.root, worktree.folder, worktree.branch, true);
        } catch (error) {
          this.log(`could not remove ${worktree.folder}: ${String(error)}`);
          continue;
        }
        if (run) {
          run.worktree = null;
          run.files = null;
        }
        this.client.setChatWorktree(chat.id, null, `removed the agent's copy ${worktree.branch} because "${task.title}" is done`);
      } else if (run && !run.doneNoticed) {
        run.doneNoticed = true;
        const what = [
          status.commits > 0 ? `${status.commits} ${status.commits === 1 ? 'commit' : 'commits'}` : '',
          status.uncommitted > 0 ? `${status.uncommitted} uncommitted ${status.uncommitted === 1 ? 'file' : 'files'}` : '',
        ]
          .filter(Boolean)
          .join(' and ');
        this.notice(chat.id, `"${task.title}" is done, but the agent's copy (${worktree.branch}) still has ${what} that are not merged. Merge or discard them from this chat.`);
      }
    }
  }

  /**
   * A deleted chat's copy: its folder goes, but anything in it is committed
   * to its branch first and the branch is kept, so no work is lost. (Deleting
   * from the owner's PC asks first and cleans up there.)
   */
  private async retireWorktree(worktree: ChatWorktree) {
    if (!(await worktreeReady(worktree.folder, worktree.branch))) return;
    try {
      await commitAll(worktree.folder, `Work in progress, saved when the chat was deleted`);
      await removeWorktree(this.options.root, worktree.folder, worktree.branch, false);
      this.log(`chat deleted: kept its work on branch ${worktree.branch}`);
    } catch (error) {
      this.log(`could not tidy up ${worktree.folder}: ${String(error)}`);
    }
  }

  /** Where the chat works: its own copy once its first turn started, else the project folder. */
  private filesOf(chatId: string): ProjectFiles {
    return this.runs.get(chatId)?.files ?? this.files;
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
    const files = this.filesOf(chat.id);
    for (const path of notesForPaths(await files.notePaths(), paths)) {
      try {
        const { abs } = await files.resolve(path);
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
      worktree: this.runs.get(chat.id)?.worktree ?? null,
      recordsResults: agent.connection.type === 'api',
      engine: this.engineContext(this.runs.get(chat.id)?.engine ?? null, agent),
    };
  }

  private engineContext(engine: ChatEngine | null, agent: AgentProfile): ContextInput['engine'] {
    if (!engine) return null;
    return {
      bridge: engine.server ? ENGINE_BRIDGES[engine.server.kind].label : null,
      liveEditor: !!engine.server && LIVE_EDITOR_BRIDGES.has(engine.server.kind),
      godotDir: engine.godotDir,
      unreal: engine.unreal ? { dir: engine.unreal.dir, name: engine.unreal.name } : null,
      projectDir: engine.projectDir,
      tests: engine.testHint ? (agent.connection.type === 'api' ? 'tool' : engine.testHint) : null,
    };
  }

  private recordUsage(chatId: string, model: string, source: UsageSource, usage: TokenUsage, cost: number | null) {
    this.client.recordUsage({ chatId, model, source, ...usage, cost, day: usageDay(Date.now()) });
  }

  /** What the CLI run going on now has used, by the price table, before the tool reports it. */
  private liveCost(run: ChatRun, fallbackModel: string | null): number {
    const prices = this.client.getState().prices;
    let cost = 0;
    for (const call of run.live.values()) cost += tokenCost(call.usage, priceFor(call.model ?? fallbackModel ?? '', prices)) ?? 0;
    return cost;
  }

  /**
   * Checks the chat's and its task's budgets. Over one, the agent shows an
   * approval card and goes on only if a person approves; it then asks again
   * after another budget's worth. Resolves false to stop here.
   */
  private async withinBudget(chat: ChatInfo, run: ChatRun, signal: AbortSignal): Promise<boolean> {
    for (;;) {
      const state = this.client.getState();
      const current = state.chats.find((c) => c.id === chat.id) ?? chat;
      const task = state.tasks.find((t) => t.id === current.taskId) ?? null;
      const agent = this.profile();
      const extra = this.liveCost(run, agent?.connection.model ?? null);
      const over = budgetsFor(current, task, state.usage, state.prices, extra).find(
        (b) => b.spent >= Math.max(b.limit, run.budgetOk.get(b.key) ?? 0),
      );
      if (!over) return true;
      if (signal.aborted) return false;
      const approved = await this.askApproval(
        chat.id,
        `Keep going past the ${formatCost(over.limit)} budget`,
        `${capitalize(over.label)} has spent ${formatCost(over.spent)} of its ${formatCost(over.limit)} budget. ` +
          `If you approve, the agent goes on and asks again after another ${formatCost(over.limit)}.`,
        signal,
      );
      if (!approved) return false;
      run.budgetOk.set(over.key, over.spent + over.limit);
      // The other budget may be used up too: check again.
    }
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

  /** action: what the approval card says, when the app made the command itself (e.g. the tests). */
  private async gateCommand(chat: ChatInfo, agent: AgentProfile, command: string, signal: AbortSignal, action?: string): Promise<string | null> {
    const decision = checkCommand({ agent }, command);
    if (decision.verdict === 'deny') return decision.reasons.join('; ');
    if (decision.verdict === 'ask') {
      const shown = command.length > 300 ? `${command.slice(0, 300)}…` : command;
      const approved = await this.askApproval(chat.id, action ?? `Run ${shown}`, decision.reasons.join('; '), signal);
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
    const after = await this.filesOf(chat.id).changedFiles();
    const fresh = [...after].filter((f) => !before.has(f) && !this.run(chat.id).approvedPaths.has(f.toLowerCase()));
    if (fresh.length === 0) return;
    await this.flagUnrealLayout(chat, fresh);
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
        await this.filesOf(chat.id).revert(path);
        undone.push(path);
      } catch (error) {
        this.notice(chat.id, `Could not undo ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (undone.length > 0) this.notice(chat.id, `Undid changes ${what} made to ${undone.join(', ')}.`);
  }

  /** Unreal assets and levels a run saved where Epic's structure or naming says otherwise are pointed out in the chat. */
  private async flagUnrealLayout(chat: ChatInfo, paths: string[]) {
    const assets = paths.filter((p) => /\.(uasset|umap)$/i.test(p));
    if (assets.length === 0) return;
    const project = this.runs.get(chat.id)?.engine?.unreal ?? (await findUnrealProject(this.filesOf(chat.id).root));
    if (!project) return;
    const layout = unrealLayout(project.uproject, await this.setupConfig());
    const wrong = assets.map((path) => ({ path, problems: epicLayoutProblems(path, layout) })).filter((w) => w.problems.length > 0);
    if (wrong.length === 0) return;
    this.notice(chat.id, `Not by Epic's folder structure or naming: ${wrong.slice(0, 5).map((w) => describeLayoutProblems(w.path, w.problems)).join(' ')}`);
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
    const connection = agent.connection;
    const source: UsageSource = connection.type === 'api' && connection.provider === 'ollama' ? 'free' : 'priced';
    for (let step = 0; step < maxSteps; step++) {
      if (!(await this.withinBudget(chat, run, signal))) {
        if (signal.aborted) throw new Error('stopped');
        this.notice(chat.id, BUDGET_PAUSED);
        return;
      }
      const current = this.chat(chat.id) ?? chat;
      const task = this.client.getState().tasks.find((t) => t.id === current.taskId) ?? null;
      const writer = this.textWriter(chat.id);
      const turn = await model.complete({
        system: systemPrompt(this.contextInput(agent, current, task)),
        messages: history,
        tools: this.toolsFor(run),
        signal,
        onText: writer.append,
      });
      writer.finish(turn.text);
      if (turn.usage) this.recordUsage(chat.id, turn.model ?? (connection.type === 'api' ? connection.model : agent.name), source, turn.usage, null);
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
    const files = this.filesOf(chat.id);
    const engineLabel = this.bridge?.serverName(call.name) ? BRIDGE_SHORT[this.bridge.server.kind] : null;
    const label = TOOL_LABEL[call.name] ?? engineLabel ?? call.name;
    const show = (summary: string, status: ToolStatus, output = '') => {
      if (status === 'running') this.setActivity(chat.id, `${TOOL_ACTIVITY[call.name] ?? (engineLabel ? `${engineLabel}:` : label)} ${summary}`);
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
        return attempt(input.value.path, () => files.read(input.value.path, input.value.offset, input.value.limit));
      }
      case 'list_files': {
        const input = parseInput(ListFilesInput, call.input);
        if (!input.ok) return error(input.error);
        return attempt(input.value.path || 'project', () => files.list(input.value.path));
      }
      case 'search': {
        const input = parseInput(SearchInput, call.input);
        if (!input.ok) return error(input.error);
        return attempt(input.value.pattern, () => files.search(input.value.pattern, input.value.path));
      }
      case 'write_file':
      case 'edit_file': {
        const input = call.name === 'write_file' ? parseInput(WriteFileInput, call.input) : parseInput(EditFileInput, call.input);
        if (!input.ok) return error(input.error);
        const gate = await this.gateEdit(chat, agent, input.value.path, signal);
        if ('blocked' in gate) return blocked(input.value.path, gate.blocked);
        const value = input.value;
        return attempt(gate.path, () =>
          'content' in value ? files.write(gate.path, value.content) : files.edit(gate.path, value.old_text, value.new_text),
        );
      }
      case 'run_command': {
        const input = parseInput(RunCommandInput, call.input);
        if (!input.ok) return error(input.error);
        const command = input.value.command;
        const problem = await this.gateCommand(chat, agent, command, signal);
        if (problem) return blocked(command, problem);
        const before = await files.changedFiles();
        show(command, 'running');
        const result = await files.run(command, signal);
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
      case 'run_tests': {
        const input = parseInput(RunTestsInput, call.input);
        if (!input.ok) return error(input.error);
        const tests = run.engine?.testCommand;
        if (!tests) {
          return error(
            run.engine?.unreal
              ? 'The app does not know where Unreal Engine is on this PC, so it cannot run the tests.'
              : 'This project has no tests the app can run (it needs Godot’s path in Settings and the GUT or gdUnit4 add-on).',
          );
        }
        const command = await tests(input.value.target);
        const what = `Run the game’s tests (${run.engine!.testLabel}${input.value.target ? `, ${input.value.target}` : ''})`;
        const problem = await this.gateCommand(chat, agent, command, signal, what);
        if (problem) return blocked('tests', problem);
        const before = await files.changedFiles();
        const summary = input.value.target ?? 'all tests';
        show(summary, 'running');
        // Unreal starts a whole editor (without rendering) for the tests, which takes a while.
        const result = await files.run(command, signal, (run.engine!.unreal ? 30 : 10) * 60_000);
        const tested = run.engine!.unreal ? parseUnrealTestOutput(result.output, result.exitCode) : parseTestOutput(result.output, result.exitCode);
        const output = `${describeTests(tested)}\n\n${result.output}\n(exit code ${result.exitCode ?? 'none'})`;
        show(summary, tested.passed ? 'done' : 'failed', output);
        await this.reviewChanges(chat, agent, before, 'the tests', signal);
        return tested.passed ? ok(output) : error(output);
      }
      default: {
        const tool = this.bridge?.serverName(call.name);
        if (tool && run.engine?.server) return this.engineTool(chat, agent, run, call, tool, signal, show, ok, error, blocked);
        return error(`There is no tool called ${call.name}.`);
      }
    }
  }

  /** The tools our own loop offers: the usual ones, the engine's, and the tests when they can run. */
  private toolsFor(run: ChatRun): ToolSpec[] {
    const engine = run.engine;
    if (!engine) return AGENT_TOOLS;
    return [...AGENT_TOOLS, ...(engine.testCommand ? [runTestsTool(engine.unreal ? 'unreal' : 'godot')] : []), ...engine.tools];
  }

  /** The engine server for these settings, started again when they changed. */
  private bridgeFor(server: EngineServer): EngineBridge {
    if (this.bridge && this.bridge.sameAs(server)) return this.bridge;
    this.bridge?.close();
    this.bridge = new EngineBridge(server, this.options.root);
    return this.bridge;
  }

  /**
   * The chat's engine for this turn: the Godot project in the folder it
   * works in, the engine server's tools (our own loop), and the test command.
   * Null when the project has no project.godot or the agent has no engine.
   */
  private async engineFor(chat: ChatInfo, agent: AgentProfile, run: ChatRun): Promise<ChatEngine | null> {
    const settings = this.options.engine?.(agent) ?? null;
    if (!settings) return null;
    const files = this.filesOf(chat.id);
    const godotDir = await findGodotProject(files.root);
    const unreal = godotDir === null ? await findUnrealProject(files.root) : null;
    if (godotDir === null && !unreal) return null;
    let testCommand: ChatEngine['testCommand'] = null;
    let testHint: string | null = null;
    let testLabel = 'Unreal Automation';
    let projectDir: string;
    if (unreal) {
      projectDir = unreal.dir ? joinPath(files.root, ...unreal.dir.split('/')) : files.root;
      const editor = settings.unrealEditor;
      const uproject = joinPath(files.root, ...unreal.uproject.split('/'));
      if (editor) {
        testCommand = async (target) => unrealTestCommand(editor, uproject, target);
        testHint = await testCommand();
      }
    } else {
      projectDir = godotDir ? joinPath(files.root, ...godotDir.split('/')) : files.root;
      const framework = await findTestFramework(projectDir);
      if (settings.godotPath && framework) {
        const godotPath = settings.godotPath;
        testCommand = (target) => godotTestCommand(godotPath, projectDir, framework, target);
        testHint = await testCommand();
      }
      testLabel = framework === 'gdunit4' ? 'gdUnit4' : 'GUT';
    }
    // Each engine's server only fits its own projects.
    const fits = (kind: EngineServer['kind']) => (unreal ? kind === 'unreal' : kind !== 'unreal');
    let tools: ToolSpec[] = [];
    const server = settings.server && fits(settings.server.kind) ? settings.server : null;
    if (server && agent.connection.type === 'api') {
      try {
        tools = await this.bridgeFor(server).specs();
        run.engineProblem = null;
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        if (run.engineProblem !== why) {
          run.engineProblem = why;
          this.notice(chat.id, `${ENGINE_BRIDGES[server.kind].label} could not be reached, so the agent works without it this turn: ${why}`);
        }
        this.bridge?.close();
        this.bridge = null;
      }
    }
    return {
      server: tools.length > 0 || agent.connection.type === 'cli' ? server : null,
      godotDir: godotDir ?? '',
      unreal,
      projectDir,
      tools,
      testCommand,
      testHint,
      testLabel,
    };
  }

  /** The project's setup file (.collab-tool.json), for the Unreal layout it allows. */
  private async setupConfig(): Promise<SetupConfig | null> {
    return parseSetupConfig(await readFile(joinPath(this.options.root, SETUP_CONFIG_PATH), 'utf8').catch(() => null));
  }

  /**
   * After an Unreal call: what EngineWire's receipt says it changed, beyond
   * the files the call named, is checked and locked too. Returns what to tell
   * the agent when it changed something it may not (or someone else holds),
   * or null.
   */
  private async lockUnrealChanges(
    chat: ChatInfo,
    agent: AgentProfile,
    project: UnrealProject,
    call: EngineCall,
    text: string,
    root: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    const exists = (rel: string) => existsSync(joinPath(root, ...rel.split('/')));
    const named = new Set(call.kind === 'edit' ? call.paths.map((p) => p.toLowerCase()) : []);
    const changed = unrealReceiptChanges(text)
      .map((objectPath) => unrealToRepoPath(objectPath, project, exists))
      .filter((path): path is string => !!path && !named.has(path.toLowerCase()));
    if (changed.length === 0) return null;
    const problems: string[] = [];
    for (const path of [...new Set(changed)]) {
      const gate = await this.gateEdit(chat, agent, path, signal);
      if ('blocked' in gate) problems.push(`${path}: ${gate.blocked}`);
      else this.run(chat.id).approvedPaths.add(gate.path.toLowerCase());
    }
    if (problems.length === 0) return null;
    this.notice(chat.id, `The Unreal Editor changed files the agent may not change: ${problems.join('; ')}. The agent is asked to undo it.`);
    return `The call also changed files you may not change: ${problems.join('; ')}. Undo it now (control_editor undo) and do not save those assets.`;
  }

  /** Sorts an engine call for this chat (see classifyEngineCall). */
  private classify(engine: ChatEngine, kind: EngineServer['kind'], tool: string, input: unknown, root: string): EngineCall {
    const unreal = engine.unreal ? { project: engine.unreal, exists: (rel: string) => existsSync(joinPath(root, ...rel.split('/'))) } : undefined;
    return classifyEngineCall(kind, tool, input, engine.godotDir, root, unreal);
  }

  /**
   * Checks one engine call before it runs: reading is allowed; changing
   * project files is checked and locked like a file edit; anything else
   * follows the agent's rule for commands. Returns why not, or null.
   */
  private async gateEngine(chat: ChatInfo, agent: AgentProfile, run: ChatRun, call: EngineCall, signal: AbortSignal): Promise<string | null> {
    const kind = run.engine?.server?.kind;
    if (kind && LIVE_EDITOR_BRIDGES.has(kind) && run.worktree && call.kind !== 'read') {
      const name = kind === 'summer' ? 'Summer Engine' : 'The Unreal Editor';
      return (
        `${name} changes the project open in its editor, but this chat works in its own copy (${run.worktree.branch}); ` +
        `start a new chat to work through the editor, or make the change with file edits here`
      );
    }
    if (call.kind === 'read') return null;
    if (call.kind === 'action') return this.gateCommand(chat, agent, call.what, signal);
    // New Unreal assets go where Epic's folder structure says and are named by Epic's conventions.
    const unreal = run.engine?.unreal;
    if (unreal && call.fresh?.length) {
      const layout = unrealLayout(unreal.uproject, await this.setupConfig());
      const wrong = call.fresh
        .map((path) => ({ path, problems: epicLayoutProblems(path, layout, call.expected) }))
        .filter((w) => w.problems.length > 0);
      if (wrong.length) {
        this.notice(chat.id, `Refused ${call.what}: ${wrong.map((w) => w.path).join(', ')} would not follow Epic's folder structure or asset naming.`);
        return `${wrong.map((w) => describeLayoutProblems(w.path, w.problems)).join(' ')} Pick a path and name that follow them and call again`;
      }
    }
    if (call.ask) {
      const approved = await this.askApproval(chat.id, `${call.what.replace(/^Unreal /, 'Unreal: ')} ${call.paths.join(', ')}`, 'Deletes or overwrites assets in the Unreal project.', signal);
      if (!approved) return signal.aborted ? 'stopped' : 'a person did not approve this';
    }
    for (const path of call.paths) {
      const gate = await this.gateEdit(chat, agent, path, signal);
      if ('blocked' in gate) return gate.blocked;
      run.approvedPaths.add(gate.path.toLowerCase());
    }
    return null;
  }

  /** An engine tool call from our own loop: checked, run on the engine's server, and what it changed reviewed. */
  private async engineTool(
    chat: ChatInfo,
    agent: AgentProfile,
    run: ChatRun,
    call: ToolCall,
    tool: string,
    signal: AbortSignal,
    show: (summary: string, status: ToolStatus, output?: string) => void,
    ok: (content: string) => ToolResult,
    error: (content: string) => ToolResult,
    blocked: (summary: string, why: string) => ToolResult,
  ): Promise<ToolResult> {
    const engine = run.engine!;
    const files = this.filesOf(chat.id);
    let input = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>;
    // The Godot server works on whichever folder it is given: always the one this chat works in.
    if (engine.server!.kind === 'godot') {
      if (tool === 'list_projects') input = { ...input, directory: engine.projectDir };
      else if (!GODOT_NO_PROJECT.has(tool)) input = { ...input, projectPath: engine.projectDir };
    }
    const classified = this.classify(engine, engine.server!.kind, tool, input, files.root);
    // The tool line is labelled with the engine already.
    const what = classified.what.replace(/^(Godot|Summer|Unreal) /, '');
    const summary = classified.kind === 'edit' ? `${what} ${classified.paths.join(', ')}` : what;
    const problem = await this.gateEngine(chat, agent, run, classified, signal);
    if (problem) return blocked(summary, problem);
    const before = classified.kind === 'read' ? null : await files.changedFiles();
    show(summary, 'running');
    let result;
    try {
      result = await this.bridge!.call(tool, input, signal);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      show(summary, 'failed', message);
      return error(message);
    }
    const answer = readEngineAnswer(result.text);
    if (answer.conflict) {
      show(summary, 'failed', `Refused: ${answer.conflict}`);
      this.notice(chat.id, `Summer Engine did not overwrite a file that changed since the agent read it (${summary}). The agent reads it again first.`);
      return error(`Summer refused because the file changed since you read it: ${answer.conflict}. Read it again, then retry.`);
    }
    if (answer.approvalUrl) this.notice(chat.id, `Summer Engine needs a person to approve this first: ${answer.approvalUrl}`);
    const receipts = answer.receipts.length ? `\nWrote: ${answer.receipts.join(', ')}` : '';
    const failed = result.isError || answer.error !== null;
    if (engine.unreal && classified.kind !== 'read' && !failed) {
      const problem = await this.lockUnrealChanges(chat, agent, engine.unreal, classified, result.text, files.root, signal);
      if (problem) {
        show(summary, 'failed', problem);
        return error(`${result.text}\n\n${problem}`);
      }
    }
    const output = `${result.text}${receipts}`;
    show(summary, failed ? 'failed' : 'done', output.length > 600 ? `${output.slice(0, 600)}…` : output);
    // Files the engine changed that the call did not name are checked like a command's.
    if (before) await this.reviewChanges(chat, agent, before, ENGINE_BRIDGES[engine.server!.kind].label, signal);
    return failed ? error(output) : ok(output);
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
    const files = this.filesOf(chat.id);
    const before = await files.changedFiles();

    // A budget used up before the run starts: ask first.
    if (!(await this.withinBudget(chat, run, signal))) {
      if (signal.aborted) throw new Error('stopped');
      this.notice(chat.id, BUDGET_PAUSED);
      return;
    }
    // Usage is recorded under the model the tool names, else the one set for the agent.
    const fallbackModel = agent.connection.model ?? tool;
    let reported = false;
    run.live.clear();

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
          if (entry && claudeEngineTool(entry.name)) {
            const answer = readEngineAnswer(event.output);
            if (answer.conflict) this.notice(chat.id, `Summer Engine did not overwrite a file that changed since the agent read it: ${answer.conflict}`);
            if (answer.approvalUrl) this.notice(chat.id, `Summer Engine needs a person to approve this first: ${answer.approvalUrl}`);
          }
          break;
        }
        case 'error':
          failure = event.message;
          break;
        case 'progress':
          run.live.set(event.id, { model: event.model, usage: event.usage });
          break;
        case 'usage':
          reported = true;
          this.recordUsage(chat.id, event.model ?? fallbackModel, event.cost === null ? 'priced' : 'reported', event.usage, event.cost);
          break;
      }
    };

    let result: { exitCode: number | null; stderr: string };
    if (tool === 'claude-code') {
      const hook = await this.hookServer();
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--settings', hook.claudeSettingsFile(settings.hookScript, settings.nodePath)];
      if (agent.connection.model) args.push('--model', agent.connection.model);
      if (run.cliSession) args.push('--resume', run.cliSession);
      // The engine's server, as its own MCP server; every call is still asked through the hook.
      if (run.engine?.server) args.push('--mcp-config', this.mcpConfigFile(run.engine.server));
      // A new session (a branched chat, or after a restart) gets the conversation so far once.
      const earlier = run.cliSession ? '' : transcript(messages.filter((m) => !fresh.includes(m)));
      const fullPrompt = run.cliSession ? prompt : `${context}\n\n---\n\n${earlier ? `Conversation so far:\n${earlier}\n\n---\n\n` : ''}${prompt}`;
      result = await runCli({
        command,
        args,
        cwd: files.root,
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
        cwd: files.root,
        env: { ...process.env },
        prompt: `${context}\n\n---\n\n${recent ? `Conversation so far:\n${recent}\n\n---\n\n` : ''}${prompt}`,
        signal,
        parse: parseCodexLine,
        onEvent,
      });
    }
    // A run stopped before the tool reported its usage still counts what it used so far.
    if (!reported) {
      for (const call of run.live.values()) this.recordUsage(chat.id, call.model ?? fallbackModel, 'priced', call.usage, null);
    }
    run.live.clear();
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

  /** Claude Code's --mcp-config file for the engine server, written once per settings. */
  private mcpConfigFile(server: EngineServer): string {
    const text = new EngineBridge(server, this.options.root).claudeConfig();
    if (this.mcpConfig?.text === text) return this.mcpConfig.file;
    if (this.mcpConfig) rmSync(this.mcpConfig.file, { force: true });
    const file = joinPath(tmpdir(), `pct-engine-mcp-${randomBytes(6).toString('hex')}.json`);
    writeFileSync(file, text, { mode: 0o600 });
    this.mcpConfig = { file, text };
    return file;
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
      return { allow: false, reason: `Blocked by Foreus: ${reason}. Do not try another way; tell the people in the chat what you need.` };
    };
    // The run so far may have used up a budget: ask before it does more.
    if (!(await this.withinBudget(chat, run, signal))) {
      if (!signal.aborted) {
        run.stopNotice = BUDGET_PAUSED;
        run.abort.abort();
      }
      return { allow: false, reason: 'The budget for this work is used up; a person has to raise it first.' };
    }
    switch (request.toolName) {
      case 'Write':
      case 'Edit':
      case 'MultiEdit':
      case 'NotebookEdit': {
        const raw = String(input.file_path ?? input.notebook_path ?? '');
        const rel = this.filesOf(chat.id).toRelative(raw);
        if (!rel) return deny(`${raw} is outside the project folder`);
        const gate = await this.gateEdit(chat, agent, rel, signal);
        if ('blocked' in gate) return deny(gate.blocked);
        run.approvedPaths.add(gate.path.toLowerCase());
        return { allow: true, reason: 'Checked by Foreus' };
      }
      case 'Bash': {
        const problem = await this.gateCommand(chat, agent, String(input.command ?? ''), signal);
        return problem ? deny(problem) : { allow: true, reason: 'Checked by Foreus' };
      }
      case 'Read':
      case 'NotebookRead': {
        const rel = this.filesOf(chat.id).toRelative(String(input.file_path ?? input.notebook_path ?? ''));
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
        const engineTool = claudeEngineTool(request.toolName);
        const engine = run.engine;
        const kind = engineTool?.kind ?? engine?.server?.kind;
        if (engineTool && engine && kind) {
          // The Godot server works on whichever folder it is given: it must be this chat's.
          const given = typeof input.projectPath === 'string' ? input.projectPath : null;
          if (kind === 'godot' && given !== null && !samePath(resolvePath(given), resolvePath(engine.projectDir))) {
            return deny(`this chat's Godot project is ${engine.projectDir}; call the tool again with projectPath set to that`);
          }
          const call = this.classify(engine, kind, engineTool.tool, input, this.filesOf(chat.id).root);
          const problem = await this.gateEngine(chat, agent, run, call, signal);
          return problem ? deny(problem) : { allow: true, reason: 'Checked by Foreus' };
        }
        // Other tools (MCP and the like) follow the command rule.
        const problem = await this.gateCommand(chat, agent, `${request.toolName} tool`, signal);
        return problem ? deny(problem) : { allow: true, reason: 'Checked by Foreus' };
      }
    }
  }
}

/** Paths for a chat line: the first few, then how many more. */
function listPaths(paths: string[], max = 8): string {
  if (paths.length === 0) return 'no files';
  const shown = paths.slice(0, max).join(', ');
  return paths.length > max ? `${shown} and ${paths.length - max} more` : shown;
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

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

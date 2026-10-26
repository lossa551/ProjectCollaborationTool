import type {
  AgentSaveMessage,
  CliTool,
  FileChange,
  Handoff,
  CriterionState,
  LockRules,
  MemoryOp,
  PlanApproval,
  PlanOp,
  RepoRef,
  SessionState,
  TaskChanges,
  TaskStage,
  Workspace,
} from '@pct/shared';
import type { FolderNotesReport } from './folder-notes';

// The bridge between the window (renderer) and the main process, exposed by
// the preload script as window.pct.

export interface HostingInfo {
  invite: string;
  /** Address put in the invite and where it came from. */
  address: string;
  addressSource: 'tailscale' | 'lan' | 'loopback';
  port: number;
}

/** Your local checkout, as git sees it. */
export interface LocalWorkspace {
  folder: string;
  /** The GitHub repository of the origin remote, if it is on GitHub. */
  remote: RepoRef | null;
  workspace: Workspace | null;
  git: GitInfo | null;
  error: string | null;
}

/** What the Git card on the GitHub page needs about your checkout. */
export interface GitInfo {
  /** The remote branch this one tracks, e.g. "origin/main". */
  upstream: string | null;
  /** Commits you have that the upstream does not, and the other way round (as of the last fetch). */
  ahead: number;
  behind: number;
  /** Changes not committed yet. */
  uncommitted: { path: string; change: FileChange }[];
  /** Files with merge conflicts. */
  conflicted: string[];
  /** A merge (e.g. from a pull) is in progress. */
  merging: boolean;
  /** Local branches. */
  branches: string[];
  /** Branches on GitHub (as of the last fetch) that you do not have locally. */
  remoteBranches: string[];
}

export type GitAction =
  | { type: 'fetch' }
  | { type: 'pull' }
  | { type: 'push' }
  | { type: 'commit'; message: string }
  | { type: 'switch'; branch: string }
  /** from: start from the latest version of this GitHub branch; null starts from the current branch. */
  | { type: 'create-branch'; branch: string; from: string | null }
  | { type: 'abort-merge' };

/** An agent started on this PC. */
export interface LocalAgent {
  status: 'starting' | 'running' | 'error';
  error: string | null;
  /** The project folder it works in. */
  folder: string;
}

export interface AppState {
  session: SessionState;
  hosting: HostingInfo | null;
  /** Tasks can be changed: connected, or offline in a session we know (changes sync later). */
  canEditTasks: boolean;
  /** Your project folder in this session, once you picked one. */
  workspace: LocalWorkspace | null;
  /** Where the hosted server's GitHub token comes from; null when not hosting. */
  githubToken: 'saved' | 'cli' | 'none' | null;
  /** Agents running on this PC, by agent profile id. */
  localAgents: Record<string, LocalAgent>;
  /** API keys available on this PC by key name (see apiKeyName): saved in the app or from an environment variable. */
  apiKeys: Record<string, 'saved' | 'env'>;
  /** Command-line agents installed on this PC. */
  cliTools: Record<CliTool, boolean>;
  /**
   * How many live text edits from the window have been applied to the shared
   * documents. An editor whose own edits are still on the way waits for them
   * before taking in the shared text (see LiveText).
   */
  textEdits: number;
}

export interface HandoffRequest {
  /** The chat the handoff comes from, if any. */
  fromChatId: string | null;
  taskId: string | null;
  /** The agent profile that takes over. */
  agentId: string;
  /** Title of the new chat; made from the task or the sender otherwise. */
  title?: string;
  handoff: Omit<Handoff, 'fromChatId' | 'fromName'>;
}

export type ResultWith<T> = { ok: true; value: T } | { ok: false; error: string };

export interface HostRequest {
  name: string;
  sessionName: string;
}

export interface JoinRequest {
  name: string;
  invite: string;
}

export type Result = { ok: true } | { ok: false; error: string };

/** A session you hosted or joined on this PC, listed on the start screen. */
export interface SavedSessionInfo {
  key: string;
  role: 'host' | 'join';
  name: string;
  /** The invite code you joined with, or the last one you shared as host. */
  invite: string | null;
  /** The linked GitHub repository, as owner/name. */
  repo: string | null;
  /** Your project folder in that session. */
  folder: string | null;
  lastUsedAt: number;
}

export interface ResumeRequest {
  name: string;
  key: string;
}

/** Where the installed app is in updating itself from GitHub Releases. */
export type UpdateState =
  | { status: 'unavailable'; message: string }
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'up-to-date' }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string };

export interface UpdateInfo {
  /** The version running now. */
  version: string;
  state: UpdateState;
}

export interface PctApi {
  getState(): Promise<AppState>;
  host(request: HostRequest): Promise<Result>;
  join(request: JoinRequest): Promise<Result>;
  /** Sessions hosted or joined on this PC, most recent first. */
  listSessions(): Promise<SavedSessionInfo[]>;
  /** Hosts a saved session again, or rejoins it with its saved invite code. */
  resume(request: ResumeRequest): Promise<Result>;
  /** Asks, then removes the session from the list (and a hosted session's saved board). */
  forgetSession(key: string): Promise<Result>;
  leave(): Promise<void>;
  setPresence(status: 'active' | 'idle' | 'away', focus: string | null): void;
  createTask(title: string, stage: TaskStage): void;
  updateTask(taskId: string, changes: TaskChanges): void;
  deleteTask(taskId: string): void;
  acquireLock(path: string, options: { taskId: string | null; exclusive: boolean }): void;
  releaseLock(lockId: string): void;
  recoverLock(lockId: string): void;
  setLockRules(rules: LockRules): void;
  /** Asks for your project folder and starts sharing its branch and changed files. */
  chooseWorkspace(): Promise<Result>;
  stopWorkspace(): void;
  /** Asks where to put the linked repository, clones it there and makes it your project folder. */
  cloneRepo(): Promise<Result>;
  /** Runs a git action in your project folder; the value says what happened. */
  gitAction(action: GitAction): Promise<ResultWith<string>>;
  /** "owner/name" or a GitHub URL; null unlinks. */
  linkRepo(repo: string | null): Promise<Result>;
  /** Host only: saves (or with null removes) the token the session server uses for GitHub. */
  setGitHubToken(token: string | null): Promise<Result>;
  copyText(text: string): void;
  saveAgent(agent: AgentSaveMessage['agent']): Promise<Result>;
  deleteAgent(agentId: string): void;
  /** Starts an agent on this PC, in your project folder. */
  startAgent(agentId: string): Promise<Result>;
  stopAgent(agentId: string): void;
  /** Saves (or with null removes) an API key on this PC only. */
  setApiKey(name: string, key: string | null): Promise<Result>;
  createChat(request: { agentId: string; title: string; taskId: string | null }): Promise<ResultWith<string>>;
  updateChat(chatId: string, changes: { title?: string; taskId?: string | null }): void;
  deleteChat(chatId: string): void;
  openChat(chatId: string): void;
  postChat(chatId: string, text: string): void;
  decideApproval(chatId: string, messageId: string, approve: boolean): void;
  stopChat(chatId: string): void;
  /** Creates a task from the chat and links the chat to it. */
  chatToTask(chatId: string): Promise<Result>;
  /** Starts a chat with another agent carrying the handoff package; returns the new chat's id. */
  handOff(request: HandoffRequest): Promise<ResultWith<string>>;
  /** Changes the planning space; works offline and syncs later. */
  editPlanning(op: PlanOp): void;
  /** Creates the feature's tasks (with their acceptance criteria) and marks the plan approved. */
  approvePlan(approval: PlanApproval): Promise<Result>;
  /** Changes project memory; works offline and syncs later. */
  editMemory(op: MemoryOp): void;
  /** Records a test result for one of a task's acceptance criteria. */
  verifyCriterion(taskId: string, criterionId: string, state: CriterionState, evidence: string): void;
  /** Scans your project folder for bloat and shares the result with the session. */
  runBloatCheck(): Promise<Result>;
  /** Scans your project folder for the Folder notes tab (cached until something in it changes, unless fresh). */
  scanFolderNotes(fresh: boolean): Promise<ResultWith<FolderNotesReport>>;
  /** Makes a task scoped to one folder's AGENTS.md: update it, or write the first one. */
  folderNoteTask(folder: string): Promise<ResultWith<string>>;
  onState(listener: (state: AppState) => void): () => void;
  getUpdate(): Promise<UpdateInfo>;
  /** Restarts into a downloaded update, or checks for one. */
  update(): Promise<void>;
  onUpdate(listener: (info: UpdateInfo) => void): () => void;
}

export const Channel = {
  getState: 'pct:get-state',
  host: 'pct:host',
  join: 'pct:join',
  listSessions: 'pct:list-sessions',
  resume: 'pct:resume',
  forgetSession: 'pct:forget-session',
  leave: 'pct:leave',
  setPresence: 'pct:set-presence',
  createTask: 'pct:create-task',
  updateTask: 'pct:update-task',
  deleteTask: 'pct:delete-task',
  acquireLock: 'pct:acquire-lock',
  releaseLock: 'pct:release-lock',
  recoverLock: 'pct:recover-lock',
  setLockRules: 'pct:set-lock-rules',
  chooseWorkspace: 'pct:choose-workspace',
  stopWorkspace: 'pct:stop-workspace',
  cloneRepo: 'pct:clone-repo',
  gitAction: 'pct:git-action',
  linkRepo: 'pct:link-repo',
  setGitHubToken: 'pct:set-github-token',
  copyText: 'pct:copy-text',
  saveAgent: 'pct:save-agent',
  deleteAgent: 'pct:delete-agent',
  startAgent: 'pct:start-agent',
  stopAgent: 'pct:stop-agent',
  setApiKey: 'pct:set-api-key',
  createChat: 'pct:create-chat',
  updateChat: 'pct:update-chat',
  deleteChat: 'pct:delete-chat',
  openChat: 'pct:open-chat',
  postChat: 'pct:post-chat',
  decideApproval: 'pct:decide-approval',
  stopChat: 'pct:stop-chat',
  chatToTask: 'pct:chat-to-task',
  handOff: 'pct:hand-off',
  editPlanning: 'pct:edit-planning',
  approvePlan: 'pct:approve-plan',
  editMemory: 'pct:edit-memory',
  verifyCriterion: 'pct:verify-criterion',
  runBloatCheck: 'pct:run-bloat-check',
  scanFolderNotes: 'pct:scan-folder-notes',
  folderNoteTask: 'pct:folder-note-task',
  state: 'pct:state',
  getUpdate: 'pct:get-update',
  update: 'pct:update',
  updateState: 'pct:update-state',
} as const;

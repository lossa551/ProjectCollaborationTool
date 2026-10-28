import type {
  AgentSaveMessage,
  CliTool,
  FileChange,
  Handoff,
  IssueLinkKind,
  CriterionState,
  DetectedProject,
  Engine,
  FirstCommitFile,
  LockRules,
  PriceTable,
  MemoryOp,
  NeedTarget,
  NoticeKind,
  PlanApproval,
  PlanOp,
  RepoRef,
  SessionState,
  SetupItem,
  SetupItemId,
  TaskChanges,
  TaskStage,
  Workspace,
  UndoMode,
} from '@pct/shared';
import type { FolderNotesReport, NoteDraft } from './folder-notes';

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
  /** False in a new repository with nothing committed yet. */
  hasCommits: boolean;
  /** Local branches you can switch to here. */
  branches: string[];
  /**
   * Local branches checked out in another folder, usually an agent chat's own
   * copy. Git cannot switch to them here, so they are left out of branches.
   */
  inUse: string[];
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

/**
 * What can be done with an agent chat's own copy, on the PC that holds it:
 * open its folder, merge its branch into the branch checked out in your
 * project folder, push it and open a pull request, or throw it away.
 */
export type WorktreeAction = 'open' | 'merge' | 'pull-request' | 'discard';

/** An agent started on this PC. */
export interface LocalAgent {
  status: 'starting' | 'running' | 'error';
  error: string | null;
  /** The project folder its chats copy from. */
  folder: string;
}

/**
 * A commit message draft (GitHub page). It lives in the main process so it
 * carries on, and its result is kept, while you are on another screen.
 */
export type CommitDraft = { id: number; agent: string } & (
  | { status: 'drafting' }
  | { status: 'done'; message: string }
  | { status: 'failed'; error: string }
);

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
  memoryExport: MemoryExportState | null;
  /** Windows notification kinds you turned off on this PC. */
  mutedNotices: NoticeKind[];
  /** Project setup while it runs. */
  setupProgress: SetupProgress | null;
  /** The commit message an agent is drafting now, or drafted last. */
  commitDraft: CommitDraft | null;
  /** Folder notes agents drafted, waiting for you to look at them. */
  noteDrafts: NoteDraft[];
  /** The agent that keeps folder notes up to date in this session; null when off. */
  notesAgent: string | null;
  /** Tasks whose review-time duplicate question an agent on this PC is answering now. */
  duplicateChecks: string[];
  /** The game engine on this PC. */
  engine: EngineState;
}

/** Which engine MCP server agents on this PC use; see ENGINE_BRIDGES in @pct/agents. auto picks from what is open. */
export type EngineBridgeChoice = 'auto' | 'off' | 'godot' | 'summer' | 'unreal';

/** A Godot, Summer Engine or Unreal Editor on this PC. */
export interface EngineEditor {
  kind: 'godot' | 'summer' | 'unreal';
  /** It has your project open (the Locks plugin says so, or Unreal's command line); false when it is only running. */
  projectOpen: boolean;
  /** The open scene, as a path in your project folder; null when not known (always for Unreal). */
  scene: string | null;
  version: string | null;
}

/** The game engine on this PC (issue #10). */
export interface EngineState {
  bridge: EngineBridgeChoice;
  /** The server agents get now: the choice, or what auto picked; null for none. */
  active: 'godot' | 'summer' | 'unreal' | null;
  /** Why it is that, in a few words (for auto, or why there is none). */
  activeWhy: string;
  /** Godot (or Summer Engine) executable, for tests and the Godot MCP server. */
  godotPath: string | null;
  /** saved: chosen in Settings; env: GODOT_PATH; editor: the running editor's; path: on the PATH; found: a usual install folder. */
  godotSource: 'saved' | 'env' | 'editor' | 'path' | 'found' | null;
  /** Summer's engine server has a sign-in on this PC. */
  summerSignedIn: boolean;
  /** Node.js is installed (npx starts the MCP servers); null until checked. */
  node: boolean | null;
  /** Agents of this session that get the engine's tools. */
  agents: string[];
  /** Your project folder is a Godot (or Summer Engine) project. */
  godotProject: boolean;
  /** The app's Locks plugin in the project: missing, older than this app's, or up to date; null without a project.godot at the top. */
  plugin: 'missing' | 'old' | 'ok' | null;
  /** The editor that is open, preferring one that has your project. */
  editor: EngineEditor | null;
  /** Unreal (issue #11); null when your project folder has no .uproject. */
  unreal: UnrealState | null;
}

/** An Unreal project in your project folder, and what this PC has for it. */
export interface UnrealState {
  /** The .uproject, repo-relative. */
  uproject: string;
  /** The engine it asks for ("5.8"), or a source build's id. */
  engineVersion: string | null;
  /** UnrealEditor-Cmd for that engine, for the tests; null when not found. */
  editorCmd: string | null;
  /** EngineWire (the plugin agents reach the editor through) is in the project or enabled from the engine. */
  plugin: 'ok' | 'missing';
  /** The project has C++ modules, so Unreal can build a code plugin like EngineWire. */
  hasCode: boolean;
}

/** What project setup would do in your project folder. */
export interface SetupPlan {
  root: string;
  detected: DetectedProject;
  /** The preset shown: the detected one unless you picked another. */
  engine: Engine;
  items: SetupItem[];
  /** Things setup cannot do itself, for the engine. */
  reminders: string[];
  /** Folders worth a first note, biggest first. */
  noteFolders: { path: string; tokens: number; files: number }[];
  /** The folder is not on a branch with a commit yet; setup makes the first commit. */
  firstCommit: boolean;
}

/** The first commit the app offers for a repository with no commits yet. */
export interface FirstCommitPlan {
  files: FirstCommitFile[];
  /** The branch it goes on: the GitHub repository's default branch, else main. */
  branch: string;
  /** Where it is pushed ("owner/name"); null when the folder has no GitHub remote and no repository is linked. */
  pushTo: string | null;
  /** GitHub already has commits, so the first commit is pulled rather than made. */
  onGitHub: boolean;
  /** Files in the folder that stay out of the first commit. */
  leftOut: number;
}

export interface SetupRequest {
  engine: Engine;
  items: SetupItemId[];
  /** The agent that writes the first notes, and keeps them up to date when keepNotes is set. */
  notesAgent: string | null;
  noteFolders: string[];
  keepNotes: boolean;
  /** Commit everything setup wrote as one commit. */
  commit: boolean;
}

export interface SetupOutcome {
  /** Files written, repo-relative. */
  written: string[];
  /** The commit, when one was made. */
  commit: string | null;
  /** First notes that could not be drafted. */
  failedNotes: { folder: string; error: string }[];
}

export interface SetupProgress {
  step: string;
  done: number;
  total: number;
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
  /**
   * Continue fromChatId in a new chat (issue #88): the new chat also starts
   * from that chat's files, so its agent picks up where the work is.
   */
  continue?: boolean;
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

/** A backup of a hosted session's database. */
export interface BackupInfo {
  /** File name: the day it was made, and whether it was saved before a restore. */
  name: string;
  /**
   * daily: made on host start or while hosting; before-restore: the state
   * just before a restore; snapshot: made by hand, kept until deleted.
   */
  kind: 'daily' | 'before-restore' | 'snapshot';
  path: string;
  madeAt: number;
  bytes: number;
  /** A snapshot's label. */
  label: string | null;
  /** The git tag made with a snapshot. */
  tag: string | null;
}

export interface SnapshotRequest {
  label: string;
  /** Also tag the current commit in your project folder. */
  tag: boolean;
}

export interface BackupFolder {
  folder: string;
  /** False while backups go to the app's own data folder. */
  custom: boolean;
}

/** Writing project memory to your project folder; null without one. */
export interface MemoryExportState {
  /** The file, relative to your project folder. */
  path: string;
  /** Rewritten whenever an entry changes. */
  auto: boolean;
  lastWrittenAt: number | null;
  error: string | null;
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

/** Stable follows releases from main; beta also takes prereleases from the beta branch. */
export type UpdateChannel = 'stable' | 'beta';

export interface UpdateInfo {
  /** The version running now. */
  version: string;
  channel: UpdateChannel;
  /** What the app speaks to the session host; both sides must match. */
  protocol: number;
  /** The layout of the session database it writes. */
  database: number;
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
  /** Backups of a hosted session, newest first. */
  listBackups(key: string): Promise<BackupInfo[]>;
  /** Asks, then puts a hosted session back to how it was in the backup. */
  restoreBackup(key: string, path: string): Promise<Result>;
  getBackupFolder(): Promise<BackupFolder>;
  /** Host only: saves the session as it is now, with a label; the value says what was made. */
  createSnapshot(request: SnapshotRequest): Promise<ResultWith<string>>;
  /** Asks, then deletes a snapshot. */
  deleteSnapshot(key: string, path: string): Promise<Result>;
  /** choose: asks for a folder (say, in OneDrive or on a second drive); otherwise goes back to the default. */
  setBackupFolder(choose: boolean): Promise<Result>;
  leave(): Promise<void>;
  /** Host only: replaces the invite code. People who joined before keep their Rejoin; the old code lets no one new in. */
  newInvite(): Promise<Result>;
  /** Host only: asks, then disconnects a person (and their agents), frees their locks and refuses their saved invite. */
  removeParticipant(participantId: string): Promise<Result>;
  setPresence(status: 'active' | 'idle' | 'away', focus: string | null): void;
  createTask(title: string, stage: TaskStage): void;
  updateTask(taskId: string, changes: TaskChanges): void;
  deleteTask(taskId: string): void;
  acquireLock(path: string, options: { taskId: string | null; exclusive: boolean; reason?: string | null }): void;
  releaseLock(lockId: string): void;
  recoverLock(lockId: string): void;
  setLockRules(rules: LockRules): void;
  /** The session's model prices, per million tokens. */
  setPrices(prices: PriceTable): void;
  /** Asks for your project folder and starts sharing its branch and changed files. */
  chooseWorkspace(): Promise<Result>;
  stopWorkspace(): void;
  /** Asks where to put the linked repository, clones it there and makes it your project folder. */
  cloneRepo(): Promise<Result>;
  /** Runs a git action in your project folder; the value says what happened. */
  gitAction(action: GitAction): Promise<ResultWith<string>>;
  /**
   * Has an agent (started on this PC if it is not running) draft a commit
   * message from your uncommitted changes and the branch's task. Only returns
   * the text; nothing is committed.
   */
  draftCommitMessage(agentId: string): Promise<ResultWith<string>>;
  /** Stops the draft being written now. */
  cancelCommitDraft(): void;
  /** "owner/name" or a GitHub URL; null unlinks. */
  linkRepo(repo: string | null): Promise<Result>;
  /** Opens an issue on GitHub (through the host's token) and links it to a feature or task. Returns its number. */
  createIssue(request: { title: string; body: string; link: { kind: IssueLinkKind; id: string } | null }): Promise<ResultWith<number>>;
  /** Comments on an issue and closes it as completed. Ask the person first. */
  closeIssue(number: number, comment: string): Promise<Result>;
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
  /** Starts a new chat with the messages up to and including one message; returns the new chat's id. */
  branchChat(request: { fromChatId: string; fromMessageId: string; title: string; agentId: string }): Promise<ResultWith<string>>;
  updateChat(chatId: string, changes: { title?: string; taskId?: string | null; budget?: number | null }): void;
  /** Asks first (and about the agent's copy, if this PC holds one with unmerged work), then deletes the chat for everyone. */
  deleteChat(chatId: string): Promise<Result>;
  /** Acts on a chat's own copy of the project, which is on this PC; the value says what happened. */
  worktreeAction(chatId: string, action: WorktreeAction): Promise<ResultWith<string>>;
  /** The changes in a chat's copy since it started, as a unified diff. */
  worktreeDiff(chatId: string): Promise<ResultWith<string>>;
  openChat(chatId: string): void;
  postChat(chatId: string, text: string): void;
  decideApproval(chatId: string, messageId: string, approve: boolean): void;
  stopChat(chatId: string): void;
  /** Asks the chat's agent to undo the turn of a checkpoint message, or take its copy back to it. */
  undoTurn(chatId: string, messageId: string, mode: UndoMode): void;
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
  /** Writes project memory to docs/project-memory.md in your project folder, and keeps it up to date from then on. */
  exportMemory(): Promise<ResultWith<string>>;
  /** Stops (or starts again) rewriting the file when an entry changes. */
  setMemoryAutoExport(on: boolean): void;
  /** Turns one kind of Windows notification off or back on. */
  setNoticeMuted(kind: NoticeKind, muted: boolean): void;
  /** Shows a sample notification, to check Windows lets the app show them. */
  testNotice(): void;
  /** Clicking a notification asks the window to open what it is about. */
  onOpenTarget(listener: (target: NeedTarget | null) => void): () => void;
  /** Records a test result for one of a task's acceptance criteria. */
  verifyCriterion(taskId: string, criterionId: string, state: CriterionState, evidence: string): void;
  /** Scans your project folder for bloat and shares the result with the session. */
  runBloatCheck(): Promise<Result>;
  /**
   * Asks an agent whether the task's change adds something the folder notes
   * say already exists; the answer goes on the task as a review flag. Without
   * an agent, the task's reviewing agent (or the notes agent) answers.
   */
  askDuplicateCheck(taskId: string, agentId: string | null): Promise<Result>;
  /** Scans your project folder for the Folder notes tab (cached until something in it changes, unless fresh). */
  scanFolderNotes(fresh: boolean): Promise<ResultWith<FolderNotesReport>>;
  /** Makes a task scoped to one folder's AGENTS.md: update it, or write the first one. */
  folderNoteTask(folder: string): Promise<ResultWith<string>>;
  /** Paths of the AGENTS.md notes in your project folder; empty without one. */
  folderNotePaths(): Promise<string[]>;
  /** What project setup would do in your project folder; engine picks another preset than the detected one. */
  readSetup(engine: Engine | null): Promise<ResultWith<SetupPlan>>;
  /** What the first commit would hold, for a project folder whose repository has no commit yet. */
  readFirstCommit(): Promise<ResultWith<FirstCommitPlan>>;
  /** Makes the first commit (see readFirstCommit) and pushes it to GitHub when push is set. */
  makeFirstCommit(push: boolean): Promise<ResultWith<string>>;
  /** Writes the chosen setup, has an agent draft the first folder notes, and commits it all as one commit. */
  runSetup(request: SetupRequest): Promise<ResultWith<SetupOutcome>>;
  /** Stops setup between steps (notes drafted so far are kept). */
  cancelSetup(): void;
  /** The agent that drafts folder note updates by itself; null turns it off. */
  setNotesAgent(agentId: string | null): void;
  /** Which engine MCP server agents on this PC use. */
  setEngineBridge(bridge: EngineBridgeChoice): void;
  /** Gives an agent the engine's tools in this session, or takes them away. */
  setEngineAgent(agentId: string, on: boolean): void;
  /** Adds or updates the Locks plugin in your project folder's Godot project, and commits it. */
  installGodotPlugin(): Promise<ResultWith<{ reload: boolean }>>;
  /** Adds EngineWire to your Unreal project's Plugins folder (this PC only; it is in .gitignore). */
  installUnrealPlugin(): Promise<ResultWith<{ restart: boolean }>>;
  /** choose: asks for the Godot executable; otherwise forgets it and looks on the PATH again. */
  setGodotPath(choose: boolean): Promise<Result>;
  /** Writes a drafted note into your project folder, for you to commit. */
  acceptNoteDraft(notePath: string): Promise<Result>;
  discardNoteDraft(notePath: string): void;
  onState(listener: (state: AppState) => void): () => void;
  getUpdate(): Promise<UpdateInfo>;
  /** Follows stable or beta releases from now on, and checks that channel. */
  setUpdateChannel(channel: UpdateChannel): Promise<void>;
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
  listBackups: 'pct:list-backups',
  restoreBackup: 'pct:restore-backup',
  getBackupFolder: 'pct:get-backup-folder',
  createSnapshot: 'pct:create-snapshot',
  deleteSnapshot: 'pct:delete-snapshot',
  setBackupFolder: 'pct:set-backup-folder',
  exportMemory: 'pct:export-memory',
  setMemoryAutoExport: 'pct:set-memory-auto-export',
  setNoticeMuted: 'pct:set-notice-muted',
  testNotice: 'pct:test-notice',
  openTarget: 'pct:open-target',
  leave: 'pct:leave',
  newInvite: 'pct:new-invite',
  removeParticipant: 'pct:remove-participant',
  setPresence: 'pct:set-presence',
  createTask: 'pct:create-task',
  updateTask: 'pct:update-task',
  deleteTask: 'pct:delete-task',
  acquireLock: 'pct:acquire-lock',
  releaseLock: 'pct:release-lock',
  recoverLock: 'pct:recover-lock',
  setLockRules: 'pct:set-lock-rules',
  setPrices: 'pct:set-prices',
  chooseWorkspace: 'pct:choose-workspace',
  stopWorkspace: 'pct:stop-workspace',
  cloneRepo: 'pct:clone-repo',
  gitAction: 'pct:git-action',
  draftCommitMessage: 'pct:draft-commit-message',
  cancelCommitDraft: 'pct:cancel-commit-draft',
  linkRepo: 'pct:link-repo',
  setGitHubToken: 'pct:set-github-token',
  createIssue: 'pct:create-issue',
  closeIssue: 'pct:close-issue',
  copyText: 'pct:copy-text',
  saveAgent: 'pct:save-agent',
  deleteAgent: 'pct:delete-agent',
  startAgent: 'pct:start-agent',
  stopAgent: 'pct:stop-agent',
  setApiKey: 'pct:set-api-key',
  createChat: 'pct:create-chat',
  branchChat: 'pct:branch-chat',
  updateChat: 'pct:update-chat',
  deleteChat: 'pct:delete-chat',
  worktreeAction: 'pct:worktree-action',
  worktreeDiff: 'pct:worktree-diff',
  openChat: 'pct:open-chat',
  postChat: 'pct:post-chat',
  decideApproval: 'pct:decide-approval',
  stopChat: 'pct:stop-chat',
  undoTurn: 'pct:undo-turn',
  chatToTask: 'pct:chat-to-task',
  handOff: 'pct:hand-off',
  editPlanning: 'pct:edit-planning',
  approvePlan: 'pct:approve-plan',
  editMemory: 'pct:edit-memory',
  verifyCriterion: 'pct:verify-criterion',
  runBloatCheck: 'pct:run-bloat-check',
  askDuplicateCheck: 'pct:ask-duplicate-check',
  scanFolderNotes: 'pct:scan-folder-notes',
  folderNoteTask: 'pct:folder-note-task',
  folderNotePaths: 'pct:folder-note-paths',
  readSetup: 'pct:read-setup',
  readFirstCommit: 'pct:read-first-commit',
  makeFirstCommit: 'pct:make-first-commit',
  runSetup: 'pct:run-setup',
  cancelSetup: 'pct:cancel-setup',
  setNotesAgent: 'pct:set-notes-agent',
  acceptNoteDraft: 'pct:accept-note-draft',
  setEngineBridge: 'pct:set-engine-bridge',
  setEngineAgent: 'pct:set-engine-agent',
  installGodotPlugin: 'pct:install-godot-plugin',
  installUnrealPlugin: 'pct:install-unreal-plugin',
  setGodotPath: 'pct:set-godot-path',
  discardNoteDraft: 'pct:discard-note-draft',
  state: 'pct:state',
  getUpdate: 'pct:get-update',
  setUpdateChannel: 'pct:set-update-channel',
  update: 'pct:update',
  updateState: 'pct:update-state',
} as const;

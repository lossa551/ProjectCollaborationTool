import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray, type MessageBoxOptions, type OpenDialogOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AgentSaveMessage,
  ChatTitle,
  type ChatInfo,
  type ChatWorktree,
  Handoff,
  ISSUE_BODY_LIMIT,
  ISSUE_COMMENT_LIMIT,
  ISSUE_TITLE_LIMIT,
  IssueLinkKind,
  LockAcquireMessage,
  LockRules,
  Budget,
  PriceTable,
  MEMORY_EXPORT_PATH,
  MemoryOp,
  PlanApproval,
  PlanOp,
  PresenceStatus,
  NOTE_FILE,
  SOCKET_PATH,
  SessionClient,
  TaskStage,
  TaskUpdateMessage,
  TaskVerifyMessage,
  decodeInvite,
  encodeInvite,
  isNotePath,
  locksAfterCommit,
  normalizePath,
  parseRepoRef,
  renderHandoff,
  cleanDraft,
  commitDraftPrompt,
  branchTask,
  Engine,
  GODOT_PLUGIN_COMMIT_MESSAGE,
  SETUP_COMMIT_MESSAGE,
  samePath,
  PRESETS,
  PROTOCOL_VERSION,
  SetupItemId,
  detectProject,
  engineEntry,
  planSetup,
  setupFiles,
  withPresetLocks,
  type CliTool,
} from '@pct/shared';
import { SCHEMA_VERSION, SqliteStorage, findShareableAddress, inspectBackup, startServer, tokenFromGitHubCli, type RunningServer } from '@pct/server';
import {
  Channel,
  type AppState,
  type BackupFolder,
  type BackupInfo,
  type CommitDraft,
  type GitAction,
  type HandoffRequest,
  type HostRequest,
  type HostingInfo,
  type JoinRequest,
  type LocalWorkspace,
  type MemoryExportState,
  type ResumeRequest,
  type Result,
  type SnapshotRequest,
  type ResultWith,
  type SavedSessionInfo,
  type SetupOutcome,
  type SetupPlan,
  type SetupProgress,
  type SetupRequest,
} from '../common/api';
import { LocalAgents, apiKeyStatus, createSocket, findCliTools } from './agents';
import { SessionBackups } from './backups';
import { runBloatCheck } from './bloat';
import { loadSnapshot, saveSnapshot } from './cache';
import { loadIdentity } from './identity';
import { writeMemoryFile } from './memory-export';
import { SessionHistory } from './sessions';
import {
  customBackupFolder,
  defaultBackupFolder,
  firstTimeInTray,
  loadGitHubToken,
  memoryAutoExport,
  saveApiKey,
  saveBackupFolder,
  saveGitHubToken,
  saveMemoryAutoExport,
  saveEngineAgent,
  saveEngineBridge,
  saveGodotPath,
  saveNotesAgent,
  saveWorkspaceFolder,
  notesAgent,
  workspaceFolder,
} from './settings';
import { EngineWatch, engineSettingsFor, findGodotOnPath } from './engine';
import { GodotEditorLink } from './godot-editor';
import { applyUpdate, getUpdateState, startUpdater } from './updater';
import { GitError, clone, commitPaths, hasCommit, initRepository, installGitLfs, listProjectFiles, mergeBranch, pushBranch, readGitInfo, repositoryRoot, runGitAction, tagCommit, trustFolder, uncommittedChanges } from './git';
import { commitAll, mainCheckout, removeWorktree, worktreeDiff, worktreeStatus } from '@pct/agents';
import { WorkspaceWatcher } from './workspace';
import { cutOffSentence, stopConfirmDetail, whoWouldBeCutOff } from '../common/background';
import { Notifier } from './notifications';
import { scanFolderNotes } from './folder-notes';
import { cleanNote, noteDraftPrompt, type FolderInfo, type FolderNotesReport, type NoteDraft } from '../common/folder-notes';
import { noteCandidates, noteDraftInput, readProjectFacts, writeProjectFiles } from './setup';

// The main process owns the session connection (and, when hosting, the
// session server itself) so it survives window reloads. It also runs the
// agents started on this PC and keeps the offline cache.

const DEFAULT_PORT = 7420;

// Node 22 has a global WebSocket; ws is the fallback with the same API.
const client = new SessionClient({ createSocket });
let hosted: RunningServer | null = null;
let hosting: HostingInfo | null = null;
let githubToken: AppState['githubToken'] = null;
let window: BrowserWindow | null = null;
let workspace: LocalWorkspace | null = null;
/** Where this app is connected, so agents started here can join the same session. */
let joined: { url: string; secret: string } | null = null;
let cliTools: Record<CliTool, boolean> = { 'claude-code': false, codex: false };
/** Live text edits from the window applied so far; see AppState.textEdits. */
let textEdits = 0;
/** The sessions hosted or joined on this PC, and the one in use now. */
let history: SessionHistory | null = null;
const sessions = () => (history ??= new SessionHistory(app.getPath('userData')));
let currentKey: string | null = null;
/** Project setup while it runs, and how to stop it. */
let setupProgress: SetupProgress | null = null;
let setupAbort: AbortController | null = null;
/** Folder notes agents drafted on their own, waiting for review; for your project folder. */
let noteDrafts: NoteDraft[] = [];
/** What each note looked like when it was last drafted (by note path), so a folder is drafted once per change. */
const draftedNotes = new Map<string, string>();

// Windows toasts for approvals, agents, your locks and pull requests, and the host's connection.
const notifier = new Notifier({
  focused: () => !!window && window.isVisible() && !window.isMinimized() && window.isFocused(),
  open(target) {
    focusWindow();
    window?.webContents.send(Channel.openTarget, target);
  },
});

const appState = (): AppState => ({
  session: client.getState(),
  hosting,
  canEditTasks: client.canEditTasks(),
  workspace,
  githubToken,
  localAgents: localAgents.list(),
  apiKeys: apiKeyStatus(),
  cliTools,
  textEdits,
  memoryExport: memoryExportState(),
  mutedNotices: notifier.muted(),
  setupProgress,
  commitDraft,
  noteDrafts,
  notesAgent: currentNotesAgent(),
  engine: engineNow(),
});
const pushState = () => window?.webContents.send(Channel.state, appState());
const localAgents = new LocalAgents(pushState);
client.subscribe(pushState);
// The Godot editor plugin's Locks dock reads the session's locks from your project folder.
const godotEditor = new GodotEditorLink({
  lock: (path) => client.acquireLock(path, { reason: 'From the Godot editor' }),
  release: (lockId) => client.releaseLock(lockId),
  editorChanged: () => engineWatch.editorChanged(),
});
client.subscribe((state) => void godotEditor.update(workspace?.folder ?? null, state));

// The engine programs on this PC: the app reacts when Godot or Summer Engine opens your project.
const editorName = (kind: 'godot' | 'summer') => (kind === 'godot' ? 'Godot' : 'Summer Engine');
const pluginOffered = new Set<string>();
const engineWatch = new EngineWatch({
  link: godotEditor,
  folder: () => workspace?.folder ?? null,
  changed: () => pushState(),
  event(event) {
    const state = client.getState();
    const youId = state.you?.id;
    const dir = godotEditor.projectDir();
    const inProject = (path: string) => !dir || path.toLowerCase().startsWith(`${dir.toLowerCase()}/`);
    const others = state.locks.filter((l) => l.holder.id !== youId && inProject(l.path));
    const name = editorName(event.editor.kind);
    if (event.kind === 'opened' && others.length) {
      const first = others[0]!;
      notifier.notify({
        key: `engine-open-${Date.now()}`,
        kind: 'engine',
        title: `${name} opened your project`,
        body: `${first.holder.name} holds ${first.path}${others.length > 1 ? ` and ${others.length - 1} more` : ''}. Lock what you change first (Locks dock).`,
        target: null,
      });
    }
    const scene = event.editor.scene;
    const held = scene && event.kind !== 'closed' ? others.find((l) => samePath(l.path, scene)) : undefined;
    if (held) {
      notifier.notify({
        key: `engine-scene-${scene}-${Date.now()}`,
        kind: 'engine',
        title: `${held.holder.name} holds the scene you opened`,
        body: `${scene} is locked${held.reason ? ` for "${held.reason}"` : ''}. Changes you save will clash with theirs.`,
        target: null,
      });
    }
  },
  pluginMissing(editor, plugin) {
    const folder = workspace?.folder;
    if (!folder || pluginOffered.has(folder)) return;
    pluginOffered.add(folder);
    notifier.notify({
      key: `engine-plugin-${folder}`,
      kind: 'engine',
      title: plugin === 'missing' ? `Show locks inside ${editorName(editor.kind)}?` : 'Update the Locks plugin?',
      body:
        plugin === 'missing'
          ? 'Your project has no Locks plugin yet. One click on Home adds it, so the editor shows who holds what.'
          : 'Your project has an older Locks plugin. One click on Home updates it, so the app sees when the editor has your project open.',
      target: null,
    });
  },
});
function engineNow() {
  const state = client.getState();
  return engineWatch.state(state.session?.id ?? null, state.agents);
}
client.subscribe(() => notifier.update(client.getState(), !hosted));

// Your workspace: the project folder you picked for this session. Its branch
// and changed files go to the session whenever they change.
let watcher: WorkspaceWatcher | null = null;
let watchedSession: string | null = null;
let knownDefaultBranch: string | null = null;

function watchFolder(folder: string | null) {
  noteDrafts = [];
  commitDraft = null;
  draftedNotes.clear();
  watcher?.stop();
  watcher = null;
  workspace = null;
  client.setWorkspace(null);
  if (folder) {
    watcher = new WorkspaceWatcher(folder, () => client.getState().github.defaultBranch, (next) => {
      workspace = next;
      client.setWorkspace(next.workspace);
      pushState();
    });
    workspace = watcher.getState();
    watcher.start();
  }
  pushState();
}

client.subscribe((state) => {
  const sessionId = state.status === 'closed' || state.status === 'idle' ? null : (state.session?.id ?? null);
  if (sessionId !== watchedSession) {
    watchedSession = sessionId;
    watchFolder(sessionId ? workspaceFolder(sessionId) : null);
  }
  // Changes are measured against the default branch, which GitHub tells us.
  if (state.github.defaultBranch !== knownDefaultBranch) {
    knownDefaultBranch = state.github.defaultBranch;
    void watcher?.poll();
  }
});

const openDialog = (options: OpenDialogOptions) => (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
// Without a visible window (e.g. from the tray) the box stands on its own.
const messageBox = (options: MessageBoxOptions) => (window?.isVisible() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));

function useWorkspace(sessionId: string, root: string) {
  saveWorkspaceFolder(sessionId, root);
  watchFolder(root);
}

// Keep the saved entry of the session in use up to date: its id (which ties
// it to your project folder), its name and its linked repository.
client.subscribe((state) => {
  if (!currentKey || state.status !== 'connected' || !state.session) return;
  const repo = state.github.repo ? `${state.github.repo.owner}/${state.github.repo.name}` : null;
  sessions().update(currentKey, { sessionId: state.session.id, name: state.session.name, repo });
});

let legacyAdopted: Promise<boolean> = Promise.resolve(false);

async function listSessions(): Promise<SavedSessionInfo[]> {
  await legacyAdopted;
  return sessions()
    .list()
    .map(({ key, role, name, invite, repo, sessionId, lastUsedAt }) => ({
      key,
      role,
      name,
      invite,
      repo,
      folder: sessionId ? workspaceFolder(sessionId) : null,
      lastUsedAt,
    }));
}

async function resume({ name, key }: ResumeRequest): Promise<Result> {
  const entry = sessions().get(key);
  if (!entry) return { ok: false, error: 'That session is no longer saved on this PC.' };
  if (entry.role === 'host') return host({ name, sessionName: '' }, key);
  if (!entry.invite) return { ok: false, error: 'No invite code is saved for that session.' };
  return joinSession({ name, invite: entry.invite });
}

async function forgetSession(key: unknown): Promise<Result> {
  const entry = typeof key === 'string' ? sessions().get(key) : null;
  if (!entry) return { ok: true };
  if (entry.key === currentKey) return { ok: false, error: 'Leave the session first.' };
  if (entry.role === 'host') {
    const answer = await messageBox({
      type: 'warning',
      title: 'Delete hosted session',
      message: `Delete "${entry.name}" from this PC?`,
      detail: 'Its board, locks, agents and chats are deleted and its invite code stops working. Your project folder and GitHub are not touched.',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (answer.response !== 0) return { ok: true };
  }
  try {
    sessions().forget(entry.key);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

async function chooseWorkspace(): Promise<Result> {
  const sessionId = client.getState().session?.id;
  if (!sessionId) return { ok: false, error: 'Join a session first.' };
  for (;;) {
    const picked = await openDialog({ title: 'Choose your project folder (your clone of the project, or a new engine project)', properties: ['openDirectory'] });
    const folder = picked.filePaths[0];
    if (picked.canceled || !folder) return { ok: true };
    try {
      useWorkspace(sessionId, await repositoryRoot(folder));
      return { ok: true };
    } catch (error) {
      if (!(error instanceof GitError)) return failure(error);
      if (error.code === 'dubious') {
        const repoFolder = error.folder ?? folder;
        const { response } = await messageBox({
          type: 'question',
          message: 'Git does not trust this folder',
          detail: `${repoFolder} belongs to another Windows user (often because it was copied, or made by an installer or as administrator), so git refuses to read it. Trust it? This adds it to git's safe.directory setting.`,
          buttons: ['Trust this folder', 'Choose another folder', 'Cancel'],
          defaultId: 0,
          cancelId: 2,
        });
        if (response === 2) return { ok: true };
        if (response === 1) continue;
        try {
          await trustFolder(repoFolder);
          useWorkspace(sessionId, await repositoryRoot(folder));
          return { ok: true };
        } catch (again) {
          return failure(again);
        }
      }
      if (error.code !== 'not-a-repo') return failure(error);
      const repo = client.getState().github.repo;
      const target = repo ? cloneTarget(folder, repo.name) : null;
      // A project just made with Godot or Unreal has no git yet: offer to start it here.
      const engine = engineProjectIn(folder);
      const fresh = engine !== null || !repo;
      const choices = [
        ...(repo ? [{ label: `Clone ${repo.owner}/${repo.name}`, run: () => cloneInto(folder) }] : []),
        { label: 'Make this folder a git repository', run: () => initWorkspace(sessionId, folder) },
      ];
      if (fresh) choices.reverse();
      const { response } = await messageBox({
        type: 'question',
        message: 'This folder is not a git repository',
        detail: [
          engine ? `It looks like a new ${engine} project.` : null,
          'The app can make it a git repository (on branch main, nothing committed yet) and set the project up from there.',
          repo ? `Or, if the project is already on GitHub, clone ${repo.owner}/${repo.name} into ${target} and use that.` : null,
        ]
          .filter(Boolean)
          .join(' '),
        buttons: [...choices.map((c) => c.label), 'Choose another folder', 'Cancel'],
        defaultId: 0,
        cancelId: choices.length + 1,
      });
      if (response < choices.length) return choices[response]!.run();
      if (response === choices.length + 1) return { ok: true };
    }
  }
}

/** git init in the folder, then use it as your project folder. */
async function initWorkspace(sessionId: string, folder: string): Promise<Result> {
  try {
    await initRepository(folder);
    useWorkspace(sessionId, await repositoryRoot(folder));
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

/** The engine that made the project in this folder, from the files at its top. */
const engineProjectIn = (folder: string): string | null => {
  try {
    const names = readdirSync(folder);
    if (names.some((name) => /\.uproject$/i.test(name))) return 'Unreal';
    return names.includes('project.godot') ? 'Godot' : null;
  } catch {
    return null;
  }
};

const isEmptyFolder = (folder: string) => {
  try {
    return readdirSync(folder).length === 0;
  } catch {
    return false;
  }
};

/** An empty folder is used as it is; otherwise the clone goes into a new folder inside it. */
const cloneTarget = (folder: string, name: string) => (isEmptyFolder(folder) ? folder : join(folder, name));

let cloning = false;

async function cloneRepo(): Promise<Result> {
  const repo = client.getState().github.repo;
  if (!repo) return { ok: false, error: 'Link the GitHub repository first.' };
  if (!client.getState().session?.id) return { ok: false, error: 'Join a session first.' };
  const picked = await openDialog({ title: `Choose where to put ${repo.name}`, properties: ['openDirectory', 'createDirectory'] });
  const folder = picked.filePaths[0];
  if (picked.canceled || !folder) return { ok: true };
  return cloneInto(folder);
}

async function cloneInto(folder: string): Promise<Result> {
  const sessionId = client.getState().session?.id;
  const repo = client.getState().github.repo;
  if (!sessionId || !repo) return { ok: false, error: 'Join a session and link the repository first.' };
  if (cloning) return { ok: false, error: 'A clone is already running.' };
  const target = cloneTarget(folder, repo.name);
  if (existsSync(target) && !isEmptyFolder(target)) {
    // Already cloned there before? Then just use it.
    const root = await repositoryRoot(target).catch(() => null);
    if (root) {
      useWorkspace(sessionId, root);
      return { ok: true };
    }
    return { ok: false, error: `${target} already exists and is not empty. Choose another folder.` };
  }
  cloning = true;
  try {
    await clone(`https://github.com/${repo.owner}/${repo.name}.git`, target, existsSync(target) ? target : dirname(target), await gitToken());
    useWorkspace(sessionId, await repositoryRoot(target));
    return { ok: true };
  } catch (error) {
    return failure(error);
  } finally {
    cloning = false;
  }
}

/** The token git uses for github.com: the one saved in the app, else the GitHub CLI's. */
async function gitToken(): Promise<string | null> {
  return loadGitHubToken() ?? (await tokenFromGitHubCli());
}

const GIT_ACTIONS = new Set(['fetch', 'pull', 'push', 'commit', 'switch', 'create-branch', 'abort-merge']);
let gitBusy = false;

async function gitAction(input: unknown): Promise<ResultWith<string>> {
  const action = input as GitAction;
  if (!action || typeof action !== 'object' || !GIT_ACTIONS.has(action.type)) return { ok: false, error: 'Unknown git action.' };
  if ('message' in action && typeof action.message !== 'string') return { ok: false, error: 'Unknown git action.' };
  if ('branch' in action && (typeof action.branch !== 'string' || action.branch.startsWith('-'))) return { ok: false, error: 'That is not a valid branch name.' };
  if ('from' in action && action.from !== null && (typeof action.from !== 'string' || action.from.startsWith('-'))) {
    return { ok: false, error: 'That is not a valid branch name.' };
  }
  const folder = workspace?.folder;
  if (!folder || workspace?.error) return { ok: false, error: 'Choose your project folder first.' };
  if (gitBusy || cloning) return { ok: false, error: 'Git is still busy with the last action.' };
  gitBusy = true;
  try {
    if (action.type === 'commit') {
      const value = await commitAndFreeLocks(folder, action.message);
      // Committed: the draft is used up, so a reloaded window does not offer it again.
      if (value !== 'Nothing to commit.' && commitDraft?.status !== 'drafting') commitDraft = null;
      return { ok: true, value };
    }
    return { ok: true, value: await runGitAction(folder, action, await gitToken()) };
  } catch (error) {
    return failure(error);
  } finally {
    gitBusy = false;
    void watcher?.poll();
  }
}

const changedPaths = async (folder: string) => (await readGitInfo(folder).catch(() => null))?.uncommitted.map((f) => f.path) ?? [];

/**
 * Commits everything, then frees the locks agents on this PC hold on the
 * committed files when they work in this folder and are between turns. Your
 * own locks are offered on the GitHub page instead (see locksAfterCommit).
 */
async function commitAndFreeLocks(folder: string, message: string): Promise<string> {
  const before = await changedPaths(folder);
  const result = await runGitAction(folder, { type: 'commit', message }, null);
  if (result !== 'Committed.') return result;
  const after = await changedPaths(folder);
  const committed = before.filter((path) => !after.includes(path));
  const { agents } = locksAfterCommit(client.getState(), client.getState().you?.id ?? null, committed, after);
  for (const lock of agents) client.releaseLock(lock.id);
  // The page offers to free your locks from the files it lists as changed.
  await watcher?.poll();
  if (agents.length === 0) return result;
  const names = [...new Set(agents.map((l) => l.holder.name))].join(', ');
  return `Committed, and freed ${names}'s ${plural(agents.length, 'lock')} on the committed files.`;
}

/** The commit message draft being written now, so it can be stopped. */
let drafting: AbortController | null = null;
/** The draft being written or written last, shown on the GitHub page (see AppState.commitDraft). */
let commitDraft: CommitDraft | null = null;
let commitDraftId = 0;

/**
 * Has an agent draft a commit message from the uncommitted changes and the
 * branch's task. It starts the agent on this PC if it is not running. The
 * draft only goes back to the message box: the person commits it. It keeps
 * going while the GitHub page is closed; the page picks up the result.
 */
async function draftCommitMessage(agentId: unknown): Promise<ResultWith<string>> {
  if (drafting) return { ok: false, error: 'A draft is already being written.' };
  const id = ++commitDraftId;
  const agent = client.getState().agents.find((a) => a.id === agentId)?.name ?? 'The agent';
  const abort = new AbortController();
  drafting = abort;
  commitDraft = { id, agent, status: 'drafting' };
  pushState();
  const outcome = await writeCommitDraft(agentId, abort);
  drafting = null;
  // A newer draft, or a change of folder, replaced this one meanwhile.
  if (commitDraft?.id === id) {
    commitDraft = outcome.ok ? { id, agent, status: 'done', message: outcome.value } : { id, agent, status: 'failed', error: outcome.error };
    pushState();
  }
  return outcome;
}

async function writeCommitDraft(agentId: unknown, abort: AbortController): Promise<ResultWith<string>> {
  const state = client.getState();
  const profile = state.agents.find((a) => a.id === agentId);
  if (!profile) return { ok: false, error: 'Pick an agent to draft the message.' };
  const folder = workspace?.folder;
  if (!folder || workspace?.error) return { ok: false, error: 'Choose your project folder first.' };
  try {
    const changes = await uncommittedChanges(folder);
    if (changes.files.length === 0) return { ok: false, error: 'There are no uncommitted changes to describe.' };
    const task = branchTask(state.tasks, changes.branch);
    if (!localAgents.isRunning(profile.id)) {
      const started = await startAgent(profile.id);
      if (!started.ok) return started;
    }
    const answer = cleanDraft(await localAgents.draft(profile.id, commitDraftPrompt({ ...changes, task }), task?.id ?? null, abort.signal));
    if (!answer) return { ok: false, error: `${profile.name} answered with an empty message. Try again, or write it yourself.` };
    return { ok: true, value: answer };
  } catch (error) {
    if (abort.signal.aborted) return { ok: false, error: 'Stopped.' };
    return failure(error);
  }
}

// Backups of the hosted session: on host start, then checked every hour so
// one is made each day while hosting. A failed backup never stops hosting.
const backups = new SessionBackups(() => {
  const custom = customBackupFolder();
  return custom ? [custom, defaultBackupFolder()] : [defaultBackupFolder()];
});
let backupTimer: ReturnType<typeof setInterval> | null = null;
/** The database of the session hosted now, for snapshots. */
let hostedStorage: SqliteStorage | null = null;
const BACKUP_CHECK_MS = 60 * 60 * 1000;

function startBackups(key: string, storage: SqliteStorage) {
  const run = () =>
    void backups.daily(key, storage).then(
      (file) => file && console.log(`Backed up the session to ${file}`),
      (error) => console.error('Could not back up the session', error),
    );
  hostedStorage = storage;
  run();
  backupTimer = setInterval(run, BACKUP_CHECK_MS);
}

function stopBackups() {
  if (backupTimer) clearInterval(backupTimer);
  backupTimer = null;
  hostedStorage = null;
}

const SNAPSHOT_LABEL_LIMIT = 200;

/**
 * Saves the hosted session as it is now, say before a big change. With tag,
 * the commit checked out in your project folder is tagged too, so the code
 * can be found again with the board.
 */
async function createSnapshot(input: unknown): Promise<ResultWith<string>> {
  const request = input as SnapshotRequest | null;
  const label = typeof request?.label === 'string' ? request.label.trim().slice(0, SNAPSHOT_LABEL_LIMIT) : '';
  if (!label) return { ok: false, error: 'Give the snapshot a name.' };
  if (!hostedStorage || !currentKey) return { ok: false, error: 'Only the host can make a snapshot: the session is saved on their PC.' };
  const now = new Date();
  try {
    let tag: string | null = null;
    if (request?.tag === true) {
      const folder = workspace?.folder;
      if (!folder || workspace?.error) return { ok: false, error: 'Choose your project folder first (bottom left) to tag its commit.' };
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
      tag = await tagCommit(folder, `snapshot/${stamp}${slug ? `-${slug}` : ''}`, label);
    }
    await backups.snapshot(currentKey, hostedStorage, label, tag, now);
    return { ok: true, value: tag ? `Snapshot saved, and the current commit tagged ${tag}.` : 'Snapshot saved.' };
  } catch (error) {
    return failure(error);
  }
}

async function deleteSnapshot(key: unknown, path: unknown): Promise<Result> {
  const entry = typeof key === 'string' ? sessions().get(key) : null;
  const snapshot = entry ? backups.list(entry.key).find((b) => b.path === path && b.kind === 'snapshot') : null;
  if (!entry || !snapshot) return { ok: false, error: 'That snapshot is no longer there.' };
  const answer = await messageBox({
    type: 'warning',
    title: 'Delete snapshot',
    message: `Delete the snapshot "${snapshot.label ?? snapshot.name}"?`,
    detail: snapshot.tag ? `Its git tag ${snapshot.tag} stays in your project folder.` : undefined,
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (answer.response !== 0) return { ok: true };
  try {
    backups.deleteSnapshot(entry.key, snapshot.path);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

function listBackups(key: unknown): BackupInfo[] {
  const entry = typeof key === 'string' ? sessions().get(key) : null;
  return entry?.role === 'host' ? backups.list(entry.key) : [];
}

async function restoreBackup(key: unknown, path: unknown): Promise<Result> {
  const entry = typeof key === 'string' ? sessions().get(key) : null;
  if (!entry || entry.role !== 'host') return { ok: false, error: 'Only sessions you host have backups.' };
  if (entry.key === currentKey) return { ok: false, error: 'Leave the session first.' };
  const backup = backups.list(entry.key).find((b) => b.path === path);
  if (!backup) return { ok: false, error: 'That backup is no longer there.' };
  try {
    const session = inspectBackup(backup.path);
    if (entry.sessionId && session.id !== entry.sessionId) return { ok: false, error: 'That backup belongs to another session.' };
    const answer = await messageBox({
      type: 'warning',
      title: 'Restore from backup',
      message: `Restore "${entry.name}" to how it was on ${new Date(backup.madeAt).toLocaleString()}?`,
      detail:
        'The board, planning space, project memory, agents, chats and activity go back to that time. What the session holds now is saved as a backup first, so you can go back. Your project folder and GitHub are not touched.',
      buttons: ['Restore', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (answer.response !== 0) return { ok: true };
    const database = sessions().hostFile(entry.key);
    await backups.restore(entry.key, backup.path, database, async (file) => {
      try {
        const current = new SqliteStorage(database);
        try {
          await current.backup(file);
        } finally {
          await current.close();
        }
      } catch {
        // A damaged database cannot be copied safely; keep the file as it is.
        copyFileSync(database, file);
      }
    });
    sessions().update(entry.key, { name: session.name });
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

function backupFolder(): BackupFolder {
  const custom = customBackupFolder();
  return { folder: custom ?? defaultBackupFolder(), custom: custom !== null };
}

async function setBackupFolder(choose: unknown): Promise<Result> {
  try {
    if (choose !== true) {
      saveBackupFolder(null);
      return { ok: true };
    }
    const picked = await openDialog({ title: 'Choose a folder for session backups (say, in OneDrive or on another drive)', properties: ['openDirectory', 'createDirectory'] });
    const folder = picked.filePaths[0];
    if (picked.canceled || !folder) return { ok: true };
    saveBackupFolder(folder);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

// Project memory in the repository: written to your project folder on
// request, then again whenever an entry changes (once the shared copy has
// arrived, so a half-synced memory is never written).
let memoryAuto: { sessionId: string; on: boolean } | null = null;
let memoryWrite: { at: number | null; error: string | null } = { at: null, error: null };
let memoryTimer: ReturnType<typeof setTimeout> | null = null;
let lastMemory: unknown = null;
const MEMORY_WRITE_DELAY_MS = 2000;

function autoExportOn(sessionId: string): boolean {
  if (memoryAuto?.sessionId !== sessionId) {
    memoryAuto = { sessionId, on: memoryAutoExport(sessionId) };
    memoryWrite = { at: null, error: null };
  }
  return memoryAuto.on;
}

function memoryExportState(): MemoryExportState | null {
  const sessionId = client.getState().session?.id;
  if (!sessionId || !workspace?.folder || workspace.error) return null;
  return { path: MEMORY_EXPORT_PATH, auto: autoExportOn(sessionId), lastWrittenAt: memoryWrite.at, error: memoryWrite.error };
}

function writeMemory(): boolean {
  const folder = workspace?.folder;
  if (!folder || workspace?.error) throw new Error('Choose your project folder first (bottom left): the file is written there.');
  try {
    const written = writeMemoryFile(folder, client.getState().memory);
    memoryWrite = { at: written ? Date.now() : (memoryWrite.at ?? Date.now()), error: null };
    return written;
  } catch (error) {
    memoryWrite = { ...memoryWrite, error: failure(error).error };
    throw error;
  }
}

function exportMemory(): ResultWith<string> {
  const sessionId = client.getState().session?.id;
  if (!sessionId) return { ok: false, error: 'Join a session first.' };
  try {
    writeMemory();
    saveMemoryAutoExport(sessionId, true);
    memoryAuto = { sessionId, on: true };
    pushState();
    return { ok: true, value: MEMORY_EXPORT_PATH };
  } catch (error) {
    pushState();
    return failure(error);
  }
}

function setMemoryAutoExport(on: unknown) {
  const sessionId = client.getState().session?.id;
  if (!sessionId || typeof on !== 'boolean') return;
  saveMemoryAutoExport(sessionId, on);
  memoryAuto = { sessionId, on };
  if (on && client.hasSynced('memory')) {
    try {
      writeMemory();
    } catch {
      // Shown with the export state.
    }
  }
  pushState();
}

client.subscribe((state) => {
  if (state.memory === lastMemory) return;
  lastMemory = state.memory;
  const sessionId = state.session?.id;
  if (!sessionId || !autoExportOn(sessionId) || !workspace?.folder || memoryTimer) return;
  memoryTimer = setTimeout(() => {
    memoryTimer = null;
    const now = client.getState();
    if (now.session?.id !== sessionId || !client.hasSynced('memory') || !autoExportOn(sessionId)) return;
    try {
      if (writeMemory()) pushState();
    } catch {
      pushState();
    }
  }, MEMORY_WRITE_DELAY_MS);
});

function stopWorkspace() {
  const sessionId = client.getState().session?.id;
  if (sessionId) saveWorkspaceFolder(sessionId, null);
  watchFolder(null);
}

// Keep the cache of a joined session up to date (hosted sessions are saved by
// the server itself). Writes are batched, and flushed when the app quits.
let cachedUrl: string | null = null;
let cacheTimer: ReturnType<typeof setTimeout> | null = null;
const flushCache = () => {
  if (cacheTimer) clearTimeout(cacheTimer);
  cacheTimer = null;
  const snapshot = client.getSnapshot();
  if (!cachedUrl || !snapshot) return;
  try {
    saveSnapshot(cachedUrl, snapshot);
  } catch (error) {
    console.error('Could not save the session cache', error);
  }
};
client.subscribe(() => {
  if (cachedUrl && !cacheTimer) cacheTimer = setTimeout(flushCache, 500);
});
// Quitting from the tray, an update or the system skips window-all-closed.
app.on('before-quit', () => {
  quitting = true;
  flushCache();
});

const failure = (error: unknown): { ok: false; error: string } => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
});

async function stopHosting() {
  // Agents started here belong to the session being left.
  await localAgents.stopAll();
  stopBackups();
  joined = null;
  const server = hosted;
  hosted = null;
  hosting = null;
  githubToken = null;
  currentKey = null;
  await server?.close();
}

/**
 * Hosts a new session, or with the key of a saved one, hosts it again: same
 * board, locks, agents, chats, invite code and linked repository.
 */
async function host({ name, sessionName }: HostRequest, savedKey?: string): Promise<Result> {
  const key = savedKey ?? sessions().newHostKey();
  try {
    flushCache();
    cachedUrl = null;
    client.disconnect();
    await stopHosting();
    // Each hosted session is saved in its own file on this PC.
    const storage = new SqliteStorage(sessions().hostFile(key));
    // A token saved in the app, else the GitHub CLI's if you are signed in to it.
    const saved = loadGitHubToken();
    const token = saved ?? (await tokenFromGitHubCli());
    const options = { sessionName: sessionName || undefined, storage, github: { token }, log: console.log };
    try {
      try {
        hosted = await startServer({ ...options, port: DEFAULT_PORT });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
        hosted = await startServer({ ...options, port: 0 });
      }
    } catch (error) {
      await storage.close();
      throw error;
    }
    githubToken = saved ? 'saved' : token ? 'cli' : 'none';
    const shareable = findShareableAddress();
    const url = `ws://${shareable.address}:${hosted.port}${SOCKET_PATH}`;
    hosting = {
      invite: encodeInvite({ url, secret: hosted.secret, sessionName: hosted.session.name }),
      address: shareable.address,
      addressSource: shareable.source,
      port: hosted.port,
    };
    joined = { url: hosted.localUrl, secret: hosted.secret };
    const previous = sessions().get(key);
    sessions().save({
      key,
      role: 'host',
      sessionId: hosted.session.id,
      name: hosted.session.name,
      invite: hosting.invite,
      repo: previous?.repo ?? null,
    });
    currentKey = key;
    startBackups(key, storage);
    client.connect({ url: hosted.localUrl, secret: hosted.secret, name, identity: loadIdentity() });
    return { ok: true };
  } catch (error) {
    await stopHosting();
    // A new session that never started leaves nothing behind.
    if (!savedKey) sessions().forget(key);
    return failure(error);
  }
}

async function joinSession({ name, invite }: JoinRequest): Promise<Result> {
  const decoded = decodeInvite(invite);
  if (!decoded) return { ok: false, error: 'That is not a valid invite code.' };
  await stopHosting();
  flushCache();
  cachedUrl = decoded.url;
  joined = { url: decoded.url, secret: decoded.secret };
  const key = sessions().joinKey(decoded.url);
  const saved = sessions().get(key);
  sessions().save({
    key,
    role: 'join',
    sessionId: saved?.sessionId ?? null,
    name: decoded.sessionName ?? saved?.name ?? 'Session',
    invite: invite.trim(),
    repo: saved?.repo ?? null,
  });
  currentKey = key;
  client.connect({ url: decoded.url, secret: decoded.secret, name, identity: loadIdentity() }, loadSnapshot(decoded.url));
  return { ok: true };
}

// Invite codes (issue #36). The host can make a new code when the old one
// leaked, and remove someone from the session. Everyone connected gets the
// new secret through the session; it is saved here so Rejoin keeps working.

client.onMessage((message) => {
  if (message.type !== 'session.secret') return;
  if (joined) joined = { ...joined, secret: message.secret };
  const entry = currentKey ? sessions().get(currentKey) : null;
  // The host's own invite is updated by newInvite.
  if (!entry || entry.role !== 'join' || !entry.invite) return;
  const saved = decodeInvite(entry.invite);
  if (saved) sessions().update(entry.key, { invite: encodeInvite({ ...saved, secret: message.secret }) });
});

async function newInvite(): Promise<Result> {
  const server = hosted;
  const current = hosting && decodeInvite(hosting.invite);
  if (!server || !hosting || !current) return { ok: false, error: 'Only the host can make a new invite code.' };
  try {
    const secret = await server.newSecret(client.getState().you?.name ?? null);
    hosting = { ...hosting, invite: encodeInvite({ ...current, secret }) };
    joined = { url: server.localUrl, secret };
    if (currentKey) sessions().update(currentKey, { invite: hosting.invite });
    pushState();
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

async function removeParticipant(id: unknown): Promise<Result> {
  const state = client.getState();
  const person = state.participants.find((p) => p.id === id && p.kind === 'human');
  if (!hosted) return { ok: false, error: 'Only the host can remove someone from the session.' };
  if (!person) return { ok: false, error: 'They are not in the session now.' };
  if (person.id === state.you?.id) return { ok: false, error: 'To leave, stop hosting.' };
  const answer = await messageBox({
    type: 'warning',
    title: 'Remove from session',
    message: `Remove ${person.name} from the session?`,
    detail:
      `${person.name} is disconnected, along with any agents running on their PC, and their locks are freed. ` +
      'Their saved Rejoin stops working until you send them a new invite code.',
    checkboxLabel: `Also make a new invite code (${person.name}'s PC knows the current one)`,
    checkboxChecked: true,
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (answer.response !== 0) return { ok: true };
  try {
    const result = await hosted.removeParticipant(person.id, state.you?.name ?? null);
    if (!result.ok) return { ok: false, error: result.message };
  } catch (error) {
    return failure(error);
  }
  return answer.checkboxChecked ? newInvite() : { ok: true };
}

/**
 * Asks before stopping when the friend is connected to the session hosted
 * here or an agent on this PC is mid-turn. True when it is fine to go on.
 */
async function confirmStop(action: 'quit' | 'leave'): Promise<boolean> {
  const cut = whoWouldBeCutOff(client.getState(), Object.keys(localAgents.list()), !!hosted);
  const sentence = cutOffSentence(cut);
  if (!sentence) return true;
  const verb = action === 'quit' ? 'Quit' : hosted ? 'Stop hosting' : 'Leave';
  const { response } = await messageBox({
    type: 'warning',
    title: verb,
    message: `${sentence} ${verb === 'Quit' ? 'Quit anyway' : `${verb} anyway`}?`,
    detail: stopConfirmDetail(cut, !!hosted),
    buttons: [verb, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

async function leave() {
  // Keep the cache: changes not sent yet go out the next time you join.
  flushCache();
  cachedUrl = null;
  client.disconnect();
  await stopHosting();
  pushState();
}

async function startAgent(agentId: unknown): Promise<Result> {
  const state = client.getState();
  const profile = state.agents.find((a) => a.id === agentId);
  if (!profile) return { ok: false, error: 'That agent no longer exists.' };
  if (state.status !== 'connected' || !joined || !state.you) return { ok: false, error: 'Agents start once you are connected.' };
  if (!workspace?.folder) return { ok: false, error: 'Choose your project folder first (bottom left): agents work in it.' };
  if (profile.connection.type === 'cli' && !cliTools[profile.connection.tool]) {
    cliTools = await findCliTools();
    if (!cliTools[profile.connection.tool]) return { ok: false, error: `${profile.connection.tool === 'codex' ? 'Codex CLI' : 'Claude Code'} is not installed on this PC.` };
  }
  localAgents.start({
    profileId: profile.id,
    name: profile.name,
    url: joined.url,
    secret: joined.secret,
    startedBy: state.you.name,
    startedById: state.you.id,
    root: workspace.folder,
    // Read each turn, so engine settings changed here apply from the agent's next turn.
    engine: (agent) => engineSettingsFor(engineNow(), agent),
  });
  return { ok: true };
}

// An agent chat's own copy of the project (a git worktree on its own branch)
// lives on the PC of the person who started the agent; only that PC can
// review, merge, push or throw it away. Merging and discarding wait until the
// agent is between turns, and free the locks the chat holds afterwards.

let worktreeBusy = false;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function ownWorktree(chatId: unknown): { chat: ChatInfo; worktree: ChatWorktree } | { error: string } {
  const state = client.getState();
  const chat = state.chats.find((c) => c.id === chatId);
  if (!chat) return { error: 'That chat no longer exists.' };
  const worktree = chat.worktree;
  if (!worktree) return { error: 'This chat has no copy of its own yet; it gets one when the agent starts on it.' };
  if (worktree.owner.id !== state.you?.id) return { error: `The agent's copy is on ${worktree.owner.name}'s PC; only they can open, merge or discard it.` };
  // Names the runner makes (agent/<slug>-<id>); anything else is not acted on.
  if (!/^agent\/[a-z0-9][a-z0-9-]*$/.test(worktree.branch)) return { error: 'That is not a branch the agent made.' };
  if (!existsSync(worktree.folder)) return { error: `The agent's copy is no longer at ${worktree.folder}.` };
  return { chat, worktree };
}

/** Frees the locks the chat's agent holds, once its work is merged or thrown away. */
function releaseChatLocks(chatId: string) {
  for (const lock of client.getState().locks) {
    if (lock.chatId === chatId && lock.holder.kind === 'agent') client.releaseLock(lock.id);
  }
}

async function refreshWorktree(chat: ChatInfo, worktree: ChatWorktree, note: string) {
  const status = await worktreeStatus(worktree.folder, { branch: worktree.base, commit: worktree.baseCommit }).catch(() => null);
  client.setChatWorktree(chat.id, { ...worktree, ...status, updatedAt: Date.now() }, note);
}

async function worktreeAction(chatId: unknown, action: unknown): Promise<ResultWith<string>> {
  const own = ownWorktree(chatId);
  if ('error' in own) return { ok: false, error: own.error };
  const { chat, worktree } = own;
  if (action === 'open') {
    const problem = await shell.openPath(worktree.folder);
    return problem ? { ok: false, error: problem } : { ok: true, value: 'Opened the folder.' };
  }
  if (action !== 'merge' && action !== 'pull-request' && action !== 'discard') return { ok: false, error: 'Unknown action.' };
  if (chat.state !== 'idle') return { ok: false, error: 'The agent is still working in its copy. Wait for it to finish, or stop it first.' };
  if (worktreeBusy || gitBusy) return { ok: false, error: 'Git is still busy with the last action.' };
  const state = client.getState();
  const agentName = state.agents.find((a) => a.id === chat.agentId)?.name ?? 'Agent';
  worktreeBusy = true;
  try {
    switch (action) {
      case 'merge': {
        const folder = workspace?.folder;
        if (!folder || workspace?.error) return { ok: false, error: 'Choose your project folder first (bottom left): the work is merged into it.' };
        if ((await mainCheckout(worktree.folder)) !== (await mainCheckout(folder))) {
          return { ok: false, error: 'Your project folder is a different repository from the one the agent copied.' };
        }
        await commitAll(worktree.folder, `${agentName}: ${chat.title}`);
        const message = await mergeBranch(folder, worktree.branch, `Merge ${agentName}'s work: ${chat.title}`);
        const into = workspace?.workspace?.branch ?? 'your branch';
        releaseChatLocks(chat.id);
        await refreshWorktree(chat, worktree, `merged ${agentName}'s work on ${worktree.branch} into ${into}`);
        return { ok: true, value: message };
      }
      case 'pull-request': {
        await commitAll(worktree.folder, `${agentName}: ${chat.title}`);
        const message = await pushBranch(worktree.folder, worktree.branch, await gitToken());
        await refreshWorktree(chat, worktree, `pushed ${agentName}'s work on ${worktree.branch} to GitHub`);
        const repo = state.github.repo;
        if (repo) {
          const base = worktree.base ?? state.github.defaultBranch ?? 'main';
          void shell.openExternal(
            `https://github.com/${repo.owner}/${repo.name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(worktree.branch)}?expand=1`,
          );
          return { ok: true, value: `${message} The pull request page is open in your browser.` };
        }
        return { ok: true, value: message };
      }
      case 'discard': {
        const { response } = await messageBox({
          type: 'warning',
          buttons: ['Discard changes', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          message: `Throw away ${agentName}'s copy for "${chat.title}"?`,
          detail: `Its folder and branch ${worktree.branch} are deleted, with ${plural(worktree.files.length, 'changed file')} that ${worktree.files.length === 1 ? 'is' : 'are'} not merged. Your project folder is not touched. The agent starts a fresh copy the next time it works in this chat.`,
        });
        if (response !== 0) return { ok: true, value: '' };
        const root = await mainCheckout(worktree.folder);
        if (workspace?.folder && root !== (await mainCheckout(workspace.folder).catch(() => null))) {
          return { ok: false, error: 'The agent copied a different repository from your project folder; remove it from there.' };
        }
        await removeWorktree(root, worktree.folder, worktree.branch, true);
        releaseChatLocks(chat.id);
        client.setChatWorktree(chat.id, null, `discarded ${agentName}'s changes on ${worktree.branch}`);
        return { ok: true, value: `Discarded ${worktree.branch}.` };
      }
    }
    return { ok: false, error: 'Unknown action.' };
  } catch (error) {
    return failure(error);
  } finally {
    worktreeBusy = false;
    void watcher?.poll();
  }
}

async function showWorktreeDiff(chatId: unknown): Promise<ResultWith<string>> {
  const own = ownWorktree(chatId);
  if ('error' in own) return { ok: false, error: own.error };
  try {
    return { ok: true, value: await worktreeDiff(own.worktree.folder, { branch: own.worktree.base, commit: own.worktree.baseCommit }) };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Deletes a chat after asking. When this PC holds the chat's copy and it has
 * work nobody merged, you choose whether its branch is kept.
 */
async function deleteChat(chatId: unknown): Promise<Result> {
  const chat = client.getState().chats.find((c) => c.id === chatId);
  if (!chat) return { ok: false, error: 'That chat no longer exists.' };
  const own = ownWorktree(chat.id);
  const worktree = 'error' in own ? null : own.worktree;
  const unmerged = worktree ? await worktreeStatus(worktree.folder, { branch: worktree.base, commit: worktree.baseCommit }).catch(() => null) : null;
  const pending = unmerged && (unmerged.commits > 0 || unmerged.uncommitted > 0);
  const { response } = await messageBox({
    type: 'warning',
    buttons: pending ? ['Delete, keep the branch', 'Delete with its changes', 'Cancel'] : ['Delete chat', 'Cancel'],
    defaultId: pending ? 2 : 1,
    cancelId: pending ? 2 : 1,
    message: `Delete the chat "${chat.title}" for everyone?`,
    detail: pending
      ? `The agent's copy has ${plural(unmerged!.files.length, 'changed file')} that ${unmerged!.files.length === 1 ? 'is' : 'are'} not merged. ` +
        `Keep the branch ${worktree!.branch} to merge them later, or delete them with the chat.`
      : worktree
        ? `The agent's copy (${worktree.branch}) has nothing left to merge and is removed too.`
        : 'Its messages are deleted for everyone in the session.',
  });
  if (response === (pending ? 2 : 1)) return { ok: true };
  if (worktree) {
    try {
      const keep = pending && response === 0;
      if (keep) await commitAll(worktree.folder, 'Work in progress, saved when the chat was deleted');
      await removeWorktree(await mainCheckout(worktree.folder), worktree.folder, worktree.branch, !keep);
    } catch (error) {
      return failure(error);
    }
  }
  releaseChatLocks(chat.id);
  client.deleteChat(chat.id);
  return { ok: true };
}

function chatToTask(chatId: unknown): Result {
  const state = client.getState();
  const chat = state.chats.find((c) => c.id === chatId);
  if (!chat) return { ok: false, error: 'That chat no longer exists.' };
  if (chat.taskId && state.tasks.some((t) => t.id === chat.taskId)) return { ok: false, error: 'This chat already has a task.' };
  const agent = state.agents.find((a) => a.id === chat.agentId);
  const scope = chat.handoff?.scope.length ? chat.handoff.scope : (agent?.allowedPaths ?? []);
  const criteria = (chat.handoff?.criteria ?? []).map((text) => ({ id: randomUUID(), text }));
  const taskId = client.createTask(chat.title, { stage: 'planning', scope, criteria });
  client.updateChat(chat.id, { taskId });
  return { ok: true };
}

/**
 * Hands work to another agent: a new chat that starts from the handoff
 * package, the task moved to the next stage and, if that agent is running,
 * assigned to it.
 */
function handOff(request: HandoffRequest): ResultWith<string> {
  const state = client.getState();
  if (state.status !== 'connected') return { ok: false, error: 'Handoffs need the session server.' };
  const target = state.agents.find((a) => a.id === request.agentId);
  if (!target) return { ok: false, error: 'That agent no longer exists.' };
  const from = state.chats.find((c) => c.id === request.fromChatId) ?? null;
  const fromAgent = from ? state.agents.find((a) => a.id === from.agentId) : undefined;
  const parsed = Handoff.safeParse({ ...request.handoff, fromChatId: from?.id ?? null, fromName: fromAgent?.name ?? state.you?.name ?? null });
  if (!parsed.success) return { ok: false, error: 'Some of the handoff is too long or empty.' };
  const handoff = parsed.data;
  const task = state.tasks.find((t) => t.id === request.taskId) ?? null;
  const title = ChatTitle.safeParse(
    request.title ?? (task ? `${task.title} · ${handoff.stage ?? 'handoff'}` : `Handoff from ${handoff.fromName ?? 'chat'}`),
  );
  const chatId = client.createChat({
    agentId: target.id,
    title: title.success ? title.data : 'Handoff',
    taskId: task?.id ?? null,
    handoff,
  });
  client.postChat(chatId, { kind: 'handoff', text: renderHandoff(handoff, task?.title ?? null) });
  if (task) {
    const running = state.participants.find((p) => p.agent?.profileId === target.id);
    client.updateTask(task.id, {
      ...(handoff.stage && handoff.stage !== task.stage && { stage: handoff.stage }),
      ...(handoff.scope.join('\n') !== task.scope.join('\n') && handoff.scope.length > 0 && { scope: handoff.scope }),
      ...(handoff.readFirst.join('\n') !== task.readFirst.join('\n') && handoff.readFirst.length > 0 && { readFirst: handoff.readFirst }),
      ...(running && { ownerId: running.id }),
    });
  }
  return { ok: true, value: chatId };
}

/** Creates the approved feature's tasks, each with its criteria, and marks the plan approved. */
function approvePlan(input: unknown): Result {
  const parsed = PlanApproval.safeParse(input);
  if (!parsed.success) return { ok: false, error: `Check the tasks: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  const { featureId, tasks } = parsed.data;
  if (!client.canEditTasks()) return { ok: false, error: 'Join the session first.' };
  const feature = client.getState().planning.find((i) => i.id === featureId);
  if (!feature) return { ok: false, error: 'That feature no longer exists.' };
  if (feature.kind !== 'feature') client.editPlanning({ op: 'set', id: featureId, kind: 'feature' });
  for (const task of tasks) {
    client.createTask(task.title, {
      stage: 'planning',
      scope: task.scope,
      readFirst: task.readFirst,
      featureId,
      criteria: task.criteria.map((text) => ({ id: randomUUID(), text })),
    });
  }
  client.editPlanning({ op: 'approve', id: featureId });
  return { ok: true };
}

let bloatRunning = false;

async function bloatCheck(): Promise<Result> {
  const state = client.getState();
  if (state.status !== 'connected') return { ok: false, error: 'The result is shared with the session; it needs the session server.' };
  const folder = workspace?.folder;
  if (!folder || workspace?.error) return { ok: false, error: 'Choose your project folder first (bottom left): the check reads it.' };
  if (bloatRunning) return { ok: false, error: 'A bloat check is already running.' };
  bloatRunning = true;
  try {
    const report = await runBloatCheck(folder, state.you?.name ?? 'Someone', workspace?.workspace?.branch ?? null);
    client.shareBloat(report);
    return { ok: true };
  } catch (error) {
    return failure(error);
  } finally {
    bloatRunning = false;
  }
}

// Folder notes: scanned on request, kept until your project folder changes
// (another branch, a commit, an edit), so opening the tab again is instant.
let folderNotes: { key: string; report: FolderNotesReport } | null = null;
let folderNotesScan: { key: string; done: Promise<FolderNotesReport> } | null = null;

async function scanNotes(fresh: unknown): Promise<ResultWith<FolderNotesReport>> {
  const folder = workspace?.folder;
  if (!folder || workspace?.error) return { ok: false, error: 'Choose your project folder first (bottom left): the notes are read from it.' };
  const key = JSON.stringify([folder, workspace?.workspace?.branch, workspace?.workspace?.files, workspace?.git?.uncommitted, workspace?.git?.ahead]);
  if (fresh !== true && folderNotes?.key === key) return { ok: true, value: folderNotes.report };
  let done = folderNotesScan?.key === key ? folderNotesScan.done : null;
  if (!done) {
    const scan = scanFolderNotes(folder);
    folderNotesScan = { key, done: scan };
    void scan
      .then((report) => {
        folderNotes = { key, report };
        void keepNotesUpToDate(report);
      })
      .catch(() => undefined)
      .finally(() => {
        if (folderNotesScan?.done === scan) folderNotesScan = null;
      });
    done = scan;
  }
  try {
    return { ok: true, value: await done };
  } catch (error) {
    return failure(error);
  }
}

// Just the note paths, for the review flag on tasks: one git call, kept like the scan.
let notePaths: { key: string; paths: Promise<string[]> } | null = null;

function folderNotePaths(): Promise<string[]> {
  const folder = workspace?.folder;
  if (!folder || workspace?.error) return Promise.resolve([]);
  const key = JSON.stringify([folder, workspace?.workspace?.branch, workspace?.workspace?.files]);
  if (notePaths?.key !== key) {
    notePaths = { key, paths: listProjectFiles(folder).then((files) => files.filter(isNotePath), () => []) };
  }
  return notePaths.paths;
}

async function folderNoteTask(folder: unknown): Promise<ResultWith<string>> {
  if (typeof folder !== 'string') return { ok: false, error: 'That is not a folder.' };
  let info: { path: string; notePath: string | null } | undefined = folderNotes?.report.folders.find((f) => f.path === folder);
  // From a task's review flag or the bloat report: the full scan may not have run here.
  if (!info) {
    const path = folder === '' ? '' : normalizePath(folder);
    if (path === null) return { ok: false, error: 'That folder is outside the project.' };
    const notePath = (await folderNotePaths()).find((p) => p.toLowerCase() === (path ? `${path}/${NOTE_FILE}` : NOTE_FILE).toLowerCase());
    info = { path, notePath: notePath ?? null };
  }
  const label = info.path === '' ? 'top folder' : `${info.path}/`;
  const notePath = info.notePath ?? (info.path ? `${info.path}/AGENTS.md` : 'AGENTS.md');
  const title = info.notePath ? `Update folder note for ${label}` : `Write folder note for ${label}`;
  return { ok: true, value: client.createTask(title.slice(0, 200), { stage: 'planning', scope: [notePath] }) };
}

// Project setup (#46): the engine project is made with the engine, then the
// wizard writes the preset into your project folder, has an agent draft the
// first folder notes, and commits it all as one commit. From then on the
// agent chosen there keeps the notes up to date by itself: when a scan finds
// a note gone stale or a big folder without one, it drafts the note and the
// draft waits on the Folder notes tab until someone accepts or discards it.

const NOTE_PURPOSE = 'short folder notes (AGENTS.md) that tell other agents what a folder is for';

function currentNotesAgent(): string | null {
  const sessionId = client.getState().session?.id;
  return sessionId ? notesAgent(sessionId) : null;
}

function showSetupProgress(step: string, done: number, total: number) {
  setupProgress = { step, done, total };
  pushState();
}

async function readSetup(engineInput: unknown): Promise<ResultWith<SetupPlan>> {
  const root = workspace?.folder;
  if (!root) return { ok: false, error: 'Choose your project folder first (bottom left): setup writes there.' };
  try {
    const facts = await readProjectFacts(root);
    const detected = detectProject(facts);
    const picked = Engine.safeParse(engineInput);
    const engine = picked.success ? picked.data : detected.engine;
    const state = client.getState();
    const sessionId = state.session?.id;
    const items = planSetup(engine, detected, facts, {
      lockRules: state.lockRules,
      memory: state.memory,
      memoryAuto: sessionId ? autoExportOn(sessionId) : false,
    });
    // A brand-new engine project may have no commit yet; the notes scan needs history.
    const committed = await hasCommit(root);
    const notes = committed ? await scanNotes(false) : null;
    const noteFolders = notes?.ok ? noteCandidates(notes.value).map((f) => ({ path: f.path, tokens: f.ownTokens, files: f.ownFiles })) : [];
    return { ok: true, value: { root, detected, engine, items, reminders: PRESETS[engine].reminders, noteFolders, firstCommit: !committed } };
  } catch (error) {
    return failure(error);
  }
}

/** Has the agent draft one folder's note; it is started on this PC if it is not running. */
async function draftNote(agentId: string, folder: FolderInfo, report: FolderNotesReport, signal: AbortSignal) {
  const root = workspace?.folder;
  if (!root) throw new Error('Choose your project folder first.');
  if (!localAgents.isRunning(agentId)) {
    const started = await startAgent(agentId);
    if (!started.ok) throw new Error(started.error);
  }
  const input = await noteDraftInput(root, folder, report);
  const text = cleanNote(await localAgents.draft(agentId, noteDraftPrompt(folder, input), null, signal, NOTE_PURPOSE));
  if (!text) throw new Error('The agent answered with an empty note.');
  return { text, previous: input.existing };
}

function parseSetupRequest(input: unknown): SetupRequest | null {
  const r = (input ?? {}) as Record<string, unknown>;
  const engine = Engine.safeParse(r.engine);
  const items = SetupItemId.array().max(20).safeParse(r.items);
  if (!engine.success || !items.success) return null;
  const folders = Array.isArray(r.noteFolders) ? r.noteFolders.filter((f): f is string => typeof f === 'string' && normalizePath(f) === f).slice(0, 20) : [];
  return {
    engine: engine.data,
    items: items.data,
    notesAgent: typeof r.notesAgent === 'string' ? r.notesAgent : null,
    noteFolders: folders,
    keepNotes: r.keepNotes === true,
    commit: r.commit !== false,
  };
}

async function runSetup(input: unknown): Promise<ResultWith<SetupOutcome>> {
  const request = parseSetupRequest(input);
  if (!request) return { ok: false, error: 'That is not a setup to run.' };
  const root = workspace?.folder;
  const sessionId = client.getState().session?.id;
  if (!root || !sessionId) return { ok: false, error: 'Choose your project folder first (bottom left): setup writes there.' };
  if (setupAbort) return { ok: false, error: 'Setup is already running.' };
  const abort = new AbortController();
  setupAbort = abort;
  const notes = request.notesAgent ? request.noteFolders : [];
  const total = 2 + notes.length;
  try {
    showSetupProgress('Writing the setup files', 0, total);
    const { engine, items } = request;
    const facts = await readProjectFacts(root);
    const detected = detectProject(facts);
    const written = writeProjectFiles(root, setupFiles(engine, facts, items));
    if (items.includes('gitattributes') && facts.lfs) await installGitLfs(root);
    if (items.includes('locks')) client.setLockRules(withPresetLocks(client.getState().lockRules, engine));
    if (items.includes('memory')) {
      const entry = engineEntry(detected, engine);
      if (!client.getState().memory.some((e) => e.title === entry.title)) {
        client.editMemory({ op: 'create', id: randomUUID(), kind: 'decision', title: entry.title, body: entry.body });
      }
      saveMemoryAutoExport(sessionId, true);
      memoryAuto = { sessionId, on: true };
      // A half-synced memory is never written; auto-write catches up once it has arrived.
      if (client.hasSynced('memory') && writeMemoryFile(root, client.getState().memory)) {
        written.push(MEMORY_EXPORT_PATH);
        memoryWrite = { at: Date.now(), error: null };
      }
    }

    const failedNotes: SetupOutcome['failedNotes'] = [];
    if (request.notesAgent && notes.length) {
      const report = await scanFolderNotes(root);
      for (const [i, path] of notes.entries()) {
        if (abort.signal.aborted) break;
        showSetupProgress(`Drafting the folder note for ${path}/`, 1 + i, total);
        const folder = report.folders.find((f) => f.path === path);
        if (!folder) continue;
        try {
          const { text } = await draftNote(request.notesAgent, folder, report, abort.signal);
          const notePath = folder.notePath ?? `${path}/${NOTE_FILE}`;
          written.push(...writeProjectFiles(root, { [notePath]: text }));
        } catch (error) {
          if (abort.signal.aborted) break;
          failedNotes.push({ folder: path, error: failure(error).error });
        }
      }
    }
    saveNotesAgent(sessionId, request.keepNotes ? request.notesAgent : null);

    let commit: string | null = null;
    if (request.commit && !abort.signal.aborted) {
      showSetupProgress('Committing', total - 1, total);
      commit = await commitPaths(root, written, SETUP_COMMIT_MESSAGE);
    }
    void watcher?.poll();
    return { ok: true, value: { written, commit, failedNotes } };
  } catch (error) {
    return failure(error);
  } finally {
    setupAbort = null;
    setupProgress = null;
    pushState();
  }
}

/** Adds or updates the Locks plugin (project setup's plugin item) and commits only its files. */
async function installGodotPlugin(): Promise<ResultWith<{ reload: boolean }>> {
  const root = workspace?.folder;
  if (!root) return { ok: false, error: 'Choose your project folder first (bottom left).' };
  try {
    const facts = await readProjectFacts(root);
    if (facts.godotProject === null) return { ok: false, error: 'Your project folder has no project.godot at the top.' };
    const written = writeProjectFiles(root, setupFiles('godot', facts, ['plugin']));
    if (written.length && (await hasCommit(root))) await commitPaths(root, written, GODOT_PLUGIN_COMMIT_MESSAGE);
    void watcher?.poll();
    // The editor loads plugins when it opens the project.
    const editor = engineNow().editor;
    return { ok: true, value: { reload: !!editor } };
  } catch (error) {
    return failure(error);
  } finally {
    pushState();
  }
}

/** Drafts this many notes at most per scan, so a big drift does not run up a bill at once. */
const UPKEEP_PER_SCAN = 2;
const UPKEEP_CHECK_MS = 15 * 60_000;
let upkeepRunning = false;

/** How a folder looks to its note: a new draft is only made when this changes. */
const noteFingerprint = (f: FolderInfo) => JSON.stringify([f.state, f.notePath, f.changed.map((c) => c.path), f.deadReferences, f.ownFiles]);

async function keepNotesUpToDate(report: FolderNotesReport) {
  const agentId = currentNotesAgent();
  if (!agentId || upkeepRunning || setupAbort || client.getState().status !== 'connected') return;
  if (!client.getState().agents.some((a) => a.id === agentId)) return;
  const pending = new Set(noteDrafts.map((d) => d.notePath));
  // The top folder's AGENTS.md holds the agent rules, which setup writes.
  const due = report.folders
    .filter((f) => f.path !== '' && (f.state === 'stale' || f.state === 'missing'))
    .map((f) => ({ folder: f, notePath: f.notePath ?? `${f.path}/${NOTE_FILE}` }))
    .filter(({ folder, notePath }) => !pending.has(notePath) && draftedNotes.get(notePath) !== noteFingerprint(folder))
    .slice(0, UPKEEP_PER_SCAN);
  if (due.length === 0) return;
  upkeepRunning = true;
  const abort = new AbortController();
  try {
    for (const { folder, notePath } of due) {
      draftedNotes.set(notePath, noteFingerprint(folder));
      const agentName = client.getState().agents.find((a) => a.id === agentId)?.name ?? 'An agent';
      try {
        const { text, previous } = await draftNote(agentId, folder, report, abort.signal);
        const reason = folder.state === 'missing' ? 'Big folder with no note' : `Stale: ${folder.reasons.join('; ')}`;
        noteDrafts = [...noteDrafts.filter((d) => d.notePath !== notePath), { folder: folder.path, notePath, text, previous, reason, agentName, draftedAt: Date.now() }];
        pushState();
      } catch (error) {
        console.error(`Could not draft the folder note ${notePath}`, error);
      }
    }
  } finally {
    upkeepRunning = false;
  }
}

setInterval(() => {
  if (!currentNotesAgent() || !workspace?.folder) return;
  void scanNotes(false).then((result) => {
    if (result.ok) void keepNotesUpToDate(result.value);
  });
}, UPKEEP_CHECK_MS);

function acceptNoteDraft(notePath: unknown): Result {
  const draft = noteDrafts.find((d) => d.notePath === notePath);
  const root = workspace?.folder;
  if (!draft) return { ok: false, error: 'That draft is gone.' };
  if (!root) return { ok: false, error: 'Choose your project folder first.' };
  try {
    writeProjectFiles(root, { [draft.notePath]: draft.text });
    noteDrafts = noteDrafts.filter((d) => d !== draft);
    pushState();
    void watcher?.poll();
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Project Collaboration Tool',
    backgroundColor: '#16181d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Links open in the browser; the window itself never navigates away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(__dirname, 'renderer', 'index.html'));

  // While hosting, or while agents run here, closing the window keeps the
  // app (and the session) running in the tray.
  window.on('close', (event) => {
    if (quitting || !keepsRunning()) return;
    event.preventDefault();
    window?.hide();
    showTray();
    if (firstTimeInTray()) {
      const notice = new Notification({
        title: 'Still running in the tray',
        body: hosted
          ? 'The session keeps going for the others, and agents keep working. Quit from the tray icon to stop.'
          : 'Agents on this PC keep working. Quit from the tray icon to stop.',
      });
      notice.on('click', focusWindow);
      notice.show();
    }
  });
  window.on('closed', () => {
    window = null;
  });
}

/** Set once quitting is decided, so closing the window no longer hides it. */
let quitting = false;
let tray: Tray | null = null;

/** Closing the window would cut off the friend or stop agents. */
const keepsRunning = () => !!hosted || Object.keys(localAgents.list()).length > 0;

/** A small rounded square in the app's accent colour, drawn here so no icon file has to ship. */
function trayIcon() {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  const radius = 7;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
      const inside = dx * dx + dy * dy <= radius * radius;
      const dot = (x - 15.5) ** 2 + (y - 15.5) ** 2 <= 36;
      const at = (y * size + x) * 4;
      // BGRA
      if (dot) pixels.set([255, 255, 255, 255], at);
      else if (inside) pixels.set([0xf2, 0x8c, 0x4c, 255], at);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

function showTray() {
  if (!tray) {
    tray = new Tray(trayIcon());
    tray.on('click', focusWindow);
  }
  const session = client.getState().session?.name;
  tray.setToolTip(hosted && session ? `Project Collaboration Tool: hosting ${session}` : 'Project Collaboration Tool');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: focusWindow },
      { type: 'separator' },
      { label: hosted ? 'Stop hosting and quit' : 'Quit', click: () => void quitFromTray() },
    ]),
  );
}

async function quitFromTray() {
  if (!(await confirmStop('quit'))) return;
  quitting = true;
  await leave();
  app.quit();
}

ipcMain.handle(Channel.getState, () => appState());
ipcMain.handle(Channel.host, (_event, request: HostRequest) => host(request));
ipcMain.handle(Channel.join, (_event, request: JoinRequest) => joinSession(request));
ipcMain.handle(Channel.leave, async () => {
  if (await confirmStop('leave')) await leave();
});
ipcMain.handle(Channel.newInvite, () => newInvite());
ipcMain.handle(Channel.removeParticipant, (_event, id: unknown) => removeParticipant(id));
ipcMain.handle(Channel.listSessions, () => listSessions());
ipcMain.handle(Channel.resume, (_event, request: ResumeRequest) => {
  if (!request || typeof request.key !== 'string' || typeof request.name !== 'string') return { ok: false, error: 'Pick a session.' };
  return resume(request);
});
ipcMain.handle(Channel.forgetSession, (_event, key: unknown) => forgetSession(key));
ipcMain.handle(Channel.listBackups, (_event, key: unknown) => listBackups(key));
ipcMain.handle(Channel.restoreBackup, (_event, key: unknown, path: unknown) => restoreBackup(key, path));
ipcMain.handle(Channel.getBackupFolder, () => backupFolder());
ipcMain.handle(Channel.createSnapshot, (_event, request: unknown) => createSnapshot(request));
ipcMain.handle(Channel.deleteSnapshot, (_event, key: unknown, path: unknown) => deleteSnapshot(key, path));
ipcMain.handle(Channel.setBackupFolder, (_event, choose: unknown) => setBackupFolder(choose));
ipcMain.on(Channel.setPresence, (_event, status: unknown, focus: unknown) => {
  const parsed = PresenceStatus.safeParse(status);
  if (parsed.success) client.setPresence(parsed.data, typeof focus === 'string' ? focus : null);
});
// Task messages from the window are checked here too; the server validates
// them again before anything changes.
ipcMain.on(Channel.createTask, (_event, title: unknown, stage: unknown) => {
  const parsedStage = TaskStage.safeParse(stage);
  if (typeof title === 'string' && title.trim() && parsedStage.success) client.createTask(title.trim(), { stage: parsedStage.data });
});
ipcMain.on(Channel.updateTask, (_event, taskId: unknown, changes: unknown) => {
  const parsed = TaskUpdateMessage.safeParse({ type: 'task.update', taskId, changes });
  if (parsed.success) client.updateTask(parsed.data.taskId, parsed.data.changes);
});
ipcMain.on(Channel.deleteTask, (_event, taskId: unknown) => {
  if (typeof taskId === 'string') client.deleteTask(taskId);
});
ipcMain.on(Channel.acquireLock, (_event, path: unknown, options: unknown) => {
  const parsed = LockAcquireMessage.safeParse({ type: 'lock.acquire', path, ...(options as object) });
  if (parsed.success) client.acquireLock(parsed.data.path, parsed.data);
});
ipcMain.on(Channel.releaseLock, (_event, lockId: unknown) => {
  if (typeof lockId === 'string') client.releaseLock(lockId);
});
ipcMain.on(Channel.recoverLock, (_event, lockId: unknown) => {
  if (typeof lockId === 'string') client.recoverLock(lockId);
});
ipcMain.on(Channel.setPrices, (_event, prices: unknown) => {
  const parsed = PriceTable.safeParse(prices);
  if (parsed.success) client.setPrices(parsed.data);
});
ipcMain.on(Channel.setLockRules, (_event, rules: unknown) => {
  const parsed = LockRules.safeParse(rules);
  if (parsed.success) client.setLockRules(parsed.data);
});
ipcMain.handle(Channel.chooseWorkspace, () => chooseWorkspace());
ipcMain.handle(Channel.readSetup, (_event, engine: unknown) => readSetup(engine));
ipcMain.handle(Channel.runSetup, (_event, request: unknown) => runSetup(request));
ipcMain.on(Channel.cancelSetup, () => setupAbort?.abort());
ipcMain.on(Channel.setEngineBridge, (_event, bridge: unknown) => {
  if (bridge !== 'auto' && bridge !== 'off' && bridge !== 'godot' && bridge !== 'summer') return;
  saveEngineBridge(bridge);
  pushState();
});

ipcMain.on(Channel.setEngineAgent, (_event, agentId: unknown, on: unknown) => {
  const sessionId = client.getState().session?.id;
  if (!sessionId || typeof agentId !== 'string' || typeof on !== 'boolean') return;
  saveEngineAgent(sessionId, agentId, on);
  pushState();
});

ipcMain.handle(Channel.installGodotPlugin, () => installGodotPlugin());
ipcMain.handle(Channel.setGodotPath, async (_event, choose: unknown): Promise<Result> => {
  if (choose !== true) {
    saveGodotPath(null);
    await findGodotOnPath();
    pushState();
    return { ok: true };
  }
  const picked = await openDialog({
    title: 'Choose the Godot (or Summer Engine) program',
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : [],
  });
  const path = picked.filePaths[0];
  if (picked.canceled || !path) return { ok: false, error: 'cancelled' };
  saveGodotPath(path);
  pushState();
  return { ok: true };
});

ipcMain.on(Channel.setNotesAgent, (_event, agentId: unknown) => {
  const sessionId = client.getState().session?.id;
  if (!sessionId || (agentId !== null && typeof agentId !== 'string')) return;
  saveNotesAgent(sessionId, agentId);
  pushState();
  if (agentId && folderNotes) void keepNotesUpToDate(folderNotes.report);
});
ipcMain.handle(Channel.acceptNoteDraft, (_event, notePath: unknown) => acceptNoteDraft(notePath));
ipcMain.on(Channel.discardNoteDraft, (_event, notePath: unknown) => {
  noteDrafts = noteDrafts.filter((d) => d.notePath !== notePath);
  pushState();
});
ipcMain.on(Channel.stopWorkspace, () => stopWorkspace());
ipcMain.handle(Channel.cloneRepo, () => cloneRepo());
ipcMain.handle(Channel.gitAction, (_event, action: unknown) => gitAction(action));
ipcMain.handle(Channel.draftCommitMessage, (_event, agentId: unknown) => draftCommitMessage(agentId));
ipcMain.on(Channel.cancelCommitDraft, () => drafting?.abort());
ipcMain.handle(Channel.linkRepo, (_event, input: unknown): Result => {
  if (input === null) {
    client.linkRepo(null);
    return { ok: true };
  }
  const repo = typeof input === 'string' ? parseRepoRef(input) : null;
  if (!repo) return { ok: false, error: 'Enter the repository as owner/name, or paste its GitHub address.' };
  client.linkRepo(repo);
  return { ok: true };
});
ipcMain.handle(Channel.createIssue, async (_event, input: unknown): Promise<ResultWith<number>> => {
  const request = (input ?? {}) as { title?: unknown; body?: unknown; link?: { kind?: unknown; id?: unknown } | null };
  const title = typeof request.title === 'string' ? request.title.trim().slice(0, ISSUE_TITLE_LIMIT) : '';
  if (!title) return { ok: false, error: 'The issue needs a title.' };
  const body = typeof request.body === 'string' ? request.body.slice(0, ISSUE_BODY_LIMIT) : '';
  const kind = IssueLinkKind.safeParse(request.link?.kind);
  const id = request.link?.id;
  const link = kind.success && typeof id === 'string' && id.length >= 8 && id.length <= 64 ? { kind: kind.data, id } : null;
  const result = await client.createIssue(title, body);
  if (!result.ok) return result;
  if (link) client.editPlanning({ op: 'issue', number: result.number, link: { ...link, linked: true } });
  pushState();
  return { ok: true, value: result.number };
});
ipcMain.handle(Channel.closeIssue, async (_event, number: unknown, comment: unknown): Promise<Result> => {
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return { ok: false, error: 'No such issue.' };
  if (typeof comment !== 'string' || !comment.trim()) return { ok: false, error: 'Write a comment to close the issue with.' };
  const result = await client.closeIssue(number, comment.slice(0, ISSUE_COMMENT_LIMIT));
  return result.ok ? { ok: true } : result;
});
ipcMain.handle(Channel.setGitHubToken, async (_event, input: unknown): Promise<Result> => {
  if (!hosted) return { ok: false, error: 'Only the host sets the GitHub token.' };
  const token = typeof input === 'string' ? input.trim() : null;
  if (token !== null && !/^[\w-]{20,255}$/.test(token)) return { ok: false, error: 'That does not look like a GitHub token.' };
  try {
    saveGitHubToken(token);
    const fallback = token ?? (await tokenFromGitHubCli());
    hosted.setGitHubToken(fallback);
    githubToken = token ? 'saved' : fallback ? 'cli' : 'none';
    pushState();
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
});
ipcMain.handle(Channel.saveAgent, (_event, agent: unknown): Result => {
  const parsed = AgentSaveMessage.safeParse({ type: 'agent.save', agent });
  if (!parsed.success) return { ok: false, error: `Check the agent's settings: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  if (client.getState().status !== 'connected') return { ok: false, error: 'Agents are saved on the session server; it is not reachable.' };
  client.saveAgent(parsed.data.agent);
  return { ok: true };
});
ipcMain.on(Channel.deleteAgent, (_event, agentId: unknown) => {
  if (typeof agentId !== 'string') return;
  void localAgents.stop(agentId);
  client.deleteAgent(agentId);
});
ipcMain.handle(Channel.startAgent, (_event, agentId: unknown) => startAgent(agentId));
ipcMain.on(Channel.stopAgent, (_event, agentId: unknown) => {
  if (typeof agentId === 'string') void localAgents.stop(agentId);
});
ipcMain.handle(Channel.setApiKey, (_event, name: unknown, key: unknown): Result => {
  if (typeof name !== 'string' || !/^[\w:.-]{1,200}$/.test(name)) return { ok: false, error: 'Unknown key.' };
  const value = typeof key === 'string' ? key.trim() : null;
  if (value !== null && !/^\S{8,500}$/.test(value)) return { ok: false, error: 'That does not look like an API key.' };
  try {
    saveApiKey(name, value || null);
    pushState();
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
});
ipcMain.handle(Channel.createChat, (_event, request: { agentId?: unknown; title?: unknown; taskId?: unknown }): ResultWith<string> => {
  const title = ChatTitle.safeParse(request?.title);
  if (typeof request?.agentId !== 'string' || !title.success) return { ok: false, error: 'Give the chat a title.' };
  if (client.getState().status !== 'connected') return { ok: false, error: 'Chats need the session server.' };
  const taskId = typeof request.taskId === 'string' ? request.taskId : null;
  return { ok: true, value: client.createChat({ agentId: request.agentId, title: title.data, taskId }) };
});
ipcMain.handle(
  Channel.branchChat,
  (_event, request: { fromChatId?: unknown; fromMessageId?: unknown; title?: unknown; agentId?: unknown }): ResultWith<string> => {
    const title = ChatTitle.safeParse(request?.title);
    if (typeof request?.fromChatId !== 'string' || typeof request.fromMessageId !== 'string') return { ok: false, error: 'Pick a message to branch from.' };
    if (!title.success) return { ok: false, error: 'Give the new chat a title.' };
    if (client.getState().status !== 'connected') return { ok: false, error: 'Chats need the session server.' };
    const agentId = typeof request.agentId === 'string' ? request.agentId : undefined;
    return {
      ok: true,
      value: client.branchChat({ fromChatId: request.fromChatId, fromMessageId: request.fromMessageId, title: title.data, agentId }),
    };
  },
);
ipcMain.on(Channel.updateChat, (_event, chatId: unknown, changes: { title?: unknown; taskId?: unknown; budget?: unknown }) => {
  if (typeof chatId !== 'string' || !changes) return;
  const title = changes.title === undefined ? undefined : ChatTitle.safeParse(changes.title);
  if (title && !title.success) return;
  const taskId = changes.taskId === undefined ? undefined : typeof changes.taskId === 'string' ? changes.taskId : null;
  const budget = changes.budget === undefined ? undefined : Budget.nullable().safeParse(changes.budget);
  if (budget && !budget.success) return;
  client.updateChat(chatId, {
    ...(title && { title: title.data }),
    ...(taskId !== undefined && { taskId }),
    ...(budget && { budget: budget.data }),
  });
});
ipcMain.handle(Channel.deleteChat, (_event, chatId: unknown) => deleteChat(chatId));
ipcMain.handle(Channel.worktreeAction, (_event, chatId: unknown, action: unknown) => worktreeAction(chatId, action));
ipcMain.handle(Channel.worktreeDiff, (_event, chatId: unknown) => showWorktreeDiff(chatId));
ipcMain.on(Channel.openChat, (_event, chatId: unknown) => {
  if (typeof chatId === 'string') client.openChat(chatId);
});
ipcMain.on(Channel.postChat, (_event, chatId: unknown, text: unknown) => {
  if (typeof chatId === 'string' && typeof text === 'string' && text.trim()) client.postChat(chatId, { kind: 'text', text: text.trim().slice(0, 100_000) });
});
ipcMain.on(Channel.decideApproval, (_event, chatId: unknown, messageId: unknown, approve: unknown) => {
  if (typeof chatId === 'string' && typeof messageId === 'string') client.decideApproval(chatId, messageId, approve === true);
});
ipcMain.on(Channel.stopChat, (_event, chatId: unknown) => {
  if (typeof chatId === 'string') client.stopChat(chatId);
});
ipcMain.on(Channel.undoTurn, (_event, chatId: unknown, messageId: unknown, mode: unknown) => {
  if (typeof chatId === 'string' && typeof messageId === 'string' && (mode === 'undo' || mode === 'go-back')) client.undoTurn(chatId, messageId, mode);
});
ipcMain.handle(Channel.chatToTask, (_event, chatId: unknown) => chatToTask(chatId));
ipcMain.handle(Channel.handOff, (_event, request: HandoffRequest) => {
  if (!request || typeof request.agentId !== 'string') return { ok: false, error: 'Pick an agent to hand off to.' };
  return handOff(request);
});
// Every live text edit is counted, applied or not, and the window hears about it.
const isTextEdit = (op: unknown) => (op as { op?: unknown } | null)?.op === 'text' && typeof (op as { base?: unknown }).base === 'string';
ipcMain.on(Channel.editPlanning, (_event, op: unknown) => {
  if (isTextEdit(op)) textEdits++;
  const parsed = PlanOp.safeParse(op);
  if (parsed.success) client.editPlanning(parsed.data);
  pushState();
});
ipcMain.handle(Channel.approvePlan, (_event, approval: unknown) => approvePlan(approval));
ipcMain.on(Channel.editMemory, (_event, op: unknown) => {
  if (isTextEdit(op)) textEdits++;
  const parsed = MemoryOp.safeParse(op);
  if (parsed.success) client.editMemory(parsed.data);
  pushState();
});
ipcMain.handle(Channel.exportMemory, () => exportMemory());
ipcMain.on(Channel.setMemoryAutoExport, (_event, on: unknown) => setMemoryAutoExport(on));
ipcMain.on(Channel.setNoticeMuted, (_event, kind: unknown, muted: unknown) => {
  notifier.setMuted(kind, muted);
  pushState();
});
ipcMain.on(Channel.testNotice, () => notifier.test());
ipcMain.on(Channel.verifyCriterion, (_event, taskId: unknown, criterionId: unknown, state: unknown, evidence: unknown) => {
  const parsed = TaskVerifyMessage.safeParse({ type: 'task.verify', taskId, criterionId, state, evidence });
  if (parsed.success) client.verifyCriterion(parsed.data.taskId, parsed.data.criterionId, parsed.data.state, parsed.data.evidence);
});
ipcMain.handle(Channel.runBloatCheck, () => bloatCheck());
ipcMain.handle(Channel.scanFolderNotes, (_event, fresh: unknown) => scanNotes(fresh));
ipcMain.handle(Channel.folderNoteTask, (_event, folder: unknown) => folderNoteTask(folder));
ipcMain.handle(Channel.folderNotePaths, () => folderNotePaths());
ipcMain.on(Channel.copyText, (_event, text: unknown) => {
  if (typeof text === 'string') clipboard.writeText(text);
});
const updateInfo = () => ({ version: app.getVersion(), protocol: PROTOCOL_VERSION, database: SCHEMA_VERSION, state: getUpdateState() });
ipcMain.handle(Channel.getUpdate, () => updateInfo());
// Hosting stops cleanly before the restart, so the friend sees the host leave.
ipcMain.handle(Channel.update, () => applyUpdate(leave));

// A second launch (say, from the Start menu) focuses this window instead of
// starting another copy that would fight over the session port.
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();
function focusWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
app.on('second-instance', focusWindow);
// Windows shows notifications under this id; it matches the installer's appId.
app.setAppUserModelId('com.lossa551.projectcollaborationtool');

void app.whenReady().then(() => {
  if (!firstInstance) return;
  // The session hosted before this list existed shows up to resume.
  legacyAdopted = sessions().adoptLegacyHost(async (file) => {
    const storage = new SqliteStorage(file);
    try {
      return await storage.loadSession();
    } finally {
      await storage.close();
    }
  });
  createWindow();
  void findCliTools().then((found) => {
    cliTools = found;
    pushState();
  });
  void findGodotOnPath().then(pushState);
  engineWatch.start();
  startUpdater(
    () => window?.webContents.send(Channel.updateState, updateInfo()),
    (version) => {
      const notice = new Notification({
        title: 'Update ready',
        body: `Version ${version} is downloaded. Click Restart to update in the app when it suits you.`,
      });
      notice.on('click', focusWindow);
      notice.show();
    },
  );
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  void leave().finally(() => app.quit());
});

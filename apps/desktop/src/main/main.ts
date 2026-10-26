import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, shell, type MessageBoxOptions, type OpenDialogOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AgentSaveMessage,
  ChatTitle,
  Handoff,
  LockAcquireMessage,
  LockRules,
  MemoryOp,
  PlanApproval,
  PlanOp,
  PresenceStatus,
  SOCKET_PATH,
  SessionClient,
  TaskStage,
  TaskUpdateMessage,
  TaskVerifyMessage,
  decodeInvite,
  encodeInvite,
  parseRepoRef,
  renderHandoff,
  type CliTool,
} from '@pct/shared';
import { SqliteStorage, findShareableAddress, startServer, tokenFromGitHubCli, type RunningServer } from '@pct/server';
import {
  Channel,
  type AppState,
  type GitAction,
  type HandoffRequest,
  type HostRequest,
  type HostingInfo,
  type JoinRequest,
  type LocalWorkspace,
  type ResumeRequest,
  type Result,
  type ResultWith,
  type SavedSessionInfo,
} from '../common/api';
import { LocalAgents, apiKeyStatus, createSocket, findCliTools } from './agents';
import { runBloatCheck } from './bloat';
import { loadSnapshot, saveSnapshot } from './cache';
import { loadIdentity } from './identity';
import { SessionHistory } from './sessions';
import { loadGitHubToken, saveApiKey, saveGitHubToken, saveWorkspaceFolder, workspaceFolder } from './settings';
import { applyUpdate, getUpdateState, startUpdater } from './updater';
import { GitError, clone, repositoryRoot, runGitAction, trustFolder } from './git';
import { WorkspaceWatcher } from './workspace';
import { scanFolderNotes } from './folder-notes';
import type { FolderNotesReport } from '../common/folder-notes';

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
});
const pushState = () => window?.webContents.send(Channel.state, appState());
const localAgents = new LocalAgents(pushState);
client.subscribe(pushState);

// Your workspace: the project folder you picked for this session. Its branch
// and changed files go to the session whenever they change.
let watcher: WorkspaceWatcher | null = null;
let watchedSession: string | null = null;
let knownDefaultBranch: string | null = null;

function watchFolder(folder: string | null) {
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
const messageBox = (options: MessageBoxOptions) => (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));

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
    const picked = await openDialog({ title: 'Choose your project folder (where you cloned the project)', properties: ['openDirectory'] });
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
      const { response } = await messageBox({
        type: 'question',
        message: 'This folder is not a git repository',
        detail: repo
          ? `Your project folder must be a clone of the repository. The app can clone ${repo.owner}/${repo.name} from GitHub into ${target} and use that.`
          : 'Your project folder must be a git clone of the project. Pick the folder you cloned it into, or link the GitHub repository on the GitHub page and the app can clone it for you.',
        buttons: repo ? [`Clone ${repo.owner}/${repo.name}`, 'Choose another folder', 'Cancel'] : ['Choose another folder', 'Cancel'],
        defaultId: 0,
        cancelId: repo ? 2 : 1,
      });
      if (repo && response === 0) return cloneInto(folder);
      if (response === (repo ? 2 : 1)) return { ok: true };
    }
  }
}

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
    return { ok: true, value: await runGitAction(folder, action, await gitToken()) };
  } catch (error) {
    return failure(error);
  } finally {
    gitBusy = false;
    void watcher?.poll();
  }
}

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
app.on('before-quit', flushCache);

const failure = (error: unknown): { ok: false; error: string } => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
});

async function stopHosting() {
  // Agents started here belong to the session being left.
  await localAgents.stopAll();
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
    root: workspace.folder,
  });
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
      .then((report) => (folderNotes = { key, report }))
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

function folderNoteTask(folder: unknown): ResultWith<string> {
  const info = folderNotes?.report.folders.find((f) => f.path === folder);
  if (!info) return { ok: false, error: 'Scan the folder notes again first.' };
  const label = info.path === '' ? 'top folder' : `${info.path}/`;
  const notePath = info.notePath ?? (info.path ? `${info.path}/AGENTS.md` : 'AGENTS.md');
  const title = info.notePath ? `Update folder note for ${label}` : `Write folder note for ${label}`;
  return { ok: true, value: client.createTask(title.slice(0, 200), { stage: 'planning', scope: [notePath] }) };
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

  window.on('closed', () => {
    window = null;
  });
}

ipcMain.handle(Channel.getState, () => appState());
ipcMain.handle(Channel.host, (_event, request: HostRequest) => host(request));
ipcMain.handle(Channel.join, (_event, request: JoinRequest) => joinSession(request));
ipcMain.handle(Channel.leave, () => leave());
ipcMain.handle(Channel.listSessions, () => listSessions());
ipcMain.handle(Channel.resume, (_event, request: ResumeRequest) => {
  if (!request || typeof request.key !== 'string' || typeof request.name !== 'string') return { ok: false, error: 'Pick a session.' };
  return resume(request);
});
ipcMain.handle(Channel.forgetSession, (_event, key: unknown) => forgetSession(key));
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
ipcMain.on(Channel.setLockRules, (_event, rules: unknown) => {
  const parsed = LockRules.safeParse(rules);
  if (parsed.success) client.setLockRules(parsed.data);
});
ipcMain.handle(Channel.chooseWorkspace, () => chooseWorkspace());
ipcMain.on(Channel.stopWorkspace, () => stopWorkspace());
ipcMain.handle(Channel.cloneRepo, () => cloneRepo());
ipcMain.handle(Channel.gitAction, (_event, action: unknown) => gitAction(action));
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
ipcMain.on(Channel.updateChat, (_event, chatId: unknown, changes: { title?: unknown; taskId?: unknown }) => {
  if (typeof chatId !== 'string' || !changes) return;
  const title = changes.title === undefined ? undefined : ChatTitle.safeParse(changes.title);
  if (title && !title.success) return;
  const taskId = changes.taskId === undefined ? undefined : typeof changes.taskId === 'string' ? changes.taskId : null;
  client.updateChat(chatId, { ...(title && { title: title.data }), ...(taskId !== undefined && { taskId }) });
});
ipcMain.on(Channel.deleteChat, (_event, chatId: unknown) => {
  if (typeof chatId === 'string') client.deleteChat(chatId);
});
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
ipcMain.on(Channel.verifyCriterion, (_event, taskId: unknown, criterionId: unknown, state: unknown, evidence: unknown) => {
  const parsed = TaskVerifyMessage.safeParse({ type: 'task.verify', taskId, criterionId, state, evidence });
  if (parsed.success) client.verifyCriterion(parsed.data.taskId, parsed.data.criterionId, parsed.data.state, parsed.data.evidence);
});
ipcMain.handle(Channel.runBloatCheck, () => bloatCheck());
ipcMain.handle(Channel.scanFolderNotes, (_event, fresh: unknown) => scanNotes(fresh));
ipcMain.handle(Channel.folderNoteTask, (_event, folder: unknown) => folderNoteTask(folder));
ipcMain.on(Channel.copyText, (_event, text: unknown) => {
  if (typeof text === 'string') clipboard.writeText(text);
});
const updateInfo = () => ({ version: app.getVersion(), state: getUpdateState() });
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

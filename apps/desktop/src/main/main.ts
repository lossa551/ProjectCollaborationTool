import { app, BrowserWindow, clipboard, ipcMain, Notification, shell } from 'electron';
import { join } from 'node:path';
import WS from 'ws';
import {
  LockAcquireMessage,
  LockRules,
  PresenceStatus,
  SOCKET_PATH,
  SessionClient,
  TaskStage,
  TaskUpdateMessage,
  decodeInvite,
  encodeInvite,
} from '@pct/shared';
import { SqliteStorage, findShareableAddress, startServer, type RunningServer } from '@pct/server';
import { Channel, type AppState, type HostRequest, type HostingInfo, type JoinRequest, type Result } from '../common/api';
import { loadSnapshot, saveSnapshot } from './cache';
import { hostedSessionPath, loadIdentity } from './identity';
import { applyUpdate, getUpdateState, startUpdater } from './updater';

// The main process owns the session connection (and, when hosting, the
// session server itself) so it survives window reloads. Later it will also run
// local agents and the offline cache.

const DEFAULT_PORT = 7420;

const client = new SessionClient({
  // Node 22 has a global WebSocket; ws is the fallback with the same API.
  createSocket: (url) =>
    globalThis.WebSocket ? new WebSocket(url) : (new WS(url) as unknown as WebSocket),
});
let hosted: RunningServer | null = null;
let hosting: HostingInfo | null = null;
let window: BrowserWindow | null = null;

const appState = (): AppState => ({ session: client.getState(), hosting, canEditTasks: client.canEditTasks() });
const pushState = () => window?.webContents.send(Channel.state, appState());
client.subscribe(pushState);

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

const failure = (error: unknown): Result => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
});

async function stopHosting() {
  const server = hosted;
  hosted = null;
  hosting = null;
  await server?.close();
}

async function host({ name, sessionName }: HostRequest): Promise<Result> {
  try {
    flushCache();
    cachedUrl = null;
    client.disconnect();
    await stopHosting();
    // The hosted session is saved on this PC: the board, locks and invite code
    // are still there the next time you host.
    const storage = new SqliteStorage(hostedSessionPath());
    const options = { sessionName: sessionName || undefined, storage, log: console.log };
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
    const shareable = findShareableAddress();
    const url = `ws://${shareable.address}:${hosted.port}${SOCKET_PATH}`;
    hosting = {
      invite: encodeInvite({ url, secret: hosted.secret, sessionName: hosted.session.name }),
      address: shareable.address,
      addressSource: shareable.source,
      port: hosted.port,
    };
    client.connect({ url: hosted.localUrl, secret: hosted.secret, name, identity: loadIdentity() });
    return { ok: true };
  } catch (error) {
    await stopHosting();
    return failure(error);
  }
}

async function joinSession({ name, invite }: JoinRequest): Promise<Result> {
  const decoded = decodeInvite(invite);
  if (!decoded) return { ok: false, error: 'That is not a valid invite code.' };
  await stopHosting();
  flushCache();
  cachedUrl = decoded.url;
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
  createWindow();
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

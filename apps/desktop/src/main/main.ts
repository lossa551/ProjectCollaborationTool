import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import WS from 'ws';
import { PresenceStatus, SOCKET_PATH, SessionClient, decodeInvite, encodeInvite } from '@pct/shared';
import { findShareableAddress, startServer, type RunningServer } from '@pct/server';
import { Channel, type AppState, type HostRequest, type HostingInfo, type JoinRequest, type Result } from '../common/api';

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

const appState = (): AppState => ({ session: client.getState(), hosting });
const pushState = () => window?.webContents.send(Channel.state, appState());
client.subscribe(pushState);

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
    client.disconnect();
    await stopHosting();
    const options = { sessionName: sessionName || 'New session', log: console.log };
    try {
      hosted = await startServer({ ...options, port: DEFAULT_PORT });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      hosted = await startServer({ ...options, port: 0 });
    }
    const shareable = findShareableAddress();
    const url = `ws://${shareable.address}:${hosted.port}${SOCKET_PATH}`;
    hosting = {
      invite: encodeInvite({ url, secret: hosted.secret, sessionName: hosted.session.name }),
      address: shareable.address,
      addressSource: shareable.source,
      port: hosted.port,
    };
    client.connect({ url: hosted.localUrl, secret: hosted.secret, name });
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
  client.connect({ url: decoded.url, secret: decoded.secret, name });
  return { ok: true };
}

async function leave() {
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
ipcMain.on(Channel.copyText, (_event, text: unknown) => {
  if (typeof text === 'string') clipboard.writeText(text);
});

void app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  void leave().finally(() => app.quit());
});

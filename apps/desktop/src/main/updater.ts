import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateState } from '../common/api';

// Keeps the installed app current from GitHub Releases, which get a new
// version on every push to main. New versions download in the background; the
// Update button restarts into them. Builds run from a clone (npm run desktop)
// are not installed, so they cannot update this way.

const CHECK_EVERY_MS = 15 * 60 * 1000;

let state: UpdateState = app.isPackaged
  ? { status: 'idle' }
  : { status: 'unavailable', message: 'Updates work in the installed app. From a clone, use git pull.' };
let listener: (state: UpdateState) => void = () => {};

const set = (next: UpdateState) => {
  state = next;
  listener(state);
};

export const getUpdateState = () => state;

export function startUpdater(onChange: (state: UpdateState) => void, onReady: (version: string) => void) {
  listener = onChange;
  if (!app.isPackaged) return;

  // A beta build (from a PR, version 0.x.0-beta.N) does not replace itself on
  // its own: it only goes back to the released version when you press Update.
  const beta = app.getVersion().includes('-');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = !beta;
  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ status: 'up-to-date' }));
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (progress) => {
    if (state.status === 'downloading') set({ ...state, percent: Math.round(progress.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    set({ status: 'ready', version: info.version });
    onReady(info.version);
  });
  autoUpdater.on('error', (error) => {
    // Before the first release is published there is nothing to update to.
    if (/404|no published versions/i.test(error.message)) set({ status: 'up-to-date' });
    else set({ status: 'error', message: error.message });
  });

  if (beta) return;
  void checkForUpdate();
  setInterval(() => void checkForUpdate(), CHECK_EVERY_MS).unref();
}

export async function checkForUpdate() {
  if (!app.isPackaged || state.status === 'checking' || state.status === 'downloading') return;
  // Failures also arrive through the 'error' event, which sets the state.
  await autoUpdater.checkForUpdates().catch(() => undefined);
}

/** Restarts into the downloaded version, or checks again if there is none yet. */
export async function applyUpdate(beforeRestart: () => Promise<void>) {
  if (state.status !== 'ready') return checkForUpdate();
  await beforeRestart();
  autoUpdater.quitAndInstall(true, true);
}

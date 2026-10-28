import { app, net } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateChannel, UpdateState } from '../common/api';
import { saveUpdateChannel, updateChannel } from './settings';
import { buildKind, newestRelease, type ReleaseEntry } from './update-channel';

// Keeps the installed app current from GitHub Releases, which get a new
// version on every push to main, and a beta prerelease on every push to beta.
// New versions download in the background; the Update button restarts into
// them. Builds run from a clone (npm run desktop) are not installed, so they
// cannot update this way.

const CHECK_EVERY_MS = 15 * 60 * 1000;
// Where electron-builder.yml publishes.
const OWNER = 'lossa551';
const REPO = 'ProjectCollaborationTool';

let state: UpdateState = app.isPackaged
  ? { status: 'idle' }
  : { status: 'unavailable', message: 'Updates work in the installed app. From a clone, use git pull.' };
let listener: (state: UpdateState) => void = () => {};

const set = (next: UpdateState) => {
  state = next;
  listener(state);
};

export const getUpdateState = () => state;

// A test installer from CI (0.x.0-ci.N) does not replace itself on its own: it
// only moves to the channel's newest version when you press Update.
const testBuild = () => buildKind(app.getVersion()) === 'test';

export function startUpdater(onChange: (state: UpdateState) => void, onReady: (version: string) => void) {
  listener = onChange;
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = !testBuild();
  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ status: 'up-to-date' }));
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (progress) => {
    if (state.status === 'downloading') set({ ...state, percent: Math.round(progress.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    autoUpdater.autoInstallOnAppQuit = !testBuild();
    set({ status: 'ready', version: info.version });
    onReady(info.version);
  });
  autoUpdater.on('error', (error) => {
    // Before the first release is published there is nothing to update to.
    if (/404|no published versions/i.test(error.message)) set({ status: 'up-to-date' });
    else set({ status: 'error', message: error.message });
  });

  if (testBuild()) return;
  void checkForUpdate();
  setInterval(() => void checkForUpdate(), CHECK_EVERY_MS).unref();
}

/**
 * Points the updater at the channel's newest version. Stable follows GitHub's
 * latest release, which only main publishes. Beta reads the release list and
 * takes the highest version, beta or stable, since GitHub's own feed would
 * only offer whichever was published last. False when there is none yet.
 */
async function pointAtChannel(): Promise<boolean> {
  if (updateChannel(app.getVersion()) === 'stable') {
    autoUpdater.allowPrerelease = false;
    // Leaving beta goes back down to the stable release.
    autoUpdater.allowDowngrade = buildKind(app.getVersion()) !== 'release';
    autoUpdater.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO });
    return true;
  }
  const response = await net.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=30`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} when looking for beta releases.`);
  const tag = newestRelease((await response.json()) as ReleaseEntry[]);
  if (!tag) return false;
  autoUpdater.allowPrerelease = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.setFeedURL({ provider: 'generic', url: `https://github.com/${OWNER}/${REPO}/releases/download/${tag}` });
  return true;
}

export async function checkForUpdate() {
  if (!app.isPackaged || state.status === 'checking' || state.status === 'downloading') return;
  try {
    if (!(await pointAtChannel())) return set({ status: 'up-to-date' });
  } catch (error) {
    return set({ status: 'error', message: error instanceof Error ? error.message : String(error) });
  }
  // Failures also arrive through the 'error' event, which sets the state.
  await autoUpdater.checkForUpdates().catch(() => undefined);
}

export const getUpdateChannel = () => updateChannel(app.getVersion());

/** Follows stable or beta from now on, and looks for that channel's newest version. */
export async function setUpdateChannel(channel: UpdateChannel) {
  if (channel === getUpdateChannel()) return;
  saveUpdateChannel(channel);
  // A version already downloaded from the other channel is not installed on quit.
  autoUpdater.autoInstallOnAppQuit = false;
  if (state.status === 'ready' || state.status === 'up-to-date' || state.status === 'error') set({ status: 'idle' });
  else listener(state);
  await checkForUpdate();
}

/** Restarts into the downloaded version, or checks again if there is none yet. */
export async function applyUpdate(beforeRestart: () => Promise<void>) {
  if (state.status !== 'ready') return checkForUpdate();
  await beforeRestart();
  autoUpdater.quitAndInstall(true, true);
}

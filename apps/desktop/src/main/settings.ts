import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Small settings kept on this PC: which project folder is your workspace in
// each session, and the GitHub token the hosted server uses.

const workspacesPath = () => join(app.getPath('userData'), 'workspaces.json');
const tokenPath = () => join(app.getPath('userData'), 'github-token.bin');

function writeAtomic(path: string, data: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, data, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

function readFolders(): Record<string, string> {
  try {
    const data: unknown = JSON.parse(readFileSync(workspacesPath(), 'utf8'));
    if (!data || typeof data !== 'object') return {};
    return Object.fromEntries(Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

/** Your project folder for a session, by session id. */
export function workspaceFolder(sessionId: string): string | null {
  return readFolders()[sessionId] ?? null;
}

export function saveWorkspaceFolder(sessionId: string, folder: string | null) {
  const folders = readFolders();
  if (folder) folders[sessionId] = folder;
  else delete folders[sessionId];
  writeAtomic(workspacesPath(), JSON.stringify(folders, null, 2));
}

/** The saved GitHub token, decrypted with the operating system's key store. */
export function loadGitHubToken(): string | null {
  if (!existsSync(tokenPath()) || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(readFileSync(tokenPath())) || null;
  } catch {
    return null;
  }
}

export function saveGitHubToken(token: string | null) {
  if (!token) {
    rmSync(tokenPath(), { force: true });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('This PC cannot store the token securely.');
  writeAtomic(tokenPath(), safeStorage.encryptString(token));
}

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

// API keys for agents, by key name (see apiKeyName). Encrypted with the
// operating system's key store; they never leave this PC.

const apiKeysPath = () => join(app.getPath('userData'), 'api-keys.bin');

function readApiKeys(): Record<string, string> {
  if (!existsSync(apiKeysPath()) || !safeStorage.isEncryptionAvailable()) return {};
  try {
    const data: unknown = JSON.parse(safeStorage.decryptString(readFileSync(apiKeysPath())));
    if (!data || typeof data !== 'object') return {};
    return Object.fromEntries(Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

export function loadApiKey(name: string): string | null {
  return readApiKeys()[name] ?? null;
}

/** Names of the keys saved on this PC. */
export function savedApiKeyNames(): string[] {
  return Object.keys(readApiKeys());
}

export function saveApiKey(name: string, key: string | null) {
  const keys = readApiKeys();
  if (key) keys[name] = key;
  else delete keys[name];
  if (Object.keys(keys).length === 0) {
    rmSync(apiKeysPath(), { force: true });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('This PC cannot store the key securely.');
  writeAtomic(apiKeysPath(), safeStorage.encryptString(JSON.stringify(keys)));
}

// Each agent started on this PC has its own identity, so it is the same
// participant (with the same locks and tasks) every time it runs here.

const agentIdentitiesPath = () => join(app.getPath('userData'), 'agent-identities.json');

export function agentIdentity(profileId: string, make: () => string): string {
  let identities: Record<string, string> = {};
  try {
    const data: unknown = JSON.parse(readFileSync(agentIdentitiesPath(), 'utf8'));
    if (data && typeof data === 'object') identities = data as Record<string, string>;
  } catch {
    // None yet.
  }
  const known = identities[profileId];
  if (typeof known === 'string' && known.length >= 16) return known;
  identities[profileId] = make();
  writeAtomic(agentIdentitiesPath(), JSON.stringify(identities, null, 2));
  return identities[profileId]!;
}

// Where backups of hosted sessions go, and which sessions keep project memory
// written to the project folder.

interface Preferences {
  backupFolder?: string;
  /** Session ids whose memory file is rewritten when an entry changes. */
  memoryExport?: string[];
  /** Kinds of Windows notifications turned off; see NOTICE_KINDS. */
  mutedNotices?: string[];
}

const preferencesPath = () => join(app.getPath('userData'), 'preferences.json');

function readPreferences(): Preferences {
  try {
    const data: unknown = JSON.parse(readFileSync(preferencesPath(), 'utf8'));
    if (!data || typeof data !== 'object') return {};
    const prefs = data as Record<string, unknown>;
    return {
      ...(typeof prefs.backupFolder === 'string' && { backupFolder: prefs.backupFolder }),
      ...(Array.isArray(prefs.memoryExport) && { memoryExport: prefs.memoryExport.filter((id): id is string => typeof id === 'string') }),
      ...(Array.isArray(prefs.mutedNotices) && { mutedNotices: prefs.mutedNotices.filter((k): k is string => typeof k === 'string') }),
    };
  } catch {
    return {};
  }
}

function savePreferences(changes: Partial<Preferences>) {
  const next = { ...readPreferences(), ...changes };
  writeAtomic(preferencesPath(), JSON.stringify(next, null, 2));
}

export const defaultBackupFolder = () => join(app.getPath('userData'), 'backups');

/** The folder you chose for backups; null for the default. */
export function customBackupFolder(): string | null {
  return readPreferences().backupFolder ?? null;
}

export function saveBackupFolder(folder: string | null) {
  savePreferences({ backupFolder: folder ?? undefined });
}

export function memoryAutoExport(sessionId: string): boolean {
  return readPreferences().memoryExport?.includes(sessionId) ?? false;
}

export function saveMemoryAutoExport(sessionId: string, on: boolean) {
  const ids = (readPreferences().memoryExport ?? []).filter((id) => id !== sessionId);
  savePreferences({ memoryExport: on ? [...ids, sessionId] : ids });
}

export function mutedNotices(): string[] {
  return readPreferences().mutedNotices ?? [];
}

export function saveMutedNotice(kind: string, muted: boolean) {
  const kinds = mutedNotices().filter((k) => k !== kind);
  savePreferences({ mutedNotices: muted ? [...kinds, kind] : kinds });
}

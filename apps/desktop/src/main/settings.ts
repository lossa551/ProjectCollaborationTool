import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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

/** The other sessions whose project folder on this PC is this one. */
export function sessionsUsingFolder(folder: string, exceptSessionId: string): string[] {
  const same = samePath(folder);
  return Object.entries(readFolders())
    .filter(([id, saved]) => id !== exceptSessionId && same(saved))
    .map(([id]) => id);
}

const samePath = (a: string) => {
  // Windows paths ignore case.
  const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  const target = norm(a);
  return (b: string) => norm(b) === target;
};

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
  /** The "still running in the tray" toast was shown once (issue #60). */
  trayNoticeShown?: boolean;
  /** By session id: the agent that keeps folder notes up to date (project setup). */
  notesAgents?: Record<string, string>;
  /** Which engine MCP server agents on this PC use (issue #10). */
  engineBridge?: string;
  /** The Godot (or Summer Engine) executable, for tests and the Godot MCP server. */
  godotPath?: string;
  /** The Godot program last seen running as an editor, used when none is chosen. */
  foundGodotPath?: string;
  /** By session id: the agents that do not get the engine's tools (all others do). */
  engineAgentsOff?: Record<string, string[]>;
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
      ...(prefs.trayNoticeShown === true && { trayNoticeShown: true }),
      ...(prefs.notesAgents !== null &&
        typeof prefs.notesAgents === 'object' && {
          notesAgents: Object.fromEntries(Object.entries(prefs.notesAgents).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        }),
      ...(typeof prefs.engineBridge === 'string' && { engineBridge: prefs.engineBridge }),
      ...(typeof prefs.godotPath === 'string' && { godotPath: prefs.godotPath }),
      ...(typeof prefs.foundGodotPath === 'string' && { foundGodotPath: prefs.foundGodotPath }),
      ...(prefs.engineAgentsOff !== null &&
        typeof prefs.engineAgentsOff === 'object' && {
          engineAgentsOff: Object.fromEntries(
            Object.entries(prefs.engineAgentsOff)
              .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
              .map(([id, agents]) => [id, agents.filter((a): a is string => typeof a === 'string')]),
          ),
        }),
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

/** True the first time the app goes to the tray, false after. */
export function firstTimeInTray(): boolean {
  if (readPreferences().trayNoticeShown) return false;
  savePreferences({ trayNoticeShown: true });
  return true;
}

export function mutedNotices(): string[] {
  return readPreferences().mutedNotices ?? [];
}

export function saveMutedNotice(kind: string, muted: boolean) {
  const kinds = mutedNotices().filter((k) => k !== kind);
  savePreferences({ mutedNotices: muted ? [...kinds, kind] : kinds });
}

/** The agent that drafts folder note updates on its own in this session; null when that is off. */
export function notesAgent(sessionId: string): string | null {
  return readPreferences().notesAgents?.[sessionId] ?? null;
}

export function saveNotesAgent(sessionId: string, agentId: string | null) {
  const agents = { ...readPreferences().notesAgents };
  if (agentId) agents[sessionId] = agentId;
  else delete agents[sessionId];
  savePreferences({ notesAgents: agents });
}

/** The engine MCP server agents on this PC use: auto (the default), off, godot or summer. */
export function engineBridge(): string {
  return readPreferences().engineBridge ?? 'auto';
}

export function saveEngineBridge(bridge: string) {
  savePreferences({ engineBridge: bridge });
}

/** The Godot executable you chose; null to look for it. */
export function savedGodotPath(): string | null {
  return readPreferences().godotPath ?? null;
}

export function saveGodotPath(path: string | null) {
  savePreferences({ godotPath: path ?? undefined });
}

export function foundGodotPath(): string | null {
  return readPreferences().foundGodotPath ?? null;
}

export function saveFoundGodotPath(path: string) {
  if (foundGodotPath() !== path) savePreferences({ foundGodotPath: path });
}

/** The agents of a session that you took the engine's tools away from on this PC. */
export function engineAgentsOff(sessionId: string): string[] {
  return readPreferences().engineAgentsOff?.[sessionId] ?? [];
}

export function saveEngineAgent(sessionId: string, agentId: string, on: boolean) {
  const all = { ...readPreferences().engineAgentsOff };
  const off = (all[sessionId] ?? []).filter((id) => id !== agentId);
  all[sessionId] = on ? off : [...off, agentId];
  savePreferences({ engineAgentsOff: all });
}

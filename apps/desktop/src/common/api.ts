import type { LockRules, SessionState, TaskChanges, TaskStage } from '@pct/shared';

// The bridge between the window (renderer) and the main process, exposed by
// the preload script as window.pct.

export interface HostingInfo {
  invite: string;
  /** Address put in the invite and where it came from. */
  address: string;
  addressSource: 'tailscale' | 'lan' | 'loopback';
  port: number;
}

export interface AppState {
  session: SessionState;
  hosting: HostingInfo | null;
  /** Tasks can be changed: connected, or offline in a session we know (changes sync later). */
  canEditTasks: boolean;
}

export interface HostRequest {
  name: string;
  sessionName: string;
}

export interface JoinRequest {
  name: string;
  invite: string;
}

export type Result = { ok: true } | { ok: false; error: string };

/** Where the installed app is in updating itself from GitHub Releases. */
export type UpdateState =
  | { status: 'unavailable'; message: string }
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'up-to-date' }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string };

export interface UpdateInfo {
  /** The version running now. */
  version: string;
  state: UpdateState;
}

export interface PctApi {
  getState(): Promise<AppState>;
  host(request: HostRequest): Promise<Result>;
  join(request: JoinRequest): Promise<Result>;
  leave(): Promise<void>;
  setPresence(status: 'active' | 'idle' | 'away', focus: string | null): void;
  createTask(title: string, stage: TaskStage): void;
  updateTask(taskId: string, changes: TaskChanges): void;
  deleteTask(taskId: string): void;
  acquireLock(path: string, options: { taskId: string | null; exclusive: boolean }): void;
  releaseLock(lockId: string): void;
  recoverLock(lockId: string): void;
  setLockRules(rules: LockRules): void;
  copyText(text: string): void;
  onState(listener: (state: AppState) => void): () => void;
  getUpdate(): Promise<UpdateInfo>;
  /** Restarts into a downloaded update, or checks for one. */
  update(): Promise<void>;
  onUpdate(listener: (info: UpdateInfo) => void): () => void;
}

export const Channel = {
  getState: 'pct:get-state',
  host: 'pct:host',
  join: 'pct:join',
  leave: 'pct:leave',
  setPresence: 'pct:set-presence',
  createTask: 'pct:create-task',
  updateTask: 'pct:update-task',
  deleteTask: 'pct:delete-task',
  acquireLock: 'pct:acquire-lock',
  releaseLock: 'pct:release-lock',
  recoverLock: 'pct:recover-lock',
  setLockRules: 'pct:set-lock-rules',
  copyText: 'pct:copy-text',
  state: 'pct:state',
  getUpdate: 'pct:get-update',
  update: 'pct:update',
  updateState: 'pct:update-state',
} as const;

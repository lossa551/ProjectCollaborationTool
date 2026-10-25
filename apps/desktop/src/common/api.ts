import type { SessionState } from '@pct/shared';

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

export interface PctApi {
  getState(): Promise<AppState>;
  host(request: HostRequest): Promise<Result>;
  join(request: JoinRequest): Promise<Result>;
  leave(): Promise<void>;
  setPresence(status: 'active' | 'idle' | 'away', focus: string | null): void;
  copyText(text: string): void;
  onState(listener: (state: AppState) => void): () => void;
}

export const Channel = {
  getState: 'pct:get-state',
  host: 'pct:host',
  join: 'pct:join',
  leave: 'pct:leave',
  setPresence: 'pct:set-presence',
  copyText: 'pct:copy-text',
  state: 'pct:state',
} as const;

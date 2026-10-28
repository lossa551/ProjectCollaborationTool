import { execFile } from 'node:child_process';
import { join, sep } from 'node:path';
import WS from 'ws';
import {
  API_KEY_ENV,
  ApiProvider,
  CLI_TOOLS,
  SessionClient,
  newIdentity,
  type AgentProfile,
  type CliTool,
  type DraftKind,
} from '@pct/shared';
import { AgentRunner, createModel, type EngineSettings } from '@pct/agents';
import type { LocalAgent } from '../common/api';
import { agentIdentity, loadApiKey, savedApiKeyNames } from './settings';

// Agents started on this PC. Each one joins the session as its own
// participant; each of its chats works in its own copy of your project folder
// (a git worktree next to it, see @pct/agents worktree.ts). Its API key is
// read here and never sent anywhere but to its model's API.

export const createSocket = (url: string) =>
  globalThis.WebSocket ? new WebSocket(url) : (new WS(url) as unknown as WebSocket);

interface Running {
  client: SessionClient;
  runner: AgentRunner;
  state: LocalAgent;
}

export interface StartRequest {
  profileId: string;
  name: string;
  url: string;
  secret: string;
  startedBy: string;
  /** Participant id of the person starting it, who owns its chats' copies. */
  startedById: string;
  root: string;
  /** The game engine for an agent of this session, read at each turn. */
  engine?: (agent: AgentProfile) => EngineSettings | null;
}

/** A key saved in the app, else the provider's usual environment variable. */
export function apiKey(name: string): string | null {
  const saved = loadApiKey(name);
  if (saved) return saved;
  const provider = ApiProvider.safeParse(name);
  const env = provider.success ? API_KEY_ENV[provider.data] : undefined;
  return (env && process.env[env]) || null;
}

export function apiKeyStatus(): Record<string, 'saved' | 'env'> {
  const status: Record<string, 'saved' | 'env'> = {};
  for (const provider of ApiProvider.options) {
    const env = API_KEY_ENV[provider];
    if (env && process.env[env]) status[provider] = 'env';
  }
  for (const name of savedApiKeyNames()) status[name] = 'saved';
  return status;
}

/** Which command-line agents are installed (on the PATH). */
export function findCliTools(): Promise<Record<CliTool, boolean>> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const check = (command: string) =>
    new Promise<boolean>((resolve) => execFile(finder, [command], { windowsHide: true }, (error) => resolve(!error)));
  return Promise.all(
    (Object.keys(CLI_TOOLS) as CliTool[]).map(async (tool) => [tool, await check(CLI_TOOLS[tool].command)] as const),
  ).then((entries) => Object.fromEntries(entries) as Record<CliTool, boolean>);
}

/** The hook script ships unpacked next to main.cjs, so Electron-as-node can run it. */
function hookScript(): string {
  return join(__dirname, 'pct-hook.cjs').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}

export class LocalAgents {
  private readonly running = new Map<string, Running>();

  constructor(private readonly onChange: () => void) {}

  list(): Record<string, LocalAgent> {
    return Object.fromEntries([...this.running].map(([id, r]) => [id, r.state]));
  }

  isRunning(profileId: string): boolean {
    return this.running.has(profileId);
  }

  start(request: StartRequest): void {
    const existing = this.running.get(request.profileId);
    if (existing && existing.state.status !== 'error') return;
    this.running.delete(request.profileId);
    const client = new SessionClient({ createSocket });
    const runner = new AgentRunner({
      client,
      profileId: request.profileId,
      startedBy: request.startedBy,
      startedById: request.startedById,
      root: request.root,
      createModel: (agent) => createModel(agent, apiKey),
      engine: request.engine,
      cli: {
        hookScript: hookScript(),
        // Electron's own binary runs the hook as plain Node.
        nodePath: process.execPath,
        hookEnv: { ELECTRON_RUN_AS_NODE: '1' },
      },
      log: (line) => console.log(line),
    });
    const entry: Running = { client, runner, state: { status: 'starting', error: null, folder: request.root } };
    this.running.set(request.profileId, entry);
    client.subscribe((state) => {
      const next: LocalAgent['status'] =
        state.status === 'connected' ? 'running' : state.status === 'closed' ? 'error' : 'starting';
      const error = state.status === 'closed' ? (state.error?.message ?? 'Disconnected') : null;
      if (next === entry.state.status && error === entry.state.error) return;
      entry.state = { ...entry.state, status: next, error };
      // Turned away for good (already running elsewhere, or removed): stop here.
      if (state.status === 'closed') void this.stop(request.profileId, false);
      this.onChange();
    });
    runner.start();
    client.connect({
      url: request.url,
      secret: request.secret,
      name: request.name,
      kind: 'agent',
      identity: agentIdentity(request.profileId, newIdentity),
      agent: { profileId: request.profileId, startedBy: request.startedBy, startedById: request.startedById },
    });
    this.onChange();
  }

  /** Has a running agent answer one prompt (a commit message or folder note draft), once it is connected. */
  async draft(profileId: string, prompt: string, taskId: string | null, signal: AbortSignal, kind?: DraftKind): Promise<string> {
    const entry = this.running.get(profileId);
    if (!entry) throw new Error('That agent is not running on this PC.');
    const ready = (state: ReturnType<SessionClient['getState']>) => state.status === 'connected' && state.you !== null;
    const connected = ready(entry.client.getState()) || (await new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        off();
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), 15_000);
      const off = entry.client.subscribe((state) => {
        if (ready(state)) done(true);
        else if (state.status === 'closed') done(false);
      });
    }));
    if (!connected) throw new Error(entry.state.error ?? 'The agent could not connect to the session.');
    return entry.runner.draft(prompt, taskId, signal, kind);
  }

  /** Stops an agent. Unless forget is set, one that failed stays listed for a while so its error shows. */
  async stop(profileId: string, forget = true): Promise<void> {
    const entry = this.running.get(profileId);
    if (!entry) return;
    await entry.runner.stop();
    if (entry.client.getState().status !== 'closed') entry.client.disconnect();
    if (forget || entry.state.status !== 'error') this.running.delete(profileId);
    else {
      // Keep the error visible for a while, then forget it.
      setTimeout(() => {
        if (this.running.get(profileId) === entry) {
          this.running.delete(profileId);
          this.onChange();
        }
      }, 15_000);
    }
    this.onChange();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }
}

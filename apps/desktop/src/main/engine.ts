import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EngineServer, EngineSettings } from '@pct/agents';
import { GODOT_PLUGIN_SCRIPT_PATH, godotPluginState, type AgentProfile } from '@pct/shared';
import type { EngineBridgeChoice, EngineEditor, EngineState } from '../common/api';
import { currentEditor, editorEvent, editorProgram, pickBridge, type EditorEvent } from './engine-auto';
import type { GodotEditorLink } from './godot-editor';
import { findGodotInstalls, nodeInstalled, runningEditors, type RunningEditor } from './programs';
import { engineAgentsOff, engineBridge, foundGodotPath, saveFoundGodotPath, savedGodotPath } from './settings';

// The game engine on this PC (issue #10): which MCP server agents use to act
// in the engine, where Godot is (for tests and the Godot MCP server), and
// which agents of a session get the engine's tools. All of it stays on this
// PC, like API keys: agents run on the PC that started them.
//
// Most of it happens on its own: with a Godot project in your folder the
// engine is on, auto picks Summer's server while Summer Engine is open and
// the Godot MCP server otherwise, Godot is found where it usually lives or
// taken from the editor you run, and the app notices when the editor opens
// your project (the Locks plugin's heartbeat).

const isBridge = (value: string): value is EngineBridgeChoice => value === 'auto' || value === 'off' || value === 'godot' || value === 'summer';

/** How often the running programs are listed. */
const SCAN_MS = 5_000;
/** How often Node.js is looked for again while it is missing. */
const NODE_RECHECK_MS = 60_000;

/** Godot found on the PATH (godot, godot4), looked up once at start and when settings open. */
let godotOnPath: string | null = null;
/** Godot found in a usual install folder, looked up once at start. */
let godotInstalled: string | null = null;

export function findGodotOnPath(): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const look = (command: string) =>
    new Promise<string | null>((resolve) =>
      execFile(finder, [command], { windowsHide: true }, (error, stdout) => resolve(error ? null : (stdout.split(/\r?\n/)[0]?.trim() || null))),
    );
  return (async () => {
    for (const name of ['godot', 'godot4']) {
      const found = await look(name);
      if (found) return (godotOnPath = found);
    }
    godotOnPath = null;
    godotInstalled = findGodotInstalls();
    return godotInstalled;
  })();
}

function godotPath(): { path: string; source: EngineState['godotSource'] } | null {
  const saved = savedGodotPath();
  if (saved) return { path: saved, source: 'saved' };
  const env = process.env.GODOT_PATH || process.env.GODOT;
  if (env) return { path: env, source: 'env' };
  const seen = foundGodotPath();
  if (seen && existsSync(seen)) return { path: seen, source: 'editor' };
  if (godotOnPath) return { path: godotOnPath, source: 'path' };
  return godotInstalled ? { path: godotInstalled, source: 'found' } : null;
}

/** Summer's engine server keeps its token here once you signed in (summer login). */
const summerSignedIn = () => existsSync(join(homedir(), '.summer', 'api-token'));

function hasNestedProject(folder: string): boolean {
  try {
    // One folder down, as the agents look (see findGodotProject).
    return readdirSync(folder, { withFileTypes: true }).some(
      (e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && existsSync(join(folder, e.name, 'project.godot')),
    );
  } catch {
    return false;
  }
}

const readText = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

export interface EngineWatchHooks {
  link: GodotEditorLink;
  folder(): string | null;
  /** Something shown in the app changed. */
  changed(): void;
  /** The editor opened or closed your project, or opened another scene. */
  event(event: EditorEvent): void;
  /** An editor started while the project has no Locks plugin, or an old one. */
  pluginMissing(editor: EngineEditor, plugin: 'missing' | 'old'): void;
}

/** Keeps an eye on the engine programs on this PC; see the top of this file. */
export class EngineWatch {
  private running: RunningEditor[] = [];
  private node: boolean | null = null;
  private nodeAt = 0;
  private editor: EngineEditor | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;

  constructor(private readonly hooks: EngineWatchHooks) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.scan(), SCAN_MS);
    void this.scan();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Call when the plugin's heartbeat changes, so the app reacts right away. */
  editorChanged() {
    this.update();
  }

  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      if (this.node !== true && Date.now() - this.nodeAt > NODE_RECHECK_MS) {
        this.nodeAt = Date.now();
        const before = this.node;
        this.node = await nodeInstalled();
        if (before !== this.node) this.hooks.changed();
      }
      const before = this.running.map((e) => `${e.kind}:${e.pid}`).join();
      this.running = await runningEditors();
      const started = this.running.filter((e) => !before.split(',').includes(`${e.kind}:${e.pid}`));
      const program = editorProgram(this.hooks.link.openEditor(), this.running);
      if (program && !savedGodotPath()) saveFoundGodotPath(program);
      if (this.running.map((e) => `${e.kind}:${e.pid}`).join() !== before) this.update();
      const plugin = this.plugin();
      if (started.length && (plugin === 'missing' || plugin === 'old') && !this.hooks.link.openEditor()) {
        this.hooks.pluginMissing({ kind: started[0]!.kind, projectOpen: false, scene: null, version: null }, plugin);
      }
    } finally {
      this.scanning = false;
    }
  }

  private update() {
    const link = this.hooks.link;
    const toRepo = (res: string) => {
      const dir = link.projectDir();
      const rel = res.replace(/^res:\/\//, '');
      return dir ? `${dir}/${rel}` : rel;
    };
    const next = currentEditor(link.openEditor(), this.running, toRepo);
    const event = editorEvent(this.editor, next);
    this.editor = next;
    if (event) this.hooks.event(event);
    this.hooks.changed();
  }

  /** The Locks plugin in your project folder's Godot project (top folder only, as project setup writes it). */
  plugin(): EngineState['plugin'] {
    const folder = this.hooks.folder();
    if (!folder) return null;
    return godotPluginState({
      godotProject: readText(join(folder, 'project.godot')),
      godotPlugin: readText(join(folder, ...GODOT_PLUGIN_SCRIPT_PATH.split('/'))),
    });
  }

  state(sessionId: string | null, agents: AgentProfile[]): EngineState {
    const folder = this.hooks.folder();
    const choice = engineBridge();
    const bridge = isBridge(choice) ? choice : 'auto';
    const godot = godotPath();
    const godotProject = !!folder && (existsSync(join(folder, 'project.godot')) || hasNestedProject(folder));
    const signedIn = summerSignedIn();
    const picked = pickBridge(bridge, {
      godotProject,
      node: this.node,
      summerSignedIn: signedIn,
      editor: this.editor,
      summerRunning: this.running.some((e) => e.kind === 'summer'),
    });
    const off = new Set(sessionId ? engineAgentsOff(sessionId) : []);
    return {
      bridge,
      active: picked.active,
      activeWhy: picked.why,
      godotPath: godot?.path ?? null,
      godotSource: godot?.source ?? null,
      summerSignedIn: signedIn,
      node: this.node,
      // Codex has no hook to check each call through, so it never gets engine tools.
      agents: agents.filter((a) => !isCodex(a) && !off.has(a.id)).map((a) => a.id),
      godotProject,
      plugin: this.plugin(),
      editor: this.editor,
    };
  }
}

const isCodex = (agent: AgentProfile) => agent.connection.type === 'cli' && agent.connection.tool === 'codex';

/** npx through cmd on Windows, where it is a .cmd file (Claude Code's MCP config needs that too). */
function npx(args: string[]): Pick<EngineServer, 'command' | 'args'> {
  return process.platform === 'win32' ? { command: 'cmd', args: ['/c', 'npx', ...args] } : { command: 'npx', args };
}

export function engineServer(bridge: 'godot' | 'summer' | null, godot: string | null): EngineServer | null {
  if (bridge === 'godot') return { kind: 'godot', ...npx(['-y', '@coding-solo/godot-mcp']), env: godot ? { GODOT_PATH: godot } : {} };
  if (bridge === 'summer') return { kind: 'summer', ...npx(['-y', 'summer-engine@latest', 'mcp']) };
  return null;
}

/**
 * What one agent's runner gets: the engine server when the agent has the
 * engine in this session, and Godot's path for the tests (every agent).
 */
export function engineSettingsFor(state: EngineState, agent: AgentProfile): EngineSettings | null {
  const server = state.agents.includes(agent.id) ? engineServer(state.active, state.godotPath) : null;
  if (!server && !state.godotPath) return null;
  return { server, godotPath: state.godotPath };
}

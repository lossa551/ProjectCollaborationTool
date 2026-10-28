import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EngineServer, EngineSettings } from '@pct/agents';
import { GODOT_PLUGIN_SCRIPT_PATH, godotPluginState, type AgentProfile } from '@pct/shared';
import type { EngineBridgeChoice, EngineEditor, EngineState, UnrealState } from '../common/api';
import { currentEditor, editorEvent, editorProgram, pickBridge, type EditorEvent } from './engine-auto';
import type { GodotEditorLink } from './godot-editor';
import { findGodotInstalls, findUnrealInstalls, nodeInstalled, pickUnreal, runningEditors, type RunningEditor } from './programs';
import { ENGINEWIRE_VERSION } from './unreal';
import { engineAgentsOff, engineBridge, foundGodotPath, saveFoundGodotPath, savedGodotPath } from './settings';

// The game engine on this PC (issues #10 and #11): which MCP server agents use to act
// in the engine, where Godot is (for tests and the Godot MCP server), and
// which agents of a session get the engine's tools. All of it stays on this
// PC, like API keys: agents run on the PC that started them.
//
// Most of it happens on its own: with a Godot project in your folder the
// engine is on, auto picks Summer's server while Summer Engine is open and
// the Godot MCP server otherwise, Godot is found where it usually lives or
// taken from the editor you run, and the app notices when the editor opens
// your project (the Locks plugin's heartbeat). An Unreal project gets
// EngineWire's server, Unreal Engine is found from the .uproject's version
// (Epic Games Launcher, registry, usual folders, or the editor you run), and
// the app sees the Unreal Editor open your project from its command line.

const isBridge = (value: string): value is EngineBridgeChoice =>
  value === 'auto' || value === 'off' || value === 'godot' || value === 'summer' || value === 'unreal';

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

/** Unreal installs on this PC, looked up at start and when settings open. */
let unrealInstalls = new Map<string, string>();

export async function findUnrealOnPc(): Promise<void> {
  unrealInstalls = await findUnrealInstalls().catch(() => new Map<string, string>());
}

/** The .uproject in the folder or one folder down, as the agents look (findUnrealProject), with what it says. */
export function readUnrealProject(folder: string): { uproject: string; text: string } | null {
  const look = (dir: string) => {
    try {
      const name = readdirSync(join(folder, dir)).find((n) => /\.uproject$/i.test(n));
      if (!name) return null;
      const uproject = dir ? `${dir}/${name}` : name;
      return { uproject, text: readFileSync(join(folder, dir, name), 'utf8') };
    } catch {
      return null;
    }
  };
  const top = look('');
  if (top) return top;
  try {
    for (const e of readdirSync(folder, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const found = look(e.name);
      if (found) return found;
    }
  } catch {
    // Not readable.
  }
  return null;
}

/** What the .uproject says: the engine it wants, C++ modules, EngineWire turned on from the engine. */
export function uprojectFacts(text: string): { association: string | null; hasCode: boolean; engineWire: boolean } {
  try {
    const parsed = JSON.parse(text) as { EngineAssociation?: unknown; Modules?: unknown[]; Plugins?: { Name?: string; Enabled?: boolean }[] };
    return {
      association: typeof parsed.EngineAssociation === 'string' && parsed.EngineAssociation ? parsed.EngineAssociation : null,
      hasCode: Array.isArray(parsed.Modules) && parsed.Modules.length > 0,
      engineWire: !!parsed.Plugins?.some((p) => p.Name === 'EngineWire' && p.Enabled !== false),
    };
  } catch {
    return { association: null, hasCode: false, engineWire: false };
  }
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
  /** An editor started while the project has no Locks plugin, or an old one (or, for Unreal, no EngineWire). */
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
      const godotStarted = started.filter((e) => e.kind !== 'unreal');
      if (godotStarted.length && (plugin === 'missing' || plugin === 'old') && !this.hooks.link.openEditor()) {
        this.hooks.pluginMissing({ kind: godotStarted[0]!.kind, projectOpen: false, scene: null, version: null }, plugin);
      }
      // The Unreal Editor opened your project without EngineWire: agents cannot reach it.
      const unreal = this.unreal();
      if (unreal?.plugin === 'missing' && started.some((e) => e.kind === 'unreal') && this.editor?.kind === 'unreal' && this.editor.projectOpen) {
        this.hooks.pluginMissing(this.editor, 'missing');
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
    const folder = this.hooks.folder();
    const unreal = folder ? readUnrealProject(folder) : null;
    const next = currentEditor(link.openEditor(), this.running, toRepo, unreal && folder ? join(folder, ...unreal.uproject.split('/')) : null);
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

  /** The Unreal project in your project folder, and what this PC has for it; null without a .uproject. */
  unreal(): UnrealState | null {
    const folder = this.hooks.folder();
    const found = folder ? readUnrealProject(folder) : null;
    if (!folder || !found) return null;
    const facts = uprojectFacts(found.text);
    const dir = found.uproject.includes('/') ? found.uproject.slice(0, found.uproject.lastIndexOf('/')) : '';
    const inProject = existsSync(join(folder, dir, 'Plugins', 'EngineWire', 'EngineWire.uplugin'));
    const running = this.running.find((e) => e.kind === 'unreal' && e.program)?.program ?? null;
    return {
      uproject: found.uproject,
      engineVersion: facts.association,
      editorCmd: process.env.UNREAL_EDITOR_CMD || pickUnreal(facts.association, unrealInstalls, running),
      plugin: inProject || facts.engineWire ? 'ok' : 'missing',
      hasCode: facts.hasCode,
    };
  }

  state(sessionId: string | null, agents: AgentProfile[]): EngineState {
    const folder = this.hooks.folder();
    const choice = engineBridge();
    const bridge = isBridge(choice) ? choice : 'auto';
    const godot = godotPath();
    const godotProject = !!folder && (existsSync(join(folder, 'project.godot')) || hasNestedProject(folder));
    const signedIn = summerSignedIn();
    const unreal = godotProject ? null : this.unreal();
    const picked = pickBridge(bridge, {
      godotProject,
      unrealProject: !!unreal,
      unrealPlugin: unreal?.plugin ?? null,
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
      unreal,
    };
  }
}

const isCodex = (agent: AgentProfile) => agent.connection.type === 'cli' && agent.connection.tool === 'codex';

/** npx through cmd on Windows, where it is a .cmd file (Claude Code's MCP config needs that too). */
function npx(args: string[]): Pick<EngineServer, 'command' | 'args'> {
  return process.platform === 'win32' ? { command: 'cmd', args: ['/c', 'npx', ...args] } : { command: 'npx', args };
}

export function engineServer(bridge: 'godot' | 'summer' | 'unreal' | null, godot: string | null, unrealProject: string | null = null): EngineServer | null {
  if (bridge === 'godot') return { kind: 'godot', ...npx(['-y', '@coding-solo/godot-mcp']), env: godot ? { GODOT_PATH: godot } : {} };
  if (bridge === 'summer') return { kind: 'summer', ...npx(['-y', 'summer-engine@latest', 'mcp']) };
  // The proxy reads EngineWire's capability token from <project>/Saved/MCP/capability-token, so nothing is set up by hand.
  if (bridge === 'unreal' && unrealProject) {
    return { kind: 'unreal', ...npx(['-y', `unreal-engine-mcp-server@${ENGINEWIRE_VERSION}`]), env: { UE_PROJECT_PATH: unrealProject } };
  }
  return null;
}

/**
 * What one agent's runner gets: the engine server when the agent has the
 * engine in this session, and Godot's path for the tests (every agent).
 */
export function engineSettingsFor(state: EngineState, agent: AgentProfile, folder: string | null = null): EngineSettings | null {
  const uproject = state.unreal && folder ? join(folder, ...state.unreal.uproject.split('/')) : null;
  const server = state.agents.includes(agent.id) ? engineServer(state.active, state.godotPath, uproject && dirnameOf(uproject)) : null;
  const unrealEditor = state.unreal?.editorCmd ?? null;
  if (!server && !state.godotPath && !unrealEditor) return null;
  return { server, godotPath: state.godotPath, unrealEditor };
}

const dirnameOf = (path: string) => path.replace(/[\\/][^\\/]+$/, '');

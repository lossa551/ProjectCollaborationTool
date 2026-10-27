import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EngineServer, EngineSettings } from '@pct/agents';
import type { AgentProfile } from '@pct/shared';
import type { EngineBridgeChoice, EngineState } from '../common/api';
import { engineAgents, engineBridge, savedGodotPath } from './settings';

// The game engine on this PC (issue #10): which MCP server agents use to act
// in the engine, where Godot is (for tests and the Godot MCP server), and
// which agents of a session get the engine's tools. All of it stays on this
// PC, like API keys: agents run on the PC that started them.

const isBridge = (value: string): value is EngineBridgeChoice => value === 'off' || value === 'godot' || value === 'summer';

/** Godot found on the PATH (godot, godot4), looked up once at start and when settings open. */
let godotOnPath: string | null = null;

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
    return (godotOnPath = null);
  })();
}

function godotPath(): { path: string; source: EngineState['godotSource'] } | null {
  const saved = savedGodotPath();
  if (saved) return { path: saved, source: 'saved' };
  const env = process.env.GODOT_PATH || process.env.GODOT;
  if (env) return { path: env, source: 'env' };
  return godotOnPath ? { path: godotOnPath, source: 'path' } : null;
}

/** Summer's engine server keeps its token here once you signed in (summer login). */
const summerSignedIn = () => existsSync(join(homedir(), '.summer', 'api-token'));

export function engineState(sessionId: string | null, folder: string | null): EngineState {
  const bridge = engineBridge();
  const godot = godotPath();
  return {
    bridge: isBridge(bridge) ? bridge : 'off',
    godotPath: godot?.path ?? null,
    godotSource: godot?.source ?? null,
    summerSignedIn: summerSignedIn(),
    agents: sessionId ? engineAgents(sessionId) : [],
    godotProject: !!folder && (existsSync(join(folder, 'project.godot')) || hasNestedProject(folder)),
  };
}

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

/** npx through cmd on Windows, where it is a .cmd file (Claude Code's MCP config needs that too). */
function npx(args: string[]): Pick<EngineServer, 'command' | 'args'> {
  return process.platform === 'win32' ? { command: 'cmd', args: ['/c', 'npx', ...args] } : { command: 'npx', args };
}

export function engineServer(bridge: EngineBridgeChoice, godot: string | null): EngineServer | null {
  if (bridge === 'godot') return { kind: 'godot', ...npx(['-y', '@coding-solo/godot-mcp']), env: godot ? { GODOT_PATH: godot } : {} };
  if (bridge === 'summer') return { kind: 'summer', ...npx(['-y', 'summer-engine@latest', 'mcp']) };
  return null;
}

/**
 * What one agent's runner gets: the engine server when the agent is picked
 * for it in this session, and Godot's path for the tests (every agent).
 */
export function engineSettingsFor(sessionId: string | null, agent: AgentProfile): EngineSettings | null {
  const state = engineState(sessionId, null);
  // Codex has no hook to check each call through, so it gets no engine tools.
  const codex = agent.connection.type === 'cli' && agent.connection.tool === 'codex';
  const server = state.agents.includes(agent.id) && !codex ? engineServer(state.bridge, state.godotPath) : null;
  if (!server && !state.godotPath) return null;
  return { server, godotPath: state.godotPath };
}

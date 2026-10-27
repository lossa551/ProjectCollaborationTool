import { access, cp, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { normalizePath } from '@pct/shared';
import { McpClient, type McpCallResult, type McpTool } from './mcp.js';
import type { ToolSpec } from './models/types.js';

// Game engine bridges (issue #10). Agents act in the engine through an MCP
// server the app runs and talks to itself: the Godot MCP server
// (Coding-Solo/godot-mcp, which runs Godot headless on a project folder) or
// Summer Engine's (which drives the editor that has the project open). Each
// call is sorted before it runs: reading the engine is allowed, changing
// project files goes through the same locks, scope and approvals as a file
// edit, and anything else (playing the game, running editor scripts, cloud
// operations) follows the agent's rule for commands.

export type EngineBridgeKind = 'godot' | 'summer';

export const ENGINE_BRIDGES: Record<EngineBridgeKind, { label: string; detail: string }> = {
  godot: {
    label: 'Godot MCP server',
    detail: 'Runs Godot headless on the agent’s own copy of the project to make scenes, add nodes and run the game.',
  },
  summer: {
    label: 'Summer Engine',
    detail: 'Drives the Summer Engine editor that has your project open. Agents that use it work in your project folder.',
  },
};

/** The engine's MCP server: how to start it (stdio). */
export interface EngineServer {
  kind: EngineBridgeKind;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** What an agent's runner needs to reach the engine on this PC. */
export interface EngineSettings {
  /** null: the agent gets no engine tools. */
  server: EngineServer | null;
  /** Godot (or Summer Engine) executable, for running the tests; null when not known. */
  godotPath: string | null;
}

/** The project.godot folder, repo-relative ('' for the top folder); null when there is none near the top. */
export async function findGodotProject(root: string): Promise<string | null> {
  const exists = (path: string) => access(path).then(() => true, () => false);
  if (await exists(join(root, 'project.godot'))) return '';
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (await exists(join(root, entry.name, 'project.godot'))) return entry.name;
    }
  } catch {
    // Not readable: no project.
  }
  return null;
}

const joinRel = (dir: string, rel: string) => (dir ? `${dir}/${rel}` : rel);

/**
 * An engine path as a repo-relative one: res:// and plain paths are inside
 * the Godot project folder, absolute paths are checked against the folder
 * the agent works in. Null for paths outside the project (user://, other folders).
 */
export function engineToRepoPath(raw: string, godotDir: string, root: string): string | null {
  const path = raw.trim();
  if (!path || /^user:\/\//i.test(path) || /^uid:\/\//i.test(path)) return null;
  if (/^res:\/\//i.test(path)) return normalizePath(joinRel(godotDir, path.replace(/^res:\/\//i, '')));
  if (isAbsolute(path) || /^[a-z]:[\\/]/i.test(path)) {
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    return normalizePath(rel.split(sep).join('/'));
  }
  return normalizePath(joinRel(godotDir, path));
}

export type EngineCall =
  /** Looks at the engine or the game; nothing in the project changes. */
  | { kind: 'read'; what: string }
  /** Changes these project files (repo-relative). */
  | { kind: 'edit'; what: string; paths: string[] }
  /** Does something else: runs the game or code, or changes things outside the files it names. */
  | { kind: 'action'; what: string };

// The Godot MCP server's tools (Coding-Solo/godot-mcp).
const GODOT_READ = new Set(['get_debug_output', 'get_godot_version', 'list_projects', 'get_project_info', 'get_uid', 'stop_project']);
/** Tools that write the scene (or the output) they name. */
const GODOT_EDIT: Record<string, string[]> = {
  create_scene: ['scenePath'],
  add_node: ['scenePath'],
  load_sprite: ['scenePath'],
  export_mesh_library: ['outputPath'],
};

// Summer Engine's engine operations, by name without "engine.".
const SUMMER_READ = new Set([
  'game_probe', 'get_console', 'get_debugger_errors', 'get_debugger_warnings', 'get_diagnostics', 'get_project_context',
  'get_runtime_tree', 'get_scene_tree', 'get_script_errors', 'grep', 'inspect_asset', 'inspect_node', 'inspect_resource',
  'inspect_runtime_node', 'is_running', 'list_camera_bookmarks', 'list_ui_actions', 'measure', 'navigation_probe', 'raycast',
  'read_file', 'recent_events', 'scene_audit', 'screenshot', 'shot_sheet', 'snapshot_diff', 'starcast', 'test_placement',
  'ui_screenshot', 'ui_tree', 'wait_for_event', 'world_snapshot', 'zoom', 'debug_views',
  // Editor view only: which scene is open, what is selected, camera bookmarks; no project file changes.
  'open_scene', 'open_main_scene', 'select_node', 'view_set', 'frame_nodes', 'frame_shot', 'save_camera_bookmark',
  'delete_camera_bookmark', 'clear_console', 'stop',
  // Finding and waiting for operations.
  'search', 'ops_search', 'ops_describe', 'jobs_wait', 'describe', 'status',
]);
/** Operations that save the scene or file they name. */
const SUMMER_EDIT = new Set([
  'add_node', 'align_distribute_3d', 'attach_to_surface', 'batch', 'connect_ports', 'connect_signal', 'create_scene',
  'create_debug_report', 'fabricate_3d', 'instantiate_scene', 'place_adjacent', 'remove_node', 'repeat_along', 'replace_node',
  'replace_text', 'save_scene', 'set_prop', 'set_resource_property', 'snap_to_surface', 'write_file',
]);
/** Operations that change project settings, which live in project.godot. */
const SUMMER_PROJECT_SETTINGS = new Set(['project_setting', 'input_map_bind']);
/** Input keys that name a file an operation writes. */
const PATH_KEYS = ['scenePath', 'scene_path', 'path', 'newPath', 'new_path', 'filePath', 'file_path', 'outputPath', 'output_path', 'out_path'];

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** The operation a Summer tool call runs, and its input. */
export function summerOperation(tool: string, input: Record<string, unknown>): { op: string; args: Record<string, unknown> } {
  if (tool === 'summer_call' || tool === 'call') {
    const name = [input.operation, input.op, input.name, input.slug].find((v): v is string => typeof v === 'string') ?? '';
    const args = record(input.input ?? input.args ?? input.params ?? input.arguments);
    return { op: name, args: Object.keys(args).length ? args : input };
  }
  return { op: tool.replace(/^summer_/, ''), args: input };
}

const opKey = (op: string) => op.trim().toLowerCase().replace(/^engine[._]/, '').replace(/\./g, '_');

function pathsIn(args: Record<string, unknown>, keys: string[], godotDir: string, root: string): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const path = engineToRepoPath(value, godotDir, root);
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

/**
 * Sorts one engine tool call. tool is the server's own name (without any
 * prefix the app adds); godotDir is the project.godot folder; root the folder
 * the agent works in.
 */
export function classifyEngineCall(kind: EngineBridgeKind, tool: string, rawInput: unknown, godotDir: string, root: string): EngineCall {
  const input = record(rawInput);
  if (kind === 'godot') {
    const what = `Godot ${tool}`;
    if (GODOT_READ.has(tool)) return { kind: 'read', what };
    if (tool === 'save_scene') {
      // Saves the scene, or a copy of it under newPath.
      const paths = pathsIn(input, typeof input.newPath === 'string' && input.newPath ? ['newPath'] : ['scenePath'], godotDir, root);
      return paths.length ? { kind: 'edit', what, paths } : { kind: 'action', what };
    }
    const keys = GODOT_EDIT[tool];
    if (keys) {
      const paths = pathsIn(input, keys, godotDir, root);
      return paths.length ? { kind: 'edit', what, paths } : { kind: 'action', what };
    }
    // launch_editor, run_project, update_project_uids and anything newer.
    return { kind: 'action', what };
  }

  const { op, args } = summerOperation(tool, input);
  const key = opKey(op);
  const what = `Summer ${op || tool}`;
  // A dry run checks a change without making it.
  if (args.dryRun === true || args.dry_run === true || input.dryRun === true) return { kind: 'read', what: `${what} (dry run)` };
  if (!op || SUMMER_READ.has(key) || /^(get|list|inspect|describe|search)_/.test(key) || tool === 'summer_search' || tool === 'summer_jobs_wait') {
    return { kind: 'read', what };
  }
  // Operations of other areas (store, pricing, assets, publishing) are Summer's cloud: never project files.
  if (/[.]/.test(op) && !/^engine[.]/i.test(op)) return { kind: 'action', what };
  if (SUMMER_PROJECT_SETTINGS.has(key)) return { kind: 'edit', what, paths: [normalizePath(joinRel(godotDir, 'project.godot'))!] };
  if (SUMMER_EDIT.has(key)) {
    const paths = pathsIn(args, PATH_KEYS, godotDir, root);
    return paths.length ? { kind: 'edit', what, paths } : { kind: 'action', what };
  }
  return { kind: 'action', what };
}

/** What Summer said back, for the chat and the agent. */
export interface EngineAnswer {
  /** Summer refused to overwrite a file that changed since it was read. */
  conflict: string | null;
  /** Summer wants a person to approve on its site first. */
  approvalUrl: string | null;
  /** Files Summer's receipts say it wrote (as Summer names them). */
  receipts: string[];
  /** Summer's error, when it refused for another reason. */
  error: { code: string; message: string; next: string | null } | null;
}

/** Reads Summer's answer shape ({ ok, status, result, error }); other servers' answers give nothing. */
export function readEngineAnswer(text: string): EngineAnswer {
  const answer: EngineAnswer = { conflict: null, approvalUrl: null, receipts: [], error: null };
  let data: Record<string, unknown>;
  try {
    data = record(JSON.parse(text));
  } catch {
    return answer;
  }
  if (data.ok === false) {
    const error = record(data.error);
    const code = typeof error.code === 'string' ? error.code : 'error';
    const message = typeof error.message === 'string' ? error.message : 'Summer refused the operation';
    const next = typeof error.next === 'string' ? error.next : typeof record(error.next).summary === 'string' ? String(record(error.next).summary) : null;
    answer.error = { code, message, next };
    if (code === 'conflict' || code === 'stale' || /stale|changed since/i.test(message)) answer.conflict = message;
  }
  if (data.status === 'needs_approval') {
    const url = record(data.approval).url;
    if (typeof url === 'string') answer.approvalUrl = url;
  }
  // Receipts: any object under the result that names a path it wrote, with a hash or size.
  const walk = (value: unknown, depth: number) => {
    if (depth > 5 || answer.receipts.length >= 50) return;
    if (Array.isArray(value)) return value.forEach((v) => walk(v, depth + 1));
    if (!value || typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    const path = [obj.path, obj.file, obj.scenePath].find((v): v is string => typeof v === 'string');
    const proof = ['sha256', 'hash', 'bytes', 'size', 'written', 'receipt'].some((k) => k in obj);
    if (path && proof && !answer.receipts.includes(path)) answer.receipts.push(path);
    for (const child of Object.values(obj)) walk(child, depth + 1);
  };
  walk(data.result ?? data.receipt ?? data.receipts, 0);
  return answer;
}

// Tests. Godot has no test runner of its own; GUT and gdUnit4 are the common
// add-ons, both run headless from the command line.

export type GodotTestFramework = 'gut' | 'gdunit4';

export async function findTestFramework(projectDir: string): Promise<GodotTestFramework | null> {
  const has = (path: string) => stat(join(projectDir, path)).then(() => true, () => false);
  if (await has('addons/gut/gut_cmdln.gd')) return 'gut';
  if (await has('addons/gdUnit4/bin/GdUnitCmdTool.gd')) return 'gdunit4';
  return null;
}

const quote = (arg: string) => (/^[\w\-.:\\/=]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);

/** The shell command that runs the project's tests headless; target is a res:// folder or test file. */
export async function godotTestCommand(godotPath: string, projectDir: string, framework: GodotTestFramework, target?: string): Promise<string> {
  const base = [quote(godotPath), '--headless', '--path', quote(projectDir)];
  if (framework === 'gut') {
    const args = ['-s', 'addons/gut/gut_cmdln.gd', '-gexit'];
    if (target) args.push(target.endsWith('.gd') ? `-gtest=${quote(target)}` : `-gdir=${quote(target)}`);
    else if (!(await stat(join(projectDir, '.gutconfig.json')).then(() => true, () => false))) args.push('-gdir=res://test', '-ginclude_subdirs');
    return [...base, ...args].join(' ');
  }
  return [...base, '-s', '-d', 'res://addons/gdUnit4/bin/GdUnitCmdTool.gd', '--ignoreHeadlessMode', '-a', quote(target ?? 'res://test')].join(' ');
}

export interface TestSummary {
  passed: boolean;
  /** Counts the output gave, when it gave them. */
  passing: number | null;
  failing: number | null;
  /** Names of failing tests found in the output. */
  failures: string[];
}

/** Reads GUT's or gdUnit4's summary; the exit code decides when the output says nothing. */
export function parseTestOutput(output: string, exitCode: number | null): TestSummary {
  const number = (re: RegExp) => {
    const m = re.exec(output);
    return m ? Number(m[1]) : null;
  };
  let passing = number(/Passing\s+Tests\s+(\d+)/i);
  let failing = number(/Failing\s+Tests\s+(\d+)/i);
  const gdunit = /Overall Summary:\s*(\d+)\s+test cases?\s*\|\s*(\d+)\s+errors?\s*\|\s*(\d+)\s+failures?/i.exec(output);
  if (gdunit) {
    const total = Number(gdunit[1]);
    failing = Number(gdunit[2]) + Number(gdunit[3]);
    passing = Math.max(0, total - failing);
  }
  const failures: string[] = [];
  // GUT: "* test_name" followed by "[Failed]"; gdUnit4: "test_name ... FAILED".
  const lines = output.split(/\r?\n/);
  lines.forEach((line, i) => {
    const gut = /^\s*\*\s*(test_\w+)/.exec(line);
    if (gut && lines.slice(i + 1, i + 4).some((l) => /\[Failed\]/i.test(l)) && !failures.includes(gut[1]!)) failures.push(gut[1]!);
    const unit = /(test_\w+).*\b(FAILED|ERRORS?)\b/.exec(line);
    if (unit && !failures.includes(unit[1]!)) failures.push(unit[1]!);
  });
  const passed = exitCode === 0 && (failing === null || failing === 0);
  return { passed, passing, failing, failures: failures.slice(0, 50) };
}

export function describeTests(summary: TestSummary): string {
  const counts = [
    summary.passing !== null ? `${summary.passing} passing` : '',
    summary.failing !== null ? `${summary.failing} failing` : '',
  ].filter(Boolean);
  const head = summary.passed ? 'Tests passed' : 'Tests failed';
  const failed = summary.failures.length ? ` Failing: ${summary.failures.join(', ')}.` : '';
  return `${head}${counts.length ? ` (${counts.join(', ')})` : ''}.${failed}`;
}

/**
 * A new agent copy of a Godot project starts with the project folder's
 * import cache (.godot/), so the engine does not import every asset again.
 * The cache is never committed; the copy just reuses it.
 */
export async function seedGodotCache(root: string, copy: string): Promise<boolean> {
  const dir = await findGodotProject(root);
  if (dir === null) return false;
  const from = join(root, dir, '.godot');
  const to = join(copy, dir, '.godot');
  const exists = (path: string) => access(path).then(() => true, () => false);
  if (!(await exists(from)) || (await exists(to))) return false;
  // The editor's own layout and open scenes stay with the person.
  await cp(from, to, { recursive: true, filter: (src) => !relative(from, src).split(sep).includes('editor') });
  return true;
}

/** Tool names an API model sees for the engine's tools; unique and within providers' rules. */
export function engineToolName(kind: EngineBridgeKind, tool: string): string {
  const clean = tool.replace(/[^a-zA-Z0-9_-]/g, '_');
  const name = kind === 'godot' ? `godot_${clean}` : clean.startsWith('summer') ? clean : `summer_${clean}`;
  return name.slice(0, 64);
}

/**
 * One engine MCP server for an agent's runner, started on first use. Its
 * tools are offered to API agents under engineToolName; Claude Code gets the
 * same server through its own MCP config and is checked through the hook.
 */
export class EngineBridge {
  private readonly client: McpClient;
  private tools: McpTool[] | null = null;
  /** Agent-facing name to the server's own. */
  private readonly names = new Map<string, string>();

  constructor(readonly server: EngineServer, cwd: string) {
    this.client = new McpClient(
      { command: server.command, args: server.args, env: server.env, cwd },
      { label: ENGINE_BRIDGES[server.kind].label },
    );
  }

  /** Same server as this one. */
  sameAs(server: EngineServer): boolean {
    return JSON.stringify(server) === JSON.stringify(this.server);
  }

  async specs(): Promise<ToolSpec[]> {
    this.tools ??= await this.client.listTools();
    this.names.clear();
    return this.tools.map((tool) => {
      const name = engineToolName(this.server.kind, tool.name);
      this.names.set(name, tool.name);
      const label = ENGINE_BRIDGES[this.server.kind].label;
      return {
        name,
        description: `${label}: ${tool.description || tool.name}`.slice(0, 1000) +
          ' Checked by the app like a file edit when it changes project files.',
        schema: { type: 'object', ...tool.inputSchema },
      };
    });
  }

  /** The server's own name for a tool an agent called; null when it is not an engine tool. */
  serverName(agentName: string): string | null {
    return this.names.get(agentName) ?? null;
  }

  call(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    return this.client.callTool(tool, input, signal);
  }

  /** Claude Code's --mcp-config: the same server, named "engine". */
  claudeConfig(): string {
    return JSON.stringify({
      mcpServers: { engine: { type: 'stdio', command: this.server.command, args: this.server.args, env: this.server.env ?? {} } },
    });
  }

  close() {
    this.client.close();
    this.tools = null;
  }
}

/** Claude Code names MCP tools mcp__<server>__<tool>: the engine servers, by ours or the setup commands' names. */
export function claudeEngineTool(toolName: string): { kind: EngineBridgeKind | null; tool: string } | null {
  const match = /^mcp__([^_].*?)__(.+)$/.exec(toolName);
  if (!match) return null;
  const server = match[1]!.toLowerCase();
  const tool = match[2]!;
  if (server === 'engine') return { kind: null, tool };
  if (server.startsWith('summer')) return { kind: 'summer', tool };
  if (server.startsWith('godot')) return { kind: 'godot', tool };
  return null;
}

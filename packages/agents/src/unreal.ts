import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { objectPathParts } from '@pct/shared';
import type { EngineCall } from './engine.js';
import { UNREAL_DESTRUCTIVE, UNREAL_READ } from './unreal-capabilities.js';

// Unreal Engine (issue #11). Agents act in the Unreal Editor through
// EngineWire (ChiR24/Unreal_mcp 0.6): a plugin in the project serves MCP from
// the open editor, and its stdio proxy (npx unreal-engine-mcp-server) is what
// the app runs. Since 0.6 it offers one tool, `unreal`, with the operations
// search, describe, execute and configure; execute runs one of ~450
// capabilities named by tool + action or a capability id. Each execute is
// sorted with EngineWire's own catalog (unreal-capabilities.ts): reads go
// through, changes to assets and levels it names are checked and locked like
// file edits (.uasset and .umap are binary, so the lock is exclusive), deletes
// also ask a person, and anything that can run code or touch the whole
// project follows the agent's rule for commands.

export interface UnrealProject {
  /** The .uproject's folder, repo-relative ('' for the top). */
  dir: string;
  /** The .uproject's name without the extension. */
  name: string;
  /** The .uproject, repo-relative. */
  uproject: string;
}

/** The .uproject at the top or one folder down; null when there is none. */
export async function findUnrealProject(root: string): Promise<UnrealProject | null> {
  const look = async (dir: string): Promise<UnrealProject | null> => {
    try {
      const file = (await readdir(join(root, dir))).find((n) => /\.uproject$/i.test(n));
      if (!file) return null;
      return { dir, name: file.replace(/\.uproject$/i, ''), uproject: dir ? `${dir}/${file}` : file };
    } catch {
      return null;
    }
  };
  const top = await look('');
  if (top) return top;
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const found = await look(entry.name);
      if (found) return found;
    }
  } catch {
    // Not readable: no project.
  }
  return null;
}

const under = (dir: string, rel: string) => (dir ? `${dir}/${rel}` : rel);

/**
 * The file an object path is saved in, repo-relative: /Game/... is the
 * project's Content folder, another mount a plugin's (Plugins/<Mount>/Content)
 * when the project has that plugin. level says it is a map (.umap) when the
 * file does not exist yet; an existing .umap always wins. Null for engine
 * packages and mounts the project does not have.
 */
export function unrealToRepoPath(objectPath: string, project: UnrealProject, exists: (repoPath: string) => boolean, level = false): string | null {
  const parts = objectPathParts(objectPath);
  if (!parts) return null;
  let content: string;
  if (parts.mount.toLowerCase() === 'game') content = under(project.dir, 'Content');
  else {
    content = under(project.dir, `Plugins/${parts.mount}/Content`);
    if (!exists(content)) return null;
  }
  const base = `${content}/${parts.rel}`;
  if (exists(`${base}.umap`)) return `${base}.umap`;
  if (exists(`${base}.uasset`)) return `${base}.uasset`;
  return `${base}.${level ? 'umap' : 'uasset'}`;
}

/** What one execute names: the capability key (lower case) and its parameters. */
export function unrealCapability(tool: string, input: Record<string, unknown>): { key: string; params: Record<string, unknown> } | null {
  const record = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  if (tool === 'unreal') {
    if (input.operation !== 'execute') return null;
    const params = record(input.params);
    if (typeof input.capability === 'string' && input.capability) return { key: input.capability.toLowerCase(), params };
    if (typeof input.tool === 'string' && typeof input.action === 'string') return { key: `${input.tool}.${input.action}`.toLowerCase(), params };
    return { key: '', params };
  }
  // A 0.5 plugin serves its 23 tools directly, with the action in the input.
  const { action, params, ...rest } = input;
  return { key: `${tool}.${typeof action === 'string' ? action : ''}`.toLowerCase(), params: { ...rest, ...record(params) } };
}

/** Changes the project settings, plugins, code or editor as a whole, or runs code: never sorted by the paths it names. */
const UNREAL_ACTIONS = new Set([
  'system_control.execute_python', 'system_control.run_script', 'system_control.run_recipe', 'system_control.save_recipe',
  'system_control.console_command', 'control_editor.console_command', 'control_editor.call_editor_tool',
  'control_editor.call_editor_tool_destructive', 'control_editor.invoke_reflected_function', 'control_editor.restart_editor',
  'control_editor.undo', 'control_editor.save_all', 'control_editor.play', 'control_editor.playtest', 'control_editor.simulate_input',
  'system_control.run_build', 'system_control.package_project', 'system_control.launch_build', 'system_control.create_cpp_class',
  'system_control.enable_plugin', 'system_control.set_project_setting', 'system_control.configure_rendering',
  'system_control.edit_save_game', 'system_control.delete_output_file', 'manage_tools.reset',
]);

/** Changes only what the editor shows (open level, bookmarks), not project files. */
const UNREAL_VIEW = new Set([
  'control_editor.open_level', 'control_editor.close_asset', 'control_editor.create_bookmark', 'control_editor.configure_editor',
  'control_editor.set_game_speed', 'control_editor.start_recording', 'control_editor.explore_level', 'manage_level.load',
  'manage_level.stream', 'manage_level.unload_level', 'system_control.subscribe', 'system_control.profile_performance',
  'system_control.play_sound', 'manage_audio.play_sound', 'manage_audio.stop_sound', 'asset.create_folder', 'manage_asset.create_folder',
]);

/** Parameters that name the asset or level a call changes. */
const TARGET_KEYS = [
  'assetPath', 'assetPaths', 'path', 'paths', 'objectPath', 'objectPaths', 'destinationPath', 'savePath', 'deletedPath',
  'blueprintPath', 'widgetPath', 'levelPath', 'subLevelPath', 'packagePath',
];
/** Parameters that are the asset being moved away, for moves, renames and deletes only. */
const MOVED_KEYS = ['sourcePath'];
/** Folder parameters a new asset's name is added to. */
const FOLDER_KEYS = ['path', 'packagePath', 'savePath', 'levelPath', 'destinationFolder', 'destinationDirectory', 'folder', 'directory'];

/** The name a call gives what it makes: name, levelName or assetName, or an imported file's own name. */
export function newAssetName(key: string, params: Record<string, unknown>): string | null {
  for (const k of ['name', 'levelName', 'assetName']) {
    const value = params[k];
    if (typeof value === 'string' && /^[\w-]+$/.test(value)) return value;
  }
  if (/import/.test(key) && typeof params.sourcePath === 'string') {
    const stem = params.sourcePath.replace(/\\/g, '/').split('/').pop()!.replace(/\.[^.]*$/, '');
    if (/^[\w-]+$/.test(stem)) return stem;
  }
  return null;
}

/**
 * <domain>Path names the asset of that domain's own capabilities, e.g.
 * materialPath for material.*. Only the domain counts: control_actor's
 * set_material names a material it uses, not one it changes. manage_asset
 * (the legacy tool name) holds the material, texture, struct, enum and data
 * table families.
 */
function domainKeys(key: string): string[] {
  const [domain, action = ''] = key.split('.');
  const words = new Set(domain!.replace(/^manage_/, '').split('_'));
  if (domain === 'manage_asset' || domain === 'asset') {
    for (const family of ['material', 'texture', 'struct', 'enum', 'data_table']) if (action.includes(family)) words.add(family === 'data_table' ? 'datatable' : family);
  }
  const keys: string[] = [];
  for (const word of words) {
    if (!word || word.length < 3) continue;
    keys.push(`${word}Path`);
  }
  // A few domains spell their key differently.
  if (words.has('datatable') || words.has('data')) keys.push('dataTablePath');
  if (words.has('animation')) keys.push('animBlueprintPath', 'montagePath', 'animationPath');
  if (words.has('effect')) keys.push('systemPath', 'emitterPath');
  if (words.has('ai')) keys.push('behaviorTreePath', 'blackboardPath', 'stateTreePath', 'queryPath');
  return keys;
}

const LEVEL_WORDS = /level|map|world/i;

/** Object paths a call changes, from the keys that name its target; new assets with a name and a folder are joined. */
export function unrealTargets(key: string, params: Record<string, unknown>): { objectPath: string; level: boolean }[] {
  const out: { objectPath: string; level: boolean }[] = [];
  const add = (value: unknown, paramKey: string) => {
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (typeof v !== 'string' || !objectPathParts(v)) continue;
      const level = LEVEL_WORDS.test(paramKey) || key.startsWith('manage_level.');
      if (!out.some((o) => o.objectPath === v)) out.push({ objectPath: v, level });
    }
  };
  const moving = /\.(move|rename|delete|bulk_delete|maintain_content)$|delete/.test(key);
  const name = newAssetName(key, params);
  for (const k of [...TARGET_KEYS, ...domainKeys(key), ...(moving ? MOVED_KEYS : [])]) {
    const value = params[k];
    // A folder plus a name is a new asset in that folder.
    if (name && FOLDER_KEYS.includes(k) && typeof value === 'string' && objectPathParts(value) && !value.replace(/\/+$/, '').endsWith(`/${name}`)) {
      add(`${value.replace(/\/+$/, '')}/${name}`, k);
      continue;
    }
    add(value, k);
  }
  // A move or rename with a new name lands next to the source.
  const newName = typeof params.newName === 'string' && /^[\w-]+$/.test(params.newName) ? params.newName : null;
  if (newName && typeof params.sourcePath === 'string' && !params.destinationPath) {
    const parts = objectPathParts(params.sourcePath);
    if (parts) add(`/${parts.mount}/${parts.rel.split('/').slice(0, -1).concat(newName).join('/')}`, 'destinationPath');
  }
  return out;
}

export type UnrealEffect = 'read' | 'view' | 'write' | 'destructive' | 'action';

/** How EngineWire's catalog sorts a capability; unknown ones count as changing the project. */
export function unrealEffect(key: string): UnrealEffect {
  if (!key) return 'action';
  if (UNREAL_ACTIONS.has(key)) return 'action';
  if (UNREAL_VIEW.has(key)) return 'view';
  if (UNREAL_READ.has(key)) return 'read';
  if (UNREAL_DESTRUCTIVE.has(key)) return 'destructive';
  return 'write';
}

/** The asset type prefixes Epic gives what a capability makes, when that is clear from the capability. */
export function expectedPrefixes(key: string): string[] {
  const action = key.split('.').pop() ?? '';
  const rules: [RegExp, string[]][] = [
    [/^(manage_)?blueprint\.create$|create_blueprint$/, ['BP_', 'BI_', 'AC_']],
    [/widget/, ['WBP_']],
    [/create_animation_blueprint|create_anim_blueprint/, ['ABP_']],
    [/create_material_instance/, ['MI_']],
    [/create_material$/, ['M_', 'PPM_']],
    [/create_physical_material/, ['PM_']],
    [/create_skeleton/, ['SKEL_']],
    [/create_control_rig/, ['Rig_']],
    [/edit_montage|create_montage/, ['AM_']],
    [/blend_space/, ['BS_']],
    [/create_texture|create_.*_texture/, ['T_']],
    [/edit_data_table|create_data_table/, ['DT_']],
    [/edit_enum|create_enum/, ['E_']],
    [/edit_struct|create_struct/, ['F_']],
    [/create_effect|create_niagara/, ['FXS_', 'FXE_', 'FXF_']],
    [/^manage_sequence\.create$|create_cinematic_asset/, ['LS_']],
  ];
  for (const [re, prefixes] of rules) if (re.test(key) || re.test(action)) return prefixes;
  return [];
}

/**
 * Sorts one call to EngineWire. tool is the server's own name ('unreal', or
 * a 0.5 plugin's tool); exists says whether a repo-relative path is there
 * now, to tell new assets and levels from changed ones.
 */
export function classifyUnrealCall(tool: string, rawInput: unknown, project: UnrealProject, exists: (repoPath: string) => boolean): EngineCall {
  const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : {};
  const named = unrealCapability(tool, input);
  // search, describe and configure (which only turns EngineWire's own tool groups on and off) look, not change.
  if (!named) return { kind: 'read', what: `Unreal ${typeof input.operation === 'string' ? input.operation : tool}` };
  const what = `Unreal ${named.key || 'execute'}`;
  const effect = unrealEffect(named.key);
  if (effect === 'read' || effect === 'view') return { kind: 'read', what };
  if (effect === 'action') return { kind: 'action', what };
  const paths: string[] = [];
  const fresh: string[] = [];
  const name = newAssetName(named.key, named.params);
  for (const target of unrealTargets(named.key, named.params)) {
    let path = unrealToRepoPath(target.objectPath, project, exists, target.level);
    // An existing folder (an import's destination, say) gets what the call makes inside it.
    const folder = path?.replace(/\.(uasset|umap)$/i, '');
    if (folder && name && !exists(path!) && exists(folder)) path = unrealToRepoPath(`${target.objectPath.replace(/\/+$/, '')}/${name}`, project, exists, target.level);
    if (!path || paths.includes(path)) continue;
    paths.push(path);
    if (!exists(path)) fresh.push(path);
  }
  // Placing actors, lighting and the like change the open level (or, with One File Per Actor, its actor files),
  // which the call does not name: they follow the rule for commands, and what was saved is reviewed afterwards.
  if (paths.length === 0) return { kind: 'action', what };
  const call: EngineCall = { kind: 'edit', what, paths };
  if (effect === 'destructive') call.ask = true;
  if (fresh.length) {
    call.fresh = fresh;
    call.expected = expectedPrefixes(named.key);
  }
  return call;
}

/** Object paths EngineWire's receipt says the call changed (receipt.changes), as it names them. */
export function unrealReceiptChanges(text: string): string[] {
  try {
    const data = JSON.parse(text) as { receipt?: { changes?: unknown } };
    const changes = data.receipt?.changes;
    return Array.isArray(changes) ? changes.filter((c): c is string => typeof c === 'string' && objectPathParts(c) !== null).slice(0, 200) : [];
  } catch {
    return [];
  }
}

// Tests: Unreal's Automation system, run headless from UnrealEditor-Cmd.

/** The command that runs the project's automation tests headless; filter is a test path prefix such as "Project.". */
export function unrealTestCommand(editorCmd: string, uprojectPath: string, filter = 'Project'): string {
  const q = (arg: string) => `"${arg.replace(/"/g, '')}"`;
  const tests = filter.replace(/[";]/g, '').trim() || 'Project';
  return [
    q(editorCmd),
    q(uprojectPath),
    `-ExecCmds="Automation RunTests ${tests}; Quit"`,
    '-TestExit="Automation Test Queue Empty"',
    '-unattended', '-nopause', '-nosplash', '-NullRHI', '-NoSound', '-stdout', '-FullStdOutLogOutput',
  ].join(' ');
}

/** Reads Unreal's automation log: each "Test Completed. Result={...}" line, and the exit line. */
export function parseUnrealTestOutput(output: string, exitCode: number | null): { passed: boolean; passing: number | null; failing: number | null; failures: string[] } {
  let passing = 0;
  let failing = 0;
  const failures: string[] = [];
  for (const m of output.matchAll(/Test Completed\. Result=\{(\w+)\}\s+Name=\{([^}]*)\}(?:\s+Path=\{([^}]*)\})?/g)) {
    if (/^success$/i.test(m[1]!)) passing++;
    else if (/^(fail|failed|error)$/i.test(m[1]!)) {
      failing++;
      const name = m[3] || m[2]!;
      if (!failures.includes(name) && failures.length < 50) failures.push(name);
    }
  }
  const counted = passing + failing > 0;
  const exit = /TEST COMPLETE\. EXIT CODE: (-?\d+)/.exec(output);
  const code = exit ? Number(exit[1]) : exitCode;
  const noTests = /No automation tests matched|Found 0 automation tests/i.test(output);
  return {
    passed: code === 0 && failing === 0 && (counted || !noTests),
    passing: counted ? passing : null,
    failing: counted ? failing : null,
    failures,
  };
}

/** The project's EngineWire plugin, as the bridge needs it: in Plugins/, or enabled from the engine (Fab). */
export async function unrealPluginState(root: string, project: UnrealProject): Promise<'ok' | 'missing'> {
  const exists = (path: string) => access(path).then(() => true, () => false);
  if (await exists(join(root, project.dir, 'Plugins', 'EngineWire', 'EngineWire.uplugin'))) return 'ok';
  try {
    const parsed = JSON.parse(await readFile(join(root, project.uproject), 'utf8')) as { Plugins?: { Name?: string; Enabled?: boolean }[] };
    if (parsed.Plugins?.some((p) => p.Name === 'EngineWire' && p.Enabled !== false)) return 'ok';
  } catch {
    // Not readable: as if missing.
  }
  return 'missing';
}

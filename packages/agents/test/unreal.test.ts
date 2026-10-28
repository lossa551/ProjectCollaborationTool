import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claudeEngineTool,
  classifyEngineCall,
  engineToolName,
  expectedPrefixes,
  findUnrealProject,
  parseUnrealTestOutput,
  unrealEffect,
  unrealPluginState,
  unrealReceiptChanges,
  unrealTestCommand,
  unrealToRepoPath,
  type UnrealProject,
} from '@pct/agents';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pct-unreal-'));
  dirs.push(dir);
  return dir;
}

const project: UnrealProject = { dir: '', name: 'Shooter', uproject: 'Shooter.uproject' };
const on = (files: string[]) => (path: string) => files.includes(path);
const execute = (tool: string, action: string, params: Record<string, unknown>) => ({ operation: 'execute', tool, action, params });
const classify = (input: unknown, files: string[] = []) =>
  classifyEngineCall('unreal', 'unreal', input, '', '/p', { project, exists: on(files) });

describe('Unreal projects', () => {
  it('finds the .uproject at the top or one folder down', async () => {
    const root = tempDir();
    expect(await findUnrealProject(root)).toBeNull();
    mkdirSync(join(root, 'Game'));
    writeFileSync(join(root, 'Game', 'Shooter.uproject'), '{}');
    expect(await findUnrealProject(root)).toEqual({ dir: 'Game', name: 'Shooter', uproject: 'Game/Shooter.uproject' });
    writeFileSync(join(root, 'Top.uproject'), '{}');
    expect(await findUnrealProject(root)).toEqual({ dir: '', name: 'Top', uproject: 'Top.uproject' });
  });

  it('maps object paths to the files they are saved in', () => {
    expect(unrealToRepoPath('/Game/Shooter/Assets/Rocks/SM_Rock_A', project, on([]))).toBe('Content/Shooter/Assets/Rocks/SM_Rock_A.uasset');
    expect(unrealToRepoPath('/Game/Shooter/Assets/Rocks/SM_Rock_A.SM_Rock_A', project, on([]))).toBe('Content/Shooter/Assets/Rocks/SM_Rock_A.uasset');
    expect(unrealToRepoPath('/Game/Shooter/Envs/L_Main', project, on(['Content/Shooter/Envs/L_Main.umap']))).toBe('Content/Shooter/Envs/L_Main.umap');
    expect(unrealToRepoPath('/Game/Shooter/Envs/L_New', project, on([]), true)).toBe('Content/Shooter/Envs/L_New.umap');
    expect(unrealToRepoPath('/Game/Maps/L.L:PersistentLevel.Door', project, on(['Content/Maps/L.umap']))).toBe('Content/Maps/L.umap');
    expect(unrealToRepoPath('/Engine/BasicShapes/Cube', project, on([]))).toBeNull();
    expect(unrealToRepoPath('/Script/Engine.PointLight', project, on([]))).toBeNull();
    expect(unrealToRepoPath('/Game/../../etc/passwd', project, on([]))).toBeNull();
    // A plugin's content, only when the project has that plugin.
    expect(unrealToRepoPath('/Combat/BP_Sword', project, on([]))).toBeNull();
    expect(unrealToRepoPath('/Combat/BP_Sword', project, on(['Plugins/Combat/Content']))).toBe('Plugins/Combat/Content/BP_Sword.uasset');
    const nested = { dir: 'Game', name: 'Shooter', uproject: 'Game/Shooter.uproject' };
    expect(unrealToRepoPath('/Game/A/T_X', nested, on([]))).toBe('Game/Content/A/T_X.uasset');
  });

  it('knows whether EngineWire is in the project', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'Shooter.uproject'), '{"Plugins":[]}');
    expect(await unrealPluginState(root, project)).toBe('missing');
    writeFileSync(join(root, 'Shooter.uproject'), '{"Plugins":[{"Name":"EngineWire","Enabled":true}]}');
    expect(await unrealPluginState(root, project)).toBe('ok');
    writeFileSync(join(root, 'Shooter.uproject'), '{}');
    mkdirSync(join(root, 'Plugins', 'EngineWire'), { recursive: true });
    writeFileSync(join(root, 'Plugins', 'EngineWire', 'EngineWire.uplugin'), '{}');
    expect(await unrealPluginState(root, project)).toBe('ok');
  });
});

describe('sorting EngineWire calls', () => {
  it('lets search, describe and configure through', () => {
    expect(classify({ operation: 'search', query: 'spawn actor' }).kind).toBe('read');
    expect(classify({ operation: 'describe', tool: 'manage_asset', action: 'delete' }).kind).toBe('read');
    expect(classify({ operation: 'configure', enable: ['gameplay'] }).kind).toBe('read');
  });

  it('uses EngineWire’s own catalog for what a capability does', () => {
    expect(unrealEffect('manage_asset.list')).toBe('read');
    expect(unrealEffect('asset.list')).toBe('read');
    expect(unrealEffect('inspect.get_editor_state')).toBe('read');
    expect(unrealEffect('manage_asset.delete')).toBe('destructive');
    expect(unrealEffect('manage_asset.duplicate')).toBe('write');
    expect(unrealEffect('system_control.execute_python')).toBe('action');
    expect(unrealEffect('control_editor.open_level')).toBe('view');
    expect(unrealEffect('made_up.capability')).toBe('write');
    expect(classify(execute('manage_asset', 'list', { path: '/Game' })).kind).toBe('read');
  });

  it('locks the asset a call changes, and knows which ones are new', () => {
    const existing = 'Content/Shooter/Assets/Rocks/MI_Rock_A.uasset';
    expect(classify(execute('manage_asset', 'set_material_parameter', { assetPath: '/Game/Shooter/Assets/Rocks/MI_Rock_A', parameterName: 'Tint' }), [existing])).toEqual({
      kind: 'edit',
      what: 'Unreal manage_asset.set_material_parameter',
      paths: [existing],
    });
    const made = classify(execute('manage_asset', 'create_material_instance', { name: 'MI_Rock_B', savePath: '/Game/Shooter/Assets/Rocks' }));
    expect(made).toMatchObject({ kind: 'edit', paths: ['Content/Shooter/Assets/Rocks/MI_Rock_B.uasset'], fresh: ['Content/Shooter/Assets/Rocks/MI_Rock_B.uasset'], expected: ['MI_'] });
    // The capability id form works the same.
    expect(classify({ operation: 'execute', capability: 'material.create_material', params: { name: 'M_Rock', path: '/Game/Shooter/Assets/Rocks' } })).toMatchObject({
      paths: ['Content/Shooter/Assets/Rocks/M_Rock.uasset'],
      expected: ['M_', 'PPM_'],
    });
  });

  it('does not lock assets a call only uses', () => {
    // Importing reads the source file; duplicating reads the source asset.
    expect(classify(execute('manage_asset', 'import', { sourcePath: 'C:/art/rock.fbx', destinationPath: '/Game/Shooter/Assets/Rocks/SM_Rock_C' }))).toMatchObject({
      paths: ['Content/Shooter/Assets/Rocks/SM_Rock_C.uasset'],
    });
    expect(
      classify(execute('manage_asset', 'duplicate', { sourcePath: '/Game/Shooter/Assets/Rocks/SM_Rock_A', destinationPath: '/Game/Shooter/Assets/Rocks/SM_Rock_D' }), [
        'Content/Shooter/Assets/Rocks/SM_Rock_A.uasset',
      ]),
    ).toMatchObject({ paths: ['Content/Shooter/Assets/Rocks/SM_Rock_D.uasset'] });
    // Giving an actor a material changes the level, not the material.
    expect(classify(execute('control_actor', 'set_material', { actorName: 'Rock1', materialPath: '/Game/Shooter/Assets/Rocks/MI_Rock_A' })).kind).toBe('action');
  });

  it('locks both ends of a move, and asks a person before a delete', () => {
    const a = 'Content/Shooter/Assets/Rocks/SM_Rock_A.uasset';
    expect(classify(execute('manage_asset', 'move', { sourcePath: '/Game/Shooter/Assets/Rocks/SM_Rock_A', destinationPath: '/Game/Shooter/Assets/Props/SM_Rock_A' }), [a])).toMatchObject({
      kind: 'edit',
      paths: ['Content/Shooter/Assets/Props/SM_Rock_A.uasset', a],
    });
    const del = classify(execute('manage_asset', 'delete', { assetPath: '/Game/Shooter/Assets/Rocks/SM_Rock_A' }), [a]);
    expect(del).toMatchObject({ kind: 'edit', paths: [a], ask: true });
  });

  it('saves levels as .umap', () => {
    expect(classify(execute('manage_level', 'create_level', { levelName: 'L_Arena', savePath: '/Game/Shooter/Envs' }))).toMatchObject({
      paths: ['Content/Shooter/Envs/L_Arena.umap'],
    });
    expect(classify(execute('manage_level', 'save', { levelPath: '/Game/Shooter/Envs/L_Main' }), ['Content/Shooter/Envs/L_Main.umap'])).toMatchObject({
      paths: ['Content/Shooter/Envs/L_Main.umap'],
    });
  });

  it('sends code, whole-project and unnamed level changes to the command rule', () => {
    expect(classify(execute('system_control', 'execute_python', { code: 'print(1)' })).kind).toBe('action');
    expect(classify(execute('system_control', 'console_command', { command: 'stat fps' })).kind).toBe('action');
    expect(classify(execute('control_editor', 'save_all', {})).kind).toBe('action');
    expect(classify(execute('control_actor', 'spawn', { classPath: '/Script/Engine.PointLight', actorName: 'KeyLight' })).kind).toBe('action');
    expect(classify({ operation: 'execute', params: {} }).kind).toBe('action');
  });

  it('reads a 0.5 plugin’s separate tools too', () => {
    expect(classifyEngineCall('unreal', 'manage_asset', { action: 'list', path: '/Game' }, '', '/p', { project, exists: on([]) }).kind).toBe('read');
    expect(classifyEngineCall('unreal', 'manage_asset', { action: 'delete', assetPath: '/Game/X/T_A' }, '', '/p', { project, exists: on([]) })).toMatchObject({
      kind: 'edit',
      ask: true,
    });
  });

  it('names the tool and finds it in Claude Code', () => {
    expect(engineToolName('unreal', 'unreal')).toBe('unreal');
    expect(engineToolName('unreal', 'manage_asset')).toBe('unreal_manage_asset');
    expect(claudeEngineTool('mcp__unreal-engine__unreal')).toEqual({ kind: 'unreal', tool: 'unreal' });
    expect(claudeEngineTool('mcp__engine__unreal')).toEqual({ kind: null, tool: 'unreal' });
  });

  it('knows the prefix Epic gives what a capability makes', () => {
    expect(expectedPrefixes('manage_blueprint.create')).toEqual(['BP_', 'BI_', 'AC_']);
    expect(expectedPrefixes('manage_blueprint.edit_widget_blueprint')).toEqual(['WBP_']);
    expect(expectedPrefixes('animation_physics.create_animation_blueprint')).toEqual(['ABP_']);
    expect(expectedPrefixes('manage_asset.import')).toEqual([]);
  });

  it('reads what the receipt says changed', () => {
    const text = JSON.stringify({ success: true, receipt: { status: 'success', changes: ['/Game/Shooter/Envs/L_Main', 'KeyLight', '/Engine/X'] } });
    expect(unrealReceiptChanges(text)).toEqual(['/Game/Shooter/Envs/L_Main']);
    expect(unrealReceiptChanges('not json')).toEqual([]);
  });
});

describe('Unreal automation tests', () => {
  it('runs them headless from UnrealEditor-Cmd', () => {
    const command = unrealTestCommand('C:/UE_5.8/Engine/Binaries/Win64/UnrealEditor-Cmd.exe', 'C:/Shooter/Shooter.uproject', 'Project.Combat');
    expect(command).toContain('"C:/UE_5.8/Engine/Binaries/Win64/UnrealEditor-Cmd.exe" "C:/Shooter/Shooter.uproject"');
    expect(command).toContain('-ExecCmds="Automation RunTests Project.Combat; Quit"');
    expect(command).toContain('-NullRHI');
    // A filter cannot end the command early.
    expect(unrealTestCommand('ue', 'p', 'X"; rm')).toContain('RunTests X rm; Quit');
  });

  it('reads the results from the log', () => {
    const log = [
      'LogAutomationController: Display: Test Completed. Result={Success} Name={Jump} Path={Project.Movement.Jump}',
      'LogAutomationController: Error: Test Completed. Result={Fail} Name={Damage} Path={Project.Combat.Damage}',
      'LogAutomationController: Display: Test Completed. Result={Success} Name={Walk} Path={Project.Movement.Walk}',
      '**** TEST COMPLETE. EXIT CODE: -1 ****',
    ].join('\n');
    expect(parseUnrealTestOutput(log, 0)).toEqual({ passed: false, passing: 2, failing: 1, failures: ['Project.Combat.Damage'] });
    expect(parseUnrealTestOutput('Test Completed. Result={Success} Name={A} Path={Project.A}\n**** TEST COMPLETE. EXIT CODE: 0 ****', 0)).toMatchObject({
      passed: true,
      passing: 1,
      failing: 0,
    });
    expect(parseUnrealTestOutput('No automation tests matched', 0).passed).toBe(false);
  });
});

describe('new assets in folders', () => {
  it('puts an import into an existing folder under the file’s own name', () => {
    const call = classifyEngineCall(
      'unreal',
      'unreal',
      execute('manage_asset', 'import', { sourcePath: 'Saved/Imports/SM_Crate_A.fbx', destinationPath: '/Game/Shooter/Assets/Props' }),
      '',
      '/p',
      { project, exists: on(['Content/Shooter/Assets/Props']) },
    );
    expect(call).toMatchObject({ kind: 'edit', paths: ['Content/Shooter/Assets/Props/SM_Crate_A.uasset'], fresh: ['Content/Shooter/Assets/Props/SM_Crate_A.uasset'] });
  });
});

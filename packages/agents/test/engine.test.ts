import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  McpClient,
  claudeEngineTool,
  classifyEngineCall,
  describeTests,
  engineToRepoPath,
  engineToolName,
  findGodotProject,
  findTestFramework,
  godotTestCommand,
  parseTestOutput,
  readEngineAnswer,
  seedGodotCache,
} from '@pct/agents';

const fixture = join(import.meta.dirname, 'fixtures', 'fake-engine-mcp.mjs');
const dirs: string[] = [];
const clients: McpClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pct-engine-'));
  dirs.push(dir);
  return dir;
}

describe('engine paths', () => {
  it('maps res:// and plain paths into the Godot project folder, and leaves out user:// and other folders', () => {
    expect(engineToRepoPath('res://scenes/level.tscn', '', '/p')).toBe('scenes/level.tscn');
    expect(engineToRepoPath('res://scenes/level.tscn', 'game', '/p')).toBe('game/scenes/level.tscn');
    expect(engineToRepoPath('scenes/level.tscn', 'game', '/p')).toBe('game/scenes/level.tscn');
    expect(engineToRepoPath('user://save.dat', '', '/p')).toBeNull();
    expect(engineToRepoPath('/p/game/a.tres', 'game', '/p')).toBe('game/a.tres');
    expect(engineToRepoPath('/elsewhere/a.tres', 'game', '/p')).toBeNull();
    expect(engineToRepoPath('res://../outside.tscn', '', '/p')).toBeNull();
  });

  it('finds project.godot at the top or one folder down', async () => {
    const root = tempDir();
    expect(await findGodotProject(root)).toBeNull();
    mkdirSync(join(root, 'game'));
    writeFileSync(join(root, 'game', 'project.godot'), '');
    expect(await findGodotProject(root)).toBe('game');
    writeFileSync(join(root, 'project.godot'), '');
    expect(await findGodotProject(root)).toBe('');
  });
});

describe('sorting engine calls', () => {
  it('sorts the Godot MCP server’s tools into reads, scene edits and actions', () => {
    expect(classifyEngineCall('godot', 'get_debug_output', {}, '', '/p').kind).toBe('read');
    expect(classifyEngineCall('godot', 'create_scene', { projectPath: '/p', scenePath: 'scenes/a.tscn' }, '', '/p')).toEqual({
      kind: 'edit',
      what: 'Godot create_scene',
      paths: ['scenes/a.tscn'],
    });
    expect(classifyEngineCall('godot', 'save_scene', { scenePath: 'a.tscn', newPath: 'b.tscn' }, 'game', '/p')).toMatchObject({ paths: ['game/b.tscn'] });
    expect(classifyEngineCall('godot', 'export_mesh_library', { scenePath: 'a.tscn', outputPath: 'lib.tres' }, '', '/p')).toMatchObject({ paths: ['lib.tres'] });
    expect(classifyEngineCall('godot', 'run_project', {}, '', '/p').kind).toBe('action');
    expect(classifyEngineCall('godot', 'update_project_uids', {}, '', '/p').kind).toBe('action');
  });

  it('sorts Summer operations, by summer_call or their own tool', () => {
    const call = (operation: string, input: Record<string, unknown> = {}) => classifyEngineCall('summer', 'summer_call', { operation, input }, '', '/p');
    expect(call('engine.get_scene_tree').kind).toBe('read');
    expect(call('engine.screenshot').kind).toBe('read');
    expect(call('engine.add_node', { scenePath: 'res://main.tscn', parent: '.', type: 'Node2D', name: 'A' })).toEqual({
      kind: 'edit',
      what: 'Summer engine.add_node',
      paths: ['main.tscn'],
    });
    expect(call('engine.write_file', { path: 'res://scripts/a.gd', content: '' })).toMatchObject({ kind: 'edit', paths: ['scripts/a.gd'] });
    expect(call('engine.project_setting', { name: 'display/window/size' })).toMatchObject({ kind: 'edit', paths: ['project.godot'] });
    expect(call('engine.add_node', { scenePath: 'res://main.tscn', dryRun: true }).kind).toBe('read');
    expect(call('engine.play').kind).toBe('action');
    expect(call('engine.run_editor_script').kind).toBe('action');
    expect(call('store.publish').kind).toBe('action');
    expect(call('jobs.wait').kind).toBe('read');
    expect(classifyEngineCall('summer', 'summer_add_node', { scenePath: 'res://lvl.tscn' }, 'game', '/p')).toMatchObject({ kind: 'edit', paths: ['game/lvl.tscn'] });
    expect(classifyEngineCall('summer', 'summer_search', { query: 'add a light' }, '', '/p').kind).toBe('read');
    // A write with no file named is an action: whatever it changed is reviewed afterwards.
    expect(call('engine.add_node').kind).toBe('action');
  });

  it('knows Claude Code’s names for engine tools', () => {
    expect(claudeEngineTool('mcp__engine__create_scene')).toEqual({ kind: null, tool: 'create_scene' });
    expect(claudeEngineTool('mcp__summer-engine__summer_call')).toEqual({ kind: 'summer', tool: 'summer_call' });
    expect(claudeEngineTool('mcp__godot__add_node')).toEqual({ kind: 'godot', tool: 'add_node' });
    expect(claudeEngineTool('mcp__github__create_issue')).toBeNull();
    expect(claudeEngineTool('Bash')).toBeNull();
    expect(engineToolName('godot', 'create_scene')).toBe('godot_create_scene');
    expect(engineToolName('summer', 'summer_call')).toBe('summer_call');
  });
});

describe('Summer answers', () => {
  it('reads stale overwrite refusals, approvals and write receipts', () => {
    const conflict = readEngineAnswer(JSON.stringify({ ok: false, error: { code: 'conflict', message: 'The thing changed since it was read.', next: 'engine.read_file', retry: 'no' } }));
    expect(conflict.conflict).toBe('The thing changed since it was read.');
    expect(conflict.error).toMatchObject({ code: 'conflict', next: 'engine.read_file' });
    const approval = readEngineAnswer(JSON.stringify({ ok: true, status: 'needs_approval', approval: { url: 'https://summerengine.com/a/1' }, job: { id: 'j' } }));
    expect(approval.approvalUrl).toBe('https://summerengine.com/a/1');
    const receipt = readEngineAnswer(JSON.stringify({ ok: true, status: 'done', result: { receipts: [{ path: 'res://a.gd', sha256: 'abc' }, { path: 'res://b.tscn', bytes: 10 }] } }));
    expect(receipt.receipts).toEqual(['res://a.gd', 'res://b.tscn']);
    expect(readEngineAnswer('Scene created').receipts).toEqual([]);
  });
});

describe('Godot tests', () => {
  it('finds GUT or gdUnit4 and builds the headless command', async () => {
    const dir = tempDir();
    expect(await findTestFramework(dir)).toBeNull();
    mkdirSync(join(dir, 'addons', 'gut'), { recursive: true });
    writeFileSync(join(dir, 'addons', 'gut', 'gut_cmdln.gd'), '');
    expect(await findTestFramework(dir)).toBe('gut');
    const command = await godotTestCommand('/opt/godot', dir, 'gut');
    expect(command).toContain('/opt/godot --headless --path');
    expect(command).toContain('-s addons/gut/gut_cmdln.gd -gexit -gdir=res://test -ginclude_subdirs');
    expect(await godotTestCommand('/opt/godot', dir, 'gut', 'res://test/test_jump.gd')).toContain('-gtest=res://test/test_jump.gd');
    expect(await godotTestCommand('/opt/godot', dir, 'gdunit4')).toContain('GdUnitCmdTool.gd --ignoreHeadlessMode -a res://test');
  });

  it('reads GUT’s and gdUnit4’s summaries', () => {
    const gut = parseTestOutput(
      ['* test_double_jump', '    [Failed]:  expected 2 got 1', '* test_walk', '---- Totals ----', 'Scripts           1', 'Tests             2', 'Passing Tests     1', 'Failing Tests     1'].join('\n'),
      1,
    );
    expect(gut).toEqual({ passed: false, passing: 1, failing: 1, failures: ['test_double_jump'] });
    expect(describeTests(gut)).toBe('Tests failed (1 passing, 1 failing). Failing: test_double_jump.');
    const unit = parseTestOutput('Overall Summary: 5 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 0 orphans |', 0);
    expect(unit).toMatchObject({ passed: true, passing: 5, failing: 0 });
    expect(parseTestOutput('no summary here', 0).passed).toBe(true);
  });
});

describe('agent copies', () => {
  it('start with the project folder’s Godot import cache, but not its editor layout', async () => {
    const root = tempDir();
    const copy = tempDir();
    writeFileSync(join(root, 'project.godot'), '');
    mkdirSync(join(root, '.godot', 'imported'), { recursive: true });
    mkdirSync(join(root, '.godot', 'editor'), { recursive: true });
    writeFileSync(join(root, '.godot', 'imported', 'hero.png-1.ctex'), 'x');
    writeFileSync(join(root, '.godot', 'editor', 'layout.cfg'), 'x');
    writeFileSync(join(copy, 'project.godot'), '');
    expect(await seedGodotCache(root, copy)).toBe(true);
    expect(existsSync(join(copy, '.godot', 'imported', 'hero.png-1.ctex'))).toBe(true);
    expect(existsSync(join(copy, '.godot', 'editor'))).toBe(false);
    expect(await seedGodotCache(root, copy)).toBe(false);
  });
});

describe('MCP client', () => {
  it('starts a stdio server, lists its tools and calls one', async () => {
    const dir = tempDir();
    const client = new McpClient({ command: process.execPath, args: [fixture], env: { FAKE_KIND: 'godot' } }, { label: 'Fake engine' });
    clients.push(client);
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['get_godot_version', 'create_scene', 'run_project']);
    expect(await client.callTool('get_godot_version', {})).toEqual({ text: '4.5.1.stable', isError: false });
    await client.callTool('create_scene', { projectPath: dir, scenePath: 'res://a.tscn' });
    expect(existsSync(join(dir, 'a.tscn'))).toBe(true);
  });

  it('says why when the server cannot start', async () => {
    const client = new McpClient({ command: process.execPath, args: ['-e', 'console.error("no engine here"); process.exit(3)'] }, { label: 'Fake engine' });
    clients.push(client);
    await expect(client.listTools()).rejects.toThrow(/Fake engine stopped \(exit code 3\): no engine here/);
  });
});

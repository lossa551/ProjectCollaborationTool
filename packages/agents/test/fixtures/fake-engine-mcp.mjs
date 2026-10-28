// A stand-in for an engine's MCP server in tests: FAKE_KIND=godot answers like
// the Godot MCP server (create_scene writes the scene into projectPath),
// FAKE_KIND=summer like Summer's (summer_call, with receipts and a stale
// overwrite refusal), FAKE_KIND=unreal like EngineWire's `unreal` gateway
// (execute saves the asset it names under FAKE_ROOT/Content and lists it, and
// params.alsoChanged, in receipt.changes). Every call is appended to FAKE_LOG.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const kind = process.env.FAKE_KIND ?? 'godot';
const log = (entry) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

const tools =
  kind === 'godot'
    ? [
        { name: 'get_godot_version', description: 'Godot version', inputSchema: { type: 'object', properties: {} } },
        {
          name: 'create_scene',
          description: 'Create a scene',
          inputSchema: { type: 'object', properties: { projectPath: { type: 'string' }, scenePath: { type: 'string' } }, required: ['projectPath', 'scenePath'] },
        },
        { name: 'run_project', description: 'Run the game', inputSchema: { type: 'object', properties: { projectPath: { type: 'string' } } } },
      ]
    : kind === 'unreal'
      ? [{ name: 'unreal', description: 'Unreal Engine editor: operation search, describe, execute or configure.', inputSchema: { type: 'object', properties: { operation: { type: 'string' } }, required: ['operation'] } }]
      : [
        { name: 'summer_call', description: 'Run a Summer operation', inputSchema: { type: 'object', properties: { operation: { type: 'string' }, input: { type: 'object' } } } },
      ];

// Logs on stdout that are not JSON must not break the client.
console.log('fake engine server starting');

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  if (message.method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools } });
  if (message.method !== 'tools/call') return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown' } });
  const { name, arguments: args } = message.params;
  log({ name, args });
  let result;
  if (name === 'create_scene') {
    const file = join(args.projectPath, args.scenePath.replace(/^res:\/\//, ''));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '[gd_scene format=3]\n\n[node name="Root" type="Node2D"]\n');
    result = text(`Scene created at ${args.scenePath}`);
  } else if (name === 'unreal') {
    const params = args.params ?? {};
    if (args.operation !== 'execute') {
      result = text({ success: true, rows: [] });
    } else {
      const target = params.assetPath ?? (params.name && params.savePath ? `${params.savePath}/${params.name}` : null);
      if (target) {
        const file = join(process.env.FAKE_ROOT, 'Content', `${target.replace(/^\/Game\//, '')}.uasset`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, 'uasset');
      }
      const changes = [target, ...(params.alsoChanged ? [params.alsoChanged] : [])].filter(Boolean);
      result = text({ success: true, data: { assetPath: target }, receipt: { status: 'success', capabilityId: `${args.tool}.${args.action}`, changes } });
    }
  } else if (name === 'get_godot_version') {
    result = text('4.5.1.stable');
  } else if (name === 'summer_call') {
    const input = args.input ?? {};
    if (args.operation === 'engine.write_file' && input.expected_sha256 === 'old') {
      result = text({ ok: false, error: { code: 'conflict', message: 'The thing changed since it was read. Read it again, then retry.', retry: 'no' } });
    } else if (args.operation === 'engine.write_file') {
      const file = join(process.env.FAKE_ROOT, input.path.replace(/^res:\/\//, ''));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, input.content ?? '');
      result = text({ ok: true, status: 'done', result: { receipt: { path: input.path, sha256: 'abc123', bytes: (input.content ?? '').length } } });
    } else {
      result = text({ ok: true, status: 'done', result: {} });
    }
  } else {
    result = text('ok');
  }
  send({ jsonrpc: '2.0', id: message.id, result });
});

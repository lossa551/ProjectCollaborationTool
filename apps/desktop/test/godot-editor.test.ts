import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GODOT_LOCKS_FILE, GODOT_PLUGIN_CFG, GODOT_PLUGIN_CFG_PATH, GODOT_REQUESTS_FILE, type Lock, type SessionState } from '@pct/shared';
import { GodotEditorLink } from '../src/main/godot-editor';

const dirs: string[] = [];
const links: GodotEditorLink[] = [];
afterEach(() => {
  for (const link of links.splice(0)) link.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(withPlugin = true) {
  const root = mkdtempSync(join(tmpdir(), 'pct-godot-editor-'));
  dirs.push(root);
  mkdirSync(join(root, 'game', 'addons', 'collab_tool'), { recursive: true });
  writeFileSync(join(root, 'game', 'project.godot'), 'config_version=5\n');
  if (withPlugin) writeFileSync(join(root, 'game', ...GODOT_PLUGIN_CFG_PATH.split('/')), GODOT_PLUGIN_CFG);
  return root;
}

const lock = (id: string, path: string, holder: { id: string; name: string }, kind: Lock['kind'] = 'exclusive'): Lock =>
  ({ id, path, holder, kind, reason: 'Level art', taskId: null, chatId: null, acquiredAt: 1, abandoned: false }) as unknown as Lock;

const state = (locks: Lock[]): SessionState =>
  ({ status: 'connected', you: { id: 'me', name: 'Martin' }, locks }) as unknown as SessionState;

describe('Godot editor plugin link', () => {
  it('writes the session’s locks inside the Godot project as res:// paths', async () => {
    const root = project();
    const link = new GodotEditorLink({ lock: () => {}, release: () => {} });
    links.push(link);
    await link.update(root, state([
      lock('l1', 'game/levels/one.tscn', { id: 'friend', name: 'Sam' }),
      lock('l2', 'game/player.gd', { id: 'me', name: 'Martin' }, 'soft'),
      lock('l3', 'docs/plan.md', { id: 'friend', name: 'Sam' }),
    ]));
    const written = JSON.parse(readFileSync(join(root, 'game', ...GODOT_LOCKS_FILE.split('/')), 'utf8'));
    expect(written).toEqual({
      you: 'Martin',
      connected: true,
      locks: [
        { path: 'res://levels/one.tscn', holder: 'Sam', exclusive: true, mine: false, reason: 'Level art' },
        { path: 'res://player.gd', holder: 'Martin', exclusive: false, mine: true, reason: 'Level art' },
      ],
    });
  });

  it('locks and releases what the plugin asks for, once', async () => {
    const root = project();
    const asked: string[] = [];
    const link = new GodotEditorLink({ lock: (path) => asked.push(`lock ${path}`), release: (id) => asked.push(`release ${id}`) });
    links.push(link);
    await link.update(root, state([lock('l2', 'game/player.gd', { id: 'me', name: 'Martin' })]));
    const requests = join(root, 'game', ...GODOT_REQUESTS_FILE.split('/'));
    writeFileSync(requests, '{"action":"lock","path":"res://levels/one.tscn"}\n{"action":"release","path":"res://player.gd"}\n');
    link.readRequests();
    link.readRequests();
    expect(asked).toEqual(['lock game/levels/one.tscn', 'release l2']);
    expect(readFileSync(requests, 'utf8')).toBe('');
  });

  it('does nothing for a project without the plugin', async () => {
    const root = project(false);
    const link = new GodotEditorLink({ lock: () => {}, release: () => {} });
    links.push(link);
    await link.update(root, state([lock('l1', 'game/a.tscn', { id: 'friend', name: 'Sam' })]));
    expect(() => readFileSync(join(root, 'game', ...GODOT_LOCKS_FILE.split('/')))).toThrow();
  });
});

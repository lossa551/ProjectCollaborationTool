import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EditorHeartbeat } from '@pct/shared';
import type { EngineEditor } from '../src/common/api';
import { currentEditor, editorEvent, editorProgram, pickBridge, type BridgeFacts } from '../src/main/engine-auto';
import { editorKind, isEditorCommand, parsePs, parseTasklist, pickGodot, pickUnreal, uprojectIn } from '../src/main/programs';

const facts = (over: Partial<BridgeFacts> = {}): BridgeFacts => ({
  godotProject: true,
  node: true,
  summerSignedIn: true,
  editor: null,
  summerRunning: false,
  ...over,
});
const open = (kind: 'godot' | 'summer', scene: string | null = null): EngineEditor => ({ kind, projectOpen: true, scene, version: null });
const beat = (over: Partial<EditorHeartbeat> = {}): EditorHeartbeat => ({
  editor: 'godot',
  program: 'C:\\Godot\\Godot_v4.5.1-stable_win64.exe',
  version: '4.5.1.stable',
  pid: 42,
  scene: 'res://levels/one.tscn',
  at: 1,
  ...over,
});

describe('engine on its own', () => {
  it('is on by default with a Godot project, and picks Summer while Summer Engine is open', () => {
    expect(pickBridge('auto', facts()).active).toBe('godot');
    expect(pickBridge('auto', facts({ editor: open('summer') }))).toEqual({ active: 'summer', why: 'Summer Engine has your project open.' });
    expect(pickBridge('auto', facts({ summerRunning: true })).active).toBe('summer');
    // Not signed in: Summer's server would fail, so Godot's is used.
    expect(pickBridge('auto', facts({ editor: open('summer'), summerSignedIn: false })).active).toBe('godot');
    expect(pickBridge('auto', facts({ godotProject: false })).active).toBeNull();
    expect(pickBridge('auto', facts({ node: false })).why).toMatch(/Node.js/);
    expect(pickBridge('summer', facts()).active).toBe('summer');
    expect(pickBridge('off', facts({ editor: open('summer') })).active).toBeNull();
  });

  it('shows the editor the plugin says has the project open, else one that is running', () => {
    const toRepo = (res: string) => `game/${res.slice('res://'.length)}`;
    expect(currentEditor(beat(), [], toRepo)).toEqual({ kind: 'godot', projectOpen: true, scene: 'game/levels/one.tscn', version: '4.5.1.stable' });
    expect(currentEditor(beat({ scene: '' }), [], toRepo)?.scene).toBeNull();
    expect(currentEditor(null, [{ kind: 'godot', pid: 1, program: null }, { kind: 'summer', pid: 2, program: null }], toRepo)).toEqual({
      kind: 'summer',
      projectOpen: false,
      scene: null,
      version: null,
    });
    expect(currentEditor(null, [], toRepo)).toBeNull();
  });

  it('takes Godot’s program from the editor you run', () => {
    expect(editorProgram(beat(), [])).toBe('C:\\Godot\\Godot_v4.5.1-stable_win64.exe');
    expect(editorProgram(beat({ editor: 'summer' }), [{ kind: 'godot', pid: 3, program: '/opt/godot/godot' }])).toBe('/opt/godot/godot');
    expect(editorProgram(null, [{ kind: 'summer', pid: 3, program: '/x/Summer' }])).toBeNull();
  });

  it('tells opening, closing and another scene apart', () => {
    const running: EngineEditor = { kind: 'godot', projectOpen: false, scene: null, version: null };
    expect(editorEvent(null, open('godot'))?.kind).toBe('opened');
    expect(editorEvent(running, open('godot'))?.kind).toBe('opened');
    expect(editorEvent(open('godot', 'a.tscn'), open('godot', 'b.tscn'))?.kind).toBe('scene');
    expect(editorEvent(open('godot', 'a.tscn'), open('godot', 'a.tscn'))).toBeNull();
    expect(editorEvent(open('godot'), null)?.kind).toBe('closed');
    expect(editorEvent(null, running)).toBeNull();
  });
});

describe('programs on this PC', () => {
  it('knows editor processes, and leaves out headless Godot and the MCP servers', () => {
    expect(editorKind('Godot_v4.5.1-stable_win64.exe')).toBe('godot');
    expect(editorKind('godot.windows.opt.tools.64.exe')).toBe('godot');
    expect(editorKind('/home/me/godot/Godot_v4.5.1-stable_linux.x86_64')).toBe('godot');
    expect(editorKind('Summer Engine.exe')).toBe('summer');
    expect(editorKind('node.exe')).toBeNull();
    expect(editorKind('godot-mcp')).toBeNull();
    expect(isEditorCommand('"C:\\Godot\\Godot.exe" --path D:\\game --editor')).toBe(true);
    expect(isEditorCommand('godot --headless --path /tmp/copy -s addons/gut/gut_cmdln.gd')).toBe(false);
    expect(isEditorCommand('godot --export-release "Windows Desktop" out.exe')).toBe(false);
  });

  it('reads the process lists of Windows and ps', () => {
    expect(parseTasklist('"System Idle Process","0","Services","0","8 K"\r\n"Godot_v4.5.1-stable_win64.exe","9120","Console","1","310,000 K"\r\n')).toEqual([
      { name: 'System Idle Process', pid: 0 },
      { name: 'Godot_v4.5.1-stable_win64.exe', pid: 9120 },
    ]);
    expect(parsePs('    1 /sbin/init\n 4242 /opt/godot/godot --editor --path /home/me/game\n')).toEqual([
      { pid: 1, args: '/sbin/init' },
      { pid: 4242, args: '/opt/godot/godot --editor --path /home/me/game' },
    ]);
  });

  it('picks the newest Godot editor, not its console wrapper', () => {
    expect(
      pickGodot([
        'C:\\Users\\me\\Downloads\\Godot_v4.3-stable_win64.exe',
        'C:\\Users\\me\\Downloads\\Godot_v4.5.1-stable_win64_console.exe',
        'C:\\Users\\me\\Downloads\\Godot_v4.5.1-stable_win64.exe',
        'C:\\Users\\me\\Downloads\\notes.txt',
      ]),
    ).toBe('C:\\Users\\me\\Downloads\\Godot_v4.5.1-stable_win64.exe');
    expect(pickGodot([])).toBeNull();
  });
});

describe('Unreal on this PC', () => {
  const unrealFacts = (over: Partial<BridgeFacts> = {}): BridgeFacts =>
    facts({ godotProject: false, unrealProject: true, unrealPlugin: 'ok', ...over });

  it('gives agents EngineWire for an Unreal project, once the plugin is there', () => {
    expect(pickBridge('auto', unrealFacts())).toEqual({ active: 'unreal', why: 'Agents reach the Unreal Editor once it has your project open.' });
    expect(pickBridge('auto', unrealFacts({ editor: { kind: 'unreal', projectOpen: true, scene: null, version: null } })).why).toBe(
      'The Unreal Editor has your project open.',
    );
    expect(pickBridge('unreal', unrealFacts()).active).toBe('unreal');
    expect(pickBridge('auto', unrealFacts({ unrealPlugin: 'missing' })).why).toMatch(/Add EngineWire/);
    expect(pickBridge('auto', unrealFacts({ node: false })).active).toBeNull();
    expect(pickBridge('godot', unrealFacts()).active).toBeNull();
    expect(pickBridge('off', unrealFacts()).active).toBeNull();
    // EngineWire does not fit a Godot project.
    expect(pickBridge('unreal', facts()).active).toBeNull();
  });

  it('sees the Unreal Editor open your project from its command line', () => {
    const toRepo = (res: string) => res;
    const running = [{ kind: 'unreal' as const, pid: 7, program: 'C:\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor.exe', project: 'D:\\Games\\Shooter\\Shooter.uproject' }];
    expect(currentEditor(null, running, toRepo, 'D:/Games/Shooter/Shooter.uproject')).toEqual({ kind: 'unreal', projectOpen: true, scene: null, version: null });
    expect(currentEditor(null, running, toRepo, 'D:/Games/Other/Other.uproject')).toEqual({ kind: 'unreal', projectOpen: false, scene: null, version: null });
    // In a Godot project, a running Unreal Editor is not the one shown.
    expect(currentEditor(null, [...running, { kind: 'godot', pid: 8, program: null }], toRepo)?.kind).toBe('godot');
  });

  it('knows the Unreal Editor’s process and the project it opened', () => {
    expect(editorKind('UnrealEditor.exe')).toBe('unreal');
    expect(editorKind('C:\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe')).toBeNull();
    expect(uprojectIn('"C:\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor.exe" "D:\\My Games\\Shooter\\Shooter.uproject" -skipcompile')).toBe(
      'D:\\My Games\\Shooter\\Shooter.uproject',
    );
    expect(uprojectIn('/opt/ue/UnrealEditor /home/m/Shooter/Shooter.uproject')).toBe('/home/m/Shooter/Shooter.uproject');
    expect(uprojectIn('UnrealEditor.exe')).toBeNull();
    expect(isEditorCommand('UnrealEditor.exe D:\\S\\S.uproject -run=ResavePackages')).toBe(false);
    expect(isEditorCommand('UnrealEditor.exe D:\\S\\S.uproject')).toBe(true);
  });

  it('picks the engine the .uproject asks for', () => {
    const root = mkdtempSync(join(tmpdir(), 'pct-ue-'));
    try {
      const make = (name: string) => {
        const dir = join(root, name);
        const bin = join(dir, 'Engine', 'Binaries', process.platform === 'win32' ? 'Win64' : process.platform === 'darwin' ? 'Mac' : 'Linux');
        mkdirSync(bin, { recursive: true });
        const cmd = join(bin, process.platform === 'win32' ? 'UnrealEditor-Cmd.exe' : 'UnrealEditor-Cmd');
        writeFileSync(cmd, '');
        return { dir, cmd };
      };
      const ue57 = make('UE_5.7');
      const ue58 = make('UE_5.8');
      const installs = new Map([
        ['5.7', ue57.dir],
        ['5.8', ue58.dir],
      ]);
      expect(pickUnreal('5.8', installs, null)).toBe(ue58.cmd);
      expect(pickUnreal('5.7', installs, null)).toBe(ue57.cmd);
      expect(pickUnreal(null, installs, null)).toBe(ue58.cmd);
      expect(pickUnreal('5.9', installs, null)).toBeNull();
      // The editor you run wins: its own folder has UnrealEditor-Cmd.
      expect(pickUnreal('5.8', installs, join(dirname(ue57.cmd), 'UnrealEditor.exe'))).toBe(ue57.cmd);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

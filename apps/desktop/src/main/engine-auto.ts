import type { EditorHeartbeat } from '@pct/shared';
import type { EngineBridgeChoice, EngineEditor } from '../common/api';
import type { RunningEditor } from './programs';

// What the app does on its own with the game engine (follow-up to issue #10):
// which MCP server agents get when the choice is "auto", and which editor
// counts as open. Plain functions, so the rules are tested without Electron.

export interface BridgeFacts {
  godotProject: boolean;
  /** Your project folder has a .uproject (and no project.godot). */
  unrealProject?: boolean;
  /** EngineWire is in the Unreal project. */
  unrealPlugin?: 'ok' | 'missing' | null;
  /** null: not checked yet. */
  node: boolean | null;
  summerSignedIn: boolean;
  editor: EngineEditor | null;
  /** Summer Engine runs on this PC, with or without your project. */
  summerRunning: boolean;
}

export function pickBridge(choice: EngineBridgeChoice, facts: BridgeFacts): { active: 'godot' | 'summer' | 'unreal' | null; why: string } {
  if (choice === 'off') return { active: null, why: 'Turned off here.' };
  if (!facts.godotProject && facts.unrealProject) {
    // Unreal (issue #11): EngineWire is the one bridge; Godot's and Summer's do not fit.
    if (choice !== 'auto' && choice !== 'unreal') return { active: null, why: `Your project is an Unreal project; ${choice === 'godot' ? 'the Godot MCP server' : 'Summer Engine'} does not fit it.` };
    if (facts.node === false) return { active: null, why: 'Node.js is not installed; the app starts EngineWire’s MCP server with npx.' };
    if (facts.unrealPlugin !== 'ok') return { active: null, why: 'Add EngineWire to your project first: agents reach the Unreal Editor through it.' };
    const open = facts.editor?.kind === 'unreal' && facts.editor.projectOpen;
    return { active: 'unreal', why: open ? 'The Unreal Editor has your project open.' : 'Agents reach the Unreal Editor once it has your project open.' };
  }
  if (choice === 'unreal') return { active: null, why: 'Your project folder has no .uproject.' };
  if (!facts.godotProject) return { active: null, why: 'Your project folder has no project.godot yet.' };
  if (facts.node === false) return { active: null, why: 'Node.js is not installed; the app starts the engine’s MCP server with npx.' };
  if (choice !== 'auto') return { active: choice, why: 'Chosen here.' };
  const summerOpen = facts.editor?.kind === 'summer' && facts.editor.projectOpen;
  if (summerOpen || facts.summerRunning) {
    if (facts.summerSignedIn) return { active: 'summer', why: summerOpen ? 'Summer Engine has your project open.' : 'Summer Engine is running.' };
    return { active: 'godot', why: 'Summer Engine is open but not signed in for agents, so the Godot MCP server is used.' };
  }
  return { active: 'godot', why: 'Summer Engine is not open, so agents use the Godot MCP server.' };
}

/**
 * The editor to show: the one the Locks plugin says has your project open,
 * else a running one (which may have another project, or none, open).
 */
export function currentEditor(
  beat: EditorHeartbeat | null,
  running: RunningEditor[],
  toRepoPath: (res: string) => string | null,
  uproject: string | null = null,
): EngineEditor | null {
  if (beat) {
    return { kind: beat.editor, projectOpen: true, scene: beat.scene ? toRepoPath(beat.scene) : null, version: beat.version || null };
  }
  // Unreal: the command line names the .uproject it opened (absolute, as the launcher passes it).
  const unreal = running.filter((e) => e.kind === 'unreal');
  const ours = uproject ? unreal.find((e) => e.project && sameFile(e.project, uproject)) : undefined;
  if (ours) return { kind: 'unreal', projectOpen: true, scene: null, version: null };
  const first = running.find((e) => e.kind === 'summer') ?? (uproject ? unreal[0] : undefined) ?? running.find((e) => e.kind !== 'unreal') ?? running[0];
  return first ? { kind: first.kind, projectOpen: false, scene: null, version: null } : null;
}

/** The same file, however Windows spells it. */
const sameFile = (a: string, b: string) => {
  const clean = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' || /^[a-z]:/i.test(a) ? clean(a).toLowerCase() === clean(b).toLowerCase() : clean(a) === clean(b);
};

/** A Godot program seen running as an editor, to run tests with when none is chosen. */
export function editorProgram(beat: EditorHeartbeat | null, running: RunningEditor[]): string | null {
  if (beat?.editor === 'godot' && beat.program) return beat.program;
  return running.find((e) => e.kind === 'godot' && e.program)?.program ?? null;
}

/** Something that happened with the editor that is worth telling you about. */
export type EditorEvent =
  | { kind: 'opened'; editor: EngineEditor }
  | { kind: 'closed'; editor: EngineEditor }
  | { kind: 'scene'; editor: EngineEditor };

export function editorEvent(before: EngineEditor | null, after: EngineEditor | null): EditorEvent | null {
  const open = (e: EngineEditor | null) => !!e && e.projectOpen;
  if (!open(before) && open(after)) return { kind: 'opened', editor: after! };
  if (open(before) && !open(after)) return { kind: 'closed', editor: before! };
  if (open(after) && before!.scene !== after!.scene && after!.scene) return { kind: 'scene', editor: after! };
  return null;
}

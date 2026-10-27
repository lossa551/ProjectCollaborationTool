import type { EditorHeartbeat } from '@pct/shared';
import type { EngineBridgeChoice, EngineEditor } from '../common/api';
import type { RunningEditor } from './programs';

// What the app does on its own with the game engine (follow-up to issue #10):
// which MCP server agents get when the choice is "auto", and which editor
// counts as open. Plain functions, so the rules are tested without Electron.

export interface BridgeFacts {
  godotProject: boolean;
  /** null: not checked yet. */
  node: boolean | null;
  summerSignedIn: boolean;
  editor: EngineEditor | null;
  /** Summer Engine runs on this PC, with or without your project. */
  summerRunning: boolean;
}

export function pickBridge(choice: EngineBridgeChoice, facts: BridgeFacts): { active: 'godot' | 'summer' | null; why: string } {
  if (choice === 'off') return { active: null, why: 'Turned off here.' };
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
export function currentEditor(beat: EditorHeartbeat | null, running: RunningEditor[], toRepoPath: (res: string) => string | null): EngineEditor | null {
  if (beat) {
    return { kind: beat.editor, projectOpen: true, scene: beat.scene ? toRepoPath(beat.scene) : null, version: beat.version || null };
  }
  const first = running.find((e) => e.kind === 'summer') ?? running[0];
  return first ? { kind: first.kind, projectOpen: false, scene: null, version: null } : null;
}

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

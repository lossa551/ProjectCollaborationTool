import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findGodotProject } from '@pct/agents';
import {
  GODOT_EDITOR_BEAT_S,
  GODOT_EDITOR_FILE,
  GODOT_LOCKS_FILE,
  GODOT_PLUGIN_CFG_PATH,
  GODOT_REQUESTS_FILE,
  parseEditorHeartbeat,
  parseEditorRequests,
  samePath,
  type EditorHeartbeat,
  type EditorLocks,
  type SessionState,
} from '@pct/shared';

// The app's side of the Godot editor plugin (issue #10): keeps the session's
// locks in .godot/collab_tool/locks.json of your project folder, where the
// plugin's Locks dock reads them, and carries out what the plugin asks for
// ("Lock this scene", "Release this scene"), and notices when the editor
// opens or closes the project (the plugin's editor.json). Only for a project
// that has the plugin; .godot/ is never committed.

const REQUEST_POLL_MS = 1500;
const LOOK_AGAIN_MS = 10_000;

/** The plugin's heartbeat counts as gone after this many missed beats (the editor crashed or was killed). */
const MISSED_BEATS = 5;

export interface EditorActions {
  lock(path: string): void;
  release(lockId: string): void;
  /** The editor opened or closed the project, or opened another scene. */
  editorChanged?(editor: EditorHeartbeat | null): void;
}

/** Whether a process is still running on this PC. */
function alive(pid: number): boolean {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class GodotEditorLink {
  private folder: string | null = null;
  /** The project.godot folder (repo-relative) once looked up; null when there is no project with the plugin. */
  private godotDir: string | null = null;
  private written = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: SessionState | null = null;
  private lookedAt = 0;
  private editor: EditorHeartbeat | null = null;

  constructor(
    private readonly actions: EditorActions,
    private readonly now: () => number = Date.now,
  ) {}

  /** The editor that has the project open now, from the plugin's heartbeat. */
  openEditor(): EditorHeartbeat | null {
    return this.editor;
  }

  /** The project.godot folder (repo-relative) with the plugin; null when there is none. */
  projectDir(): string | null {
    return this.godotDir;
  }

  /** Your project folder changed, or the session did. */
  async update(folder: string | null, state: SessionState): Promise<void> {
    this.state = state;
    // Looked up again now and then, so a plugin added by project setup is found.
    if (folder !== this.folder || (this.godotDir === null && folder && Date.now() - this.lookedAt > LOOK_AGAIN_MS)) {
      this.folder = folder;
      this.written = '';
      this.lookedAt = Date.now();
      const dir = folder ? await findGodotProject(folder) : null;
      // Changed again while looking: the newer call takes over.
      if (this.folder !== folder) return;
      this.godotDir = dir !== null && folder && existsSync(join(folder, dir, ...GODOT_PLUGIN_CFG_PATH.split('/'))) ? dir : null;
      this.poll(this.godotDir !== null);
      this.readEditor();
    }
    this.writeLocks();
  }

  stop() {
    this.poll(false);
    this.folder = null;
    this.godotDir = null;
    this.setEditor(null);
  }

  /** Reads the plugin's heartbeat: the editor has the project open while it is fresh. */
  readEditor() {
    const file = this.projectFile(GODOT_EDITOR_FILE);
    let beat: EditorHeartbeat | null = null;
    try {
      beat = file ? parseEditorHeartbeat(readFileSync(file, 'utf8')) : null;
    } catch {
      beat = null;
    }
    const fresh = beat && this.now() / 1000 - beat.at < GODOT_EDITOR_BEAT_S * MISSED_BEATS && alive(beat.pid) ? beat : null;
    this.setEditor(fresh);
  }

  private setEditor(editor: EditorHeartbeat | null) {
    const before = this.editor;
    this.editor = editor;
    const same = before === editor || (!!before && !!editor && before.editor === editor.editor && before.pid === editor.pid && before.scene === editor.scene);
    if (!same) this.actions.editorChanged?.(editor);
  }

  private projectFile(path: string): string | null {
    if (!this.folder || this.godotDir === null) return null;
    return join(this.folder, ...this.godotDir.split('/').filter(Boolean), ...path.split('/'));
  }

  private toRes(path: string): string | null {
    const dir = this.godotDir;
    if (dir === null) return null;
    if (!dir) return `res://${path}`;
    return path.toLowerCase().startsWith(`${dir.toLowerCase()}/`) ? `res://${path.slice(dir.length + 1)}` : null;
  }

  private fromRes(res: string): string {
    const rel = res.replace(/^res:\/\//, '');
    return this.godotDir ? `${this.godotDir}/${rel}` : rel;
  }

  private writeLocks() {
    const file = this.projectFile(GODOT_LOCKS_FILE);
    const state = this.state;
    if (!file || !state) return;
    const you = state.you;
    const content: EditorLocks = {
      you: you?.name ?? '',
      connected: state.status === 'connected',
      locks: state.locks.flatMap((lock) => {
        const path = this.toRes(lock.path);
        if (!path) return [];
        return [{ path, holder: lock.holder.name, exclusive: lock.kind === 'exclusive', mine: lock.holder.id === you?.id, reason: lock.reason ?? '' }];
      }),
    };
    const text = `${JSON.stringify(content, null, 2)}\n`;
    if (text === this.written) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, text);
      renameSync(`${file}.tmp`, file);
      this.written = text;
    } catch {
      // The folder went away or is read-only: try again with the next change.
    }
  }

  private poll(on: boolean) {
    if (this.timer) clearInterval(this.timer);
    this.timer = on
      ? setInterval(() => {
          this.readRequests();
          this.readEditor();
        }, REQUEST_POLL_MS)
      : null;
  }

  /** Carries out what the plugin asked for, then empties the file. */
  readRequests() {
    const file = this.projectFile(GODOT_REQUESTS_FILE);
    const state = this.state;
    if (!file || !state || state.status !== 'connected') return;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    if (!text.trim()) return;
    writeFileSync(file, '');
    for (const request of parseEditorRequests(text)) {
      const path = this.fromRes(request.path);
      if (request.action === 'lock') this.actions.lock(path);
      else {
        const mine = state.locks.find((l) => l.holder.id === state.you?.id && samePath(l.path, path));
        if (mine) this.actions.release(mine.id);
      }
    }
  }
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findGodotProject } from '@pct/agents';
import {
  GODOT_LOCKS_FILE,
  GODOT_PLUGIN_CFG_PATH,
  GODOT_REQUESTS_FILE,
  parseEditorRequests,
  samePath,
  type EditorLocks,
  type SessionState,
} from '@pct/shared';

// The app's side of the Godot editor plugin (issue #10): keeps the session's
// locks in .godot/collab_tool/locks.json of your project folder, where the
// plugin's Locks dock reads them, and carries out what the plugin asks for
// ("Lock this scene", "Release this scene"). Only for a project that has the
// plugin; .godot/ is never committed.

const REQUEST_POLL_MS = 1500;
const LOOK_AGAIN_MS = 10_000;

export interface EditorActions {
  lock(path: string): void;
  release(lockId: string): void;
}

export class GodotEditorLink {
  private folder: string | null = null;
  /** The project.godot folder (repo-relative) once looked up; null when there is no project with the plugin. */
  private godotDir: string | null = null;
  private written = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: SessionState | null = null;
  private lookedAt = 0;

  constructor(private readonly actions: EditorActions) {}

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
    }
    this.writeLocks();
  }

  stop() {
    this.poll(false);
    this.folder = null;
    this.godotDir = null;
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
    this.timer = on ? setInterval(() => this.readRequests(), REQUEST_POLL_MS) : null;
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

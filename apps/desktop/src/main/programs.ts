import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

// Programs on this PC the app reacts to (follow-up to issue #10): a Godot or
// Summer Engine editor that is running, Godot installs in the usual places,
// and Node.js (npx starts the engines' MCP servers). Kept cheap: one process
// list every few seconds, and the details only for new editor processes.

export type EditorKind = 'godot' | 'summer';

export interface RunningEditor {
  kind: EditorKind;
  pid: number;
  /** The program's full path, when it could be read. */
  program: string | null;
}

/** Which editor a process name belongs to, if any. Node (the MCP servers) never counts. */
export function editorKind(name: string): EditorKind | null {
  const base = basename(name.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
  if (/summer/.test(base) && !/mcp|cli/.test(base)) return 'summer';
  if (/^godot/.test(base) && !/mcp/.test(base)) return 'godot';
  return null;
}

/**
 * A command line of an editor someone works in. Godot also runs headless:
 * agents' Godot MCP server, the game's tests, exports. Those do not count.
 */
export function isEditorCommand(commandLine: string): boolean {
  return !/(^|\s)(--headless|--script|-s|--doctool|--export-release|--export-debug|--export-pack|--check-only)(\s|=|$)/.test(commandLine);
}

/** Windows `tasklist /fo csv /nh`: "name","pid",... */
export function parseTasklist(text: string): { name: string; pid: number }[] {
  const out: { name: string; pid: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m) out.push({ name: m[1]!, pid: Number(m[2]) });
  }
  return out;
}

/** `ps -Ao pid=,args=`. */
export function parsePs(text: string): { pid: number; args: string }[] {
  const out: { pid: number; args: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), args: m[2]!.trim() });
  }
  return out;
}

const run = (command: string, args: string[], timeout = 10_000) =>
  new Promise<string | null>((resolve) =>
    execFile(command, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout)),
  );

/** Details of a Windows process, read once per process id. */
const details = new Map<number, { program: string | null; commandLine: string } | null>();

async function windowsDetails(pids: number[]): Promise<void> {
  const wanted = pids.filter((pid) => !details.has(pid));
  if (wanted.length === 0) return;
  const filter = wanted.map((pid) => `ProcessId=${pid}`).join(' or ');
  const out = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`,
  ]);
  for (const pid of wanted) details.set(pid, null);
  if (!out?.trim()) return;
  try {
    const parsed: unknown = JSON.parse(out);
    for (const row of (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[]) {
      if (typeof row.ProcessId !== 'number') continue;
      details.set(row.ProcessId, {
        program: typeof row.ExecutablePath === 'string' ? row.ExecutablePath : null,
        commandLine: typeof row.CommandLine === 'string' ? row.CommandLine : '',
      });
    }
  } catch {
    // Not JSON: the processes stay without details.
  }
}

/** The Godot and Summer Engine editors running on this PC now. */
export async function runningEditors(): Promise<RunningEditor[]> {
  if (process.platform === 'win32') {
    const out = await run('tasklist', ['/fo', 'csv', '/nh']);
    if (out === null) return [];
    const candidates = parseTasklist(out).filter((p) => editorKind(p.name));
    await windowsDetails(candidates.map((p) => p.pid));
    const alive = new Set(candidates.map((p) => p.pid));
    for (const pid of details.keys()) if (!alive.has(pid)) details.delete(pid);
    return candidates.flatMap((p) => {
      const info = details.get(p.pid);
      if (info && !isEditorCommand(info.commandLine)) return [];
      return [{ kind: editorKind(p.name)!, pid: p.pid, program: info?.program ?? null }];
    });
  }
  const out = await run('ps', ['-Ao', 'pid=,args=']);
  if (out === null) return [];
  return parsePs(out).flatMap(({ pid, args }) => {
    const first = args.split(/\s+/)[0] ?? '';
    const kind = editorKind(first);
    if (!kind || !isEditorCommand(args)) return [];
    let program: string | null = first.startsWith('/') ? first : null;
    try {
      program = readlinkSync(`/proc/${pid}/exe`);
    } catch {
      // Not Linux, or not ours to read.
    }
    return [{ kind, pid, program }];
  });
}

/** Godot program names worth using, best first: the newest 4.x editor, never the console wrapper. */
export function pickGodot(paths: string[]): string | null {
  const version = (path: string) => {
    const m = /godot[_-]?v?(\d+)\.(\d+)(?:\.(\d+))?/i.exec(basename(path));
    return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3] ?? 0) : 0;
  };
  const usable = paths.filter((p) => editorKind(p) === 'godot' && !/console/i.test(basename(p)) && !/mono_?glue/i.test(basename(p)));
  usable.sort((a, b) => version(b) - version(a));
  return usable[0] ?? null;
}

/** Godot installs in the places people usually put it, as the app looks for them when none is set. */
export function findGodotInstalls(): string | null {
  const home = homedir();
  const found: string[] = [];
  const look = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isFile() || e.isSymbolicLink()) {
        if (editorKind(e.name) === 'godot' && (process.platform !== 'win32' || /\.exe$/i.test(e.name))) found.push(full);
      } else if (e.isDirectory() && depth > 0 && /godot/i.test(e.name)) {
        look(full, depth - 1);
      }
    }
  };
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((p): p is string => !!p);
    const steam = programFiles.map((p) => join(p, 'Steam', 'steamapps', 'common', 'Godot Engine'));
    for (const dir of [join(local, 'Microsoft', 'WinGet', 'Links'), join(home, 'scoop', 'shims'), ...steam]) look(dir, 0);
    for (const dir of [join(home, 'Downloads'), join(home, 'Desktop'), join(home, 'Documents'), join(local, 'Programs'), ...programFiles, 'C:\\Godot', join(home, 'Godot')]) {
      look(dir, 2);
    }
    // Steam's build has its own name.
    for (const dir of steam) {
      const steamExe = join(dir, 'godot.windows.opt.tools.64.exe');
      if (existsSync(steamExe)) found.push(steamExe);
    }
  } else if (process.platform === 'darwin') {
    for (const app of ['/Applications/Godot.app', join(home, 'Applications', 'Godot.app')]) {
      const exe = join(app, 'Contents', 'MacOS', 'Godot');
      if (existsSync(exe)) return exe;
    }
  } else {
    for (const dir of [join(home, 'godot'), join(home, 'Godot'), join(home, 'Downloads'), join(home, '.local', 'bin'), '/opt/godot']) look(dir, 1);
  }
  return pickGodot(found) ?? found[0] ?? null;
}

/** Node.js is installed: npx starts the engines' MCP servers. */
export async function nodeInstalled(): Promise<boolean> {
  const out = await run(process.platform === 'win32' ? 'node.exe' : 'node', ['--version'], 5_000);
  return !!out && /^v\d+/.test(out.trim());
}

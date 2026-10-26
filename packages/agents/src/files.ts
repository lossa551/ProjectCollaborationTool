import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { normalizePath } from '@pct/shared';

// The agent's view of the project folder: reading, searching, writing and
// running commands, always inside the folder. Whether it is allowed to is
// decided before these are called (see guard.ts).

const MAX_READ_BYTES = 256 * 1024;
const MAX_OUTPUT = 20_000;

function git(root: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd: root, maxBuffer, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolvePromise(stdout);
    });
  });
}

export function clip(text: string, limit = MAX_OUTPUT): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;
}

export class ProjectFiles {
  constructor(readonly root: string) {}

  /**
   * Repo-relative path to an absolute one inside the folder. Rejects paths
   * that leave it, including through a symlinked folder.
   */
  async resolve(rawPath: string): Promise<{ rel: string; abs: string }> {
    const rel = normalizePath(rawPath);
    if (!rel) throw new Error(`${rawPath} is outside the project`);
    const abs = resolve(this.root, ...rel.split('/'));
    const rootReal = await realpath(this.root);
    // Walk up to the nearest part that exists and make sure it is still inside.
    let probe = abs;
    for (;;) {
      try {
        const real = await realpath(probe);
        const inside = relative(rootReal, real);
        if (inside.startsWith('..') || isAbsolute(inside)) throw new Error(`${rawPath} is outside the project`);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    return { rel, abs };
  }

  /** An absolute path from a CLI tool, as a repo-relative path; null when outside. */
  toRelative(path: string): string | null {
    const abs = isAbsolute(path) ? path : join(this.root, path);
    const rel = relative(this.root, abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
    return rel.split(sep).join('/');
  }

  async read(rawPath: string, offset = 1, limit = 2000): Promise<string> {
    const { abs, rel } = await this.resolve(rawPath);
    const info = await stat(abs);
    if (info.isDirectory()) return this.list(rel);
    if (info.size > MAX_READ_BYTES * 8) throw new Error(`${rel} is too large to read (${info.size} bytes)`);
    const buffer = await readFile(abs);
    if (buffer.subarray(0, 8000).includes(0)) return `${rel} is a binary file (${info.size} bytes).`;
    const lines = buffer.toString('utf8').split('\n');
    const start = Math.max(1, offset);
    const slice = lines.slice(start - 1, start - 1 + limit);
    const numbered = slice.map((line, i) => `${String(start + i).padStart(5)}  ${line}`).join('\n');
    const more = start - 1 + limit < lines.length ? `\n… ${lines.length - (start - 1 + limit)} more lines` : '';
    return clip(numbered, MAX_READ_BYTES) + more;
  }

  /** Files under a folder, as git sees them (ignored files left out). */
  async list(rawPath = ''): Promise<string> {
    const rel = rawPath.trim() === '' || rawPath.trim() === '.' ? '' : (await this.resolve(rawPath)).rel;
    let files: string[];
    try {
      const out = await git(this.root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', rel || '.']);
      files = [...new Set(out.split('\0').filter(Boolean))];
    } catch {
      files = await this.walk(rel);
    }
    files.sort();
    const shown = files.slice(0, 500);
    return shown.join('\n') + (files.length > shown.length ? `\n… ${files.length - shown.length} more files` : '') || '(no files)';
  }

  private async walk(rel: string, depth = 0): Promise<string[]> {
    if (depth > 8) return [];
    const dir = rel ? join(this.root, ...rel.split('/')) : this.root;
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...(await this.walk(child, depth + 1)));
      else out.push(child);
      if (out.length > 2000) break;
    }
    return out;
  }

  async search(pattern: string, rawPath = ''): Promise<string> {
    const rel = rawPath.trim() ? (await this.resolve(rawPath)).rel : '.';
    try {
      const out = await git(this.root, ['grep', '-n', '-I', '-E', '--untracked', '-e', pattern, '--', rel]);
      return clip(out) || 'No matches.';
    } catch (error) {
      // git grep exits with 1 when nothing matches.
      if ((error as { code?: number }).code === 1) return 'No matches.';
      throw error;
    }
  }

  async write(rawPath: string, content: string): Promise<string> {
    const { abs, rel } = await this.resolve(rawPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    return `Wrote ${rel} (${content.split('\n').length} lines).`;
  }

  /** Replaces text that occurs exactly once. */
  async edit(rawPath: string, oldText: string, newText: string): Promise<string> {
    const { abs, rel } = await this.resolve(rawPath);
    const current = await readFile(abs, 'utf8');
    const first = current.indexOf(oldText);
    if (oldText === '' || first < 0) throw new Error(`The text to replace was not found in ${rel}`);
    if (current.indexOf(oldText, first + 1) >= 0) throw new Error(`The text to replace occurs more than once in ${rel}; include more of it`);
    await writeFile(abs, current.slice(0, first) + newText + current.slice(first + oldText.length), 'utf8');
    return `Edited ${rel}.`;
  }

  async remove(rawPath: string): Promise<void> {
    const { abs } = await this.resolve(rawPath);
    await rm(abs, { force: true });
  }

  /** Runs a shell command in the folder. Output is clipped; stops after the timeout or on abort. */
  run(command: string, signal: AbortSignal, timeoutMs = 120_000): Promise<{ output: string; exitCode: number | null }> {
    return new Promise((resolvePromise) => {
      const child = spawn(command, { cwd: this.root, shell: true, windowsHide: true, signal, timeout: timeoutMs });
      let output = '';
      const take = (chunk: Buffer) => {
        if (output.length < MAX_OUTPUT * 2) output += chunk.toString('utf8');
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('error', (error) => {
        output += `\n${error.message}`;
      });
      child.on('close', (code) => resolvePromise({ output: clip(output), exitCode: code }));
    });
  }

  /** Files git reports as changed or new (repo-relative), for checking what a command or CLI agent did. */
  async changedFiles(): Promise<Set<string>> {
    try {
      const out = await git(this.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
      const files = new Set<string>();
      const entries = out.split('\0');
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        if (entry.length < 4) continue;
        files.add(entry.slice(3));
        // A rename lists the old path next; skip it.
        if (entry[0] === 'R' || entry[0] === 'C') i++;
      }
      return files;
    } catch {
      return new Set();
    }
  }

  /** Puts a file back the way git has it, or deletes it when git does not know it. */
  async revert(rel: string): Promise<void> {
    try {
      await git(this.root, ['ls-files', '--error-unmatch', '--', rel]);
    } catch {
      await this.remove(rel);
      return;
    }
    await git(this.root, ['checkout', 'HEAD', '--', rel]);
  }
}

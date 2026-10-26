import { execFile } from 'node:child_process';
import { WORKSPACE_FILE_LIMIT, parseNameStatus, parseRepoRef, type Workspace } from '@pct/shared';
import type { LocalWorkspace } from '../common/api';
import { readGitInfo } from './git';

// Watches your local checkout of the project with git: which branch is checked
// out and which files changed since it left the default branch, committed or
// not. The result is shared with the session so others see who is changing
// what before anything is pushed.

const POLL_MS = 4000;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        reject(new Error(missing ? 'Git is not installed or not on the PATH.' : String(stderr).trim() || error.message));
      } else resolve(String(stdout));
    });
  });
}

const tryGit = (cwd: string, args: string[]) => git(cwd, args).then((out) => out.trim(), () => null);

export { repositoryRoot } from './git';
export { parseNameStatus } from '@pct/shared';

export class WorkspaceWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private last = '';
  private state: LocalWorkspace;

  constructor(
    readonly folder: string,
    /** The default branch on GitHub, when known; otherwise taken from origin/HEAD. */
    private readonly defaultBranch: () => string | null,
    private readonly onChange: (state: LocalWorkspace) => void,
  ) {
    this.state = { folder, remote: null, workspace: null, git: null, error: null };
  }

  getState(): LocalWorkspace {
    return this.state;
  }

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Looks again now, e.g. after the default branch became known. */
  poll = async (): Promise<void> => {
    if (this.busy) return;
    this.busy = true;
    try {
      this.publish(await this.read());
    } catch (error) {
      this.publish({ ...this.state, workspace: null, git: null, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.busy = false;
    }
  };

  private async read(): Promise<LocalWorkspace> {
    const cwd = this.folder;
    const remoteUrl = await tryGit(cwd, ['remote', 'get-url', 'origin']);
    const remote = remoteUrl && /github\.com[/:]/i.test(remoteUrl) ? parseRepoRef(remoteUrl) : null;
    const head = await tryGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (head === null) throw new Error('Could not read the repository. Has it got at least one commit?');
    const branch = head === 'HEAD' ? null : head;

    const base = await this.baseRef();
    const mergeBase = base ? await tryGit(cwd, ['merge-base', 'HEAD', base]) : null;
    // Against the merge base: everything this branch changed, committed or not.
    // Without one, just what is not committed yet.
    const diff = await git(cwd, ['diff', '--name-status', '-z', mergeBase ?? 'HEAD']);
    const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', ':/']);
    const all = [
      ...parseNameStatus(diff),
      ...untracked
        .split('\0')
        .filter(Boolean)
        .map((path) => ({ path, change: 'untracked' as const })),
    ];
    const workspace: Workspace = {
      branch,
      base: mergeBase ? base : null,
      files: all.slice(0, WORKSPACE_FILE_LIMIT),
      truncated: all.length > WORKSPACE_FILE_LIMIT,
      updatedAt: Date.now(),
    };
    return { folder: cwd, remote, workspace, git: await readGitInfo(cwd), error: null };
  }

  private async baseRef(): Promise<string | null> {
    const cwd = this.folder;
    const known = this.defaultBranch();
    const candidates = [
      known && `origin/${known}`,
      (await tryGit(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])) ?? null,
      'origin/main',
      'origin/master',
      known,
      'main',
      'master',
    ];
    for (const ref of candidates) {
      if (ref && (await tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))) return ref;
    }
    return null;
  }

  private publish(next: LocalWorkspace) {
    this.state = next;
    const key = JSON.stringify({ ...next, workspace: next.workspace && { ...next.workspace, updatedAt: 0 } });
    if (key === this.last) return;
    this.last = key;
    this.onChange(next);
  }
}

import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { DraftChanges, FileChange } from '@pct/shared';
import type { GitAction, GitInfo } from '../common/api';

// Runs the git installed on this PC for the everyday actions on the GitHub
// page: clone, fetch, pull, commit, push and branches. For github.com it signs
// in with the app's GitHub token when there is one (passed in the environment,
// never written to the repository's config); if GitHub refuses that token, it
// tries again with git's own sign-in (Git Credential Manager on Windows).

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: 'no-git' | 'not-a-repo' | 'dubious' | 'failed',
    /** For 'dubious': the repository folder as git names it. */
    readonly folder: string | null = null,
  ) {
    super(message);
  }
}

interface RunOptions {
  cwd: string;
  token?: string | null;
  timeout?: number;
}

const NETWORK_TIMEOUT = 5 * 60_000;

function run(args: string[], { cwd, token, timeout = 15_000 }: RunOptions): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
  }
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(String(stdout));
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reject(new GitError('Git is not installed or not on the PATH.', 'no-git'));
      const text = String(stderr).trim() || String(stdout).trim() || error.message;
      reject(new GitError(text, /dubious ownership/i.test(text) ? 'dubious' : 'failed'));
    });
  });
}

const refused = (error: unknown) => error instanceof GitError && /\b(403|401)\b|denied|Authentication failed|could not read Username/i.test(error.message);

/** Runs a command that talks to GitHub: with the token first, then with git's own sign-in if GitHub refuses it. */
async function remote(args: string[], options: RunOptions): Promise<string> {
  const timeout = options.timeout ?? NETWORK_TIMEOUT;
  if (!options.token) return run(args, { ...options, timeout });
  try {
    return await run(args, { ...options, timeout });
  } catch (error) {
    if (!refused(error)) throw error;
    return run(args, { ...options, token: null, timeout });
  }
}

const tryRun = (args: string[], cwd: string) => run(args, { cwd }).then((out) => out.trim(), () => null);

/** Tags the checked-out commit (locally; push tags to share it). Returns the tag name. */
export async function tagCommit(cwd: string, name: string, message: string): Promise<string> {
  if ((await tryRun(['check-ref-format', `refs/tags/${name}`], cwd)) === null) throw new GitError('That is not a valid tag name.', 'failed');
  await run(['tag', '-a', name, '-m', message || name], { cwd });
  return name;
}

/** The top folder of the git repository that contains this folder. */
export async function repositoryRoot(folder: string): Promise<string> {
  try {
    return (await run(['rev-parse', '--show-toplevel'], { cwd: folder })).trim();
  } catch (error) {
    if (error instanceof GitError && error.code !== 'failed') {
      if (error.code === 'dubious') {
        const named = /repository at '([^']+)'/.exec(error.message)?.[1] ?? folder;
        throw new GitError('Git does not trust that folder because another Windows user owns it.', 'dubious', named);
      }
      throw error;
    }
    throw new GitError('That folder is not inside a git repository.', 'not-a-repo');
  }
}

/** Files in the project as git sees them: tracked ones and new ones that are not ignored. */
export async function listProjectFiles(cwd: string): Promise<string[]> {
  const out = await run(['-c', 'core.quotepath=off', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd, timeout: 60_000 });
  return [...new Set(out.split('\0').filter(Boolean))];
}

/**
 * Commits just these paths, with whatever else is staged left staged and out
 * of the commit. Returns the short commit id, or null when nothing changed.
 */
export async function commitPaths(cwd: string, paths: string[], message: string): Promise<string | null> {
  if (paths.length === 0) return null;
  try {
    await run(['add', '--', ...paths], { cwd });
    if ((await tryRun(['diff', '--cached', '--quiet', '--', ...paths], cwd)) !== null) return null;
    await run(['commit', '-m', message, '--', ...paths], { cwd, timeout: 60_000 });
    return (await run(['rev-parse', '--short', 'HEAD'], { cwd })).trim();
  } catch (error) {
    throw explain(error);
  }
}

/** The repository has at least one commit (a new engine project may not). */
export async function hasCommit(cwd: string): Promise<boolean> {
  return (await tryRun(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd)) !== null;
}

/** Git LFS is installed on this PC. */
export async function hasGitLfs(cwd: string): Promise<boolean> {
  return (await tryRun(['lfs', 'version'], cwd)) !== null;
}

/** Turns on Git LFS's hooks in this repository (needed once per clone). */
export async function installGitLfs(cwd: string): Promise<void> {
  await run(['lfs', 'install', '--local'], { cwd });
}

/** Tells git to trust a folder owned by another user (git's safe.directory setting). */
export async function trustFolder(folder: string): Promise<void> {
  await run(['config', '--global', '--add', 'safe.directory', folder.replace(/\\/g, '/')], { cwd: folder });
}

export async function clone(url: string, target: string, parent: string, token: string | null): Promise<void> {
  await remote(['clone', '--', url, target], { cwd: parent, token, timeout: 60 * 60_000 });
}

function change(xy: string): FileChange {
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('R') || xy.includes('C')) return 'renamed';
  if (xy.includes('A')) return 'added';
  return 'modified';
}

/** Parses `git status --porcelain=v2 --branch -z`. Branch lists and merge state are filled in by the caller. */
export function parseStatus(output: string): Pick<GitInfo, 'upstream' | 'ahead' | 'behind' | 'uncommitted' | 'conflicted'> {
  const info: Pick<GitInfo, 'upstream' | 'ahead' | 'behind' | 'uncommitted' | 'conflicted'> = {
    upstream: null,
    ahead: 0,
    behind: 0,
    uncommitted: [],
    conflicted: [],
  };
  const parts = output.split('\0');
  // Splits off the first n space-separated fields; the rest is the path, which may contain spaces.
  const fields = (entry: string, n: number) => {
    const out: string[] = [];
    let rest = entry;
    for (let i = 0; i < n; i++) {
      const space = rest.indexOf(' ');
      if (space < 0) return null;
      out.push(rest.slice(0, space));
      rest = rest.slice(space + 1);
    }
    return { fields: out, path: rest };
  };
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.startsWith('# branch.upstream ')) info.upstream = entry.slice('# branch.upstream '.length);
    else if (entry.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(entry);
      if (match) {
        info.ahead = Number(match[1]);
        info.behind = Number(match[2]);
      }
    } else if (entry.startsWith('1 ')) {
      const parsed = fields(entry, 8);
      if (parsed) info.uncommitted.push({ path: parsed.path, change: change(parsed.fields[1]!) });
    } else if (entry.startsWith('2 ')) {
      const parsed = fields(entry, 9);
      if (parsed) info.uncommitted.push({ path: parsed.path, change: 'renamed' });
      i++; // the old path
    } else if (entry.startsWith('u ')) {
      const parsed = fields(entry, 10);
      if (parsed) info.conflicted.push(parsed.path);
    } else if (entry.startsWith('? ')) {
      info.uncommitted.push({ path: entry.slice(2), change: 'untracked' });
    }
  }
  return info;
}

/** Branches, upstream, uncommitted files and merge state of the repository. */
export async function readGitInfo(cwd: string): Promise<GitInfo> {
  const status = parseStatus(await run(['status', '--porcelain=v2', '--branch', '-z'], { cwd }));
  const refs = (await tryRun(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'], cwd)) ?? '';
  const branches: string[] = [];
  const remoteBranches: string[] = [];
  for (const ref of refs.split('\n')) {
    if (ref.startsWith('refs/heads/')) branches.push(ref.slice('refs/heads/'.length));
    else if (ref.startsWith('refs/remotes/origin/') && ref !== 'refs/remotes/origin/HEAD') remoteBranches.push(ref.slice('refs/remotes/origin/'.length));
  }
  const merging = (await tryRun(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], cwd)) !== null;
  return { ...status, merging, branches, remoteBranches: remoteBranches.filter((b) => !branches.includes(b)) };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Makes git's messages for the usual problems readable. */
function explain(error: unknown): Error {
  if (!(error instanceof GitError)) return error instanceof Error ? error : new Error(String(error));
  const text = error.message;
  if (/Please tell me who you are|empty ident/i.test(text)) {
    return new Error('Git does not know your name yet. Run once in a terminal: git config --global user.name "Your Name" and git config --global user.email you@example.com');
  }
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(text)) return new Error('GitHub has commits on this branch that you do not have. Pull first, then push.');
  if (/would be overwritten/i.test(text)) return new Error('You have uncommitted changes to files this would change. Commit them first.');
  if (refused(error)) return new Error('GitHub refused the sign-in. Use a token with write access to contents, or sign in to git on this PC.');
  return new Error(text.split('\n').filter((line) => !line.startsWith('hint:')).slice(-4).join('\n'));
}

async function hasRef(cwd: string, ref: string) {
  return (await tryRun(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd)) !== null;
}

/** Runs one action in the repository and says what happened. */
export async function runGitAction(cwd: string, action: GitAction, token: string | null): Promise<string> {
  try {
    return await perform(cwd, action, token);
  } catch (error) {
    throw explain(error);
  }
}

async function perform(cwd: string, action: GitAction, token: string | null): Promise<string> {
  const info = () => readGitInfo(cwd);
  const branch = async () => {
    const head = (await run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).trim();
    if (head === 'HEAD') throw new Error('No branch is checked out (detached HEAD). Switch to a branch first.');
    return head;
  };
  switch (action.type) {
    case 'fetch': {
      await remote(['fetch', '--prune', 'origin'], { cwd, token });
      const { upstream, behind } = await info();
      return upstream ? (behind > 0 ? `${plural(behind, 'new commit')} on GitHub. Pull to get them.` : 'Up to date with GitHub.') : 'Fetched from GitHub.';
    }
    case 'pull': {
      const name = await branch();
      const { upstream } = await info();
      await remote(['fetch', '--prune', 'origin'], { cwd, token });
      const args = ['pull', '--no-rebase', '--no-edit'];
      if (!upstream) {
        if (!(await hasRef(cwd, `origin/${name}`))) return `${name} is not on GitHub yet. Push it to share it.`;
        args.push('origin', name);
      }
      try {
        const out = await remote(args, { cwd, token });
        return /Already up to date/i.test(out) ? 'Already up to date.' : 'Pulled the latest changes.';
      } catch (error) {
        const { conflicted } = await info();
        if (conflicted.length > 0) {
          return `Pulled, but ${plural(conflicted.length, 'file')} ${conflicted.length === 1 ? 'has' : 'have'} conflicts. Fix them in your editor and commit, or abort the merge.`;
        }
        throw error;
      }
    }
    case 'commit': {
      const message = action.message.trim();
      if (!message) throw new Error('Write a commit message first.');
      const { conflicted } = await info();
      if (conflicted.length > 0) throw new Error(`Fix the conflicts in ${plural(conflicted.length, 'file')} first.`);
      await run(['add', '-A'], { cwd });
      if ((await tryRun(['diff', '--cached', '--quiet'], cwd)) !== null && !(await info()).merging) return 'Nothing to commit.';
      await run(['commit', '-m', message], { cwd, timeout: 60_000 });
      return 'Committed.';
    }
    case 'push': {
      const name = await branch();
      const { upstream } = await info();
      await remote(upstream ? ['push'] : ['push', '-u', 'origin', name], { cwd, token });
      return upstream ? 'Pushed.' : `Pushed ${name} to GitHub.`;
    }
    case 'switch': {
      await run(['switch', action.branch], { cwd, timeout: 60_000 });
      return `Switched to ${action.branch}.`;
    }
    case 'create-branch': {
      const name = action.branch.trim();
      if (!name || (await tryRun(['check-ref-format', '--branch', name], cwd)) === null) throw new Error('That is not a valid branch name.');
      if (action.from) {
        await remote(['fetch', 'origin', action.from], { cwd, token });
        await run(['switch', '--no-track', '-c', name, `origin/${action.from}`], { cwd, timeout: 60_000 });
        return `Created ${name} from the latest ${action.from}.`;
      }
      await run(['switch', '-c', name], { cwd, timeout: 60_000 });
      return `Created ${name}.`;
    }
    case 'abort-merge': {
      await run(['merge', '--abort'], { cwd });
      return 'Merge aborted. Your branch is back to how it was before the pull.';
    }
  }
}

/**
 * Merges another branch (an agent's) into the branch checked out here. A
 * conflict is left for the person to fix, the same as after a pull.
 */
export async function mergeBranch(cwd: string, branch: string, message: string): Promise<string> {
  try {
    const head = (await run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).trim();
    if (head === 'HEAD') throw new Error('No branch is checked out in your project folder (detached HEAD). Switch to a branch first.');
    if ((await info(cwd)).merging) throw new Error('Your project folder is in the middle of a merge. Finish or abort it first.');
    try {
      const out = await run(['merge', '--no-ff', '--no-edit', '-m', message, branch], { cwd, timeout: 5 * 60_000 });
      return /Already up to date/i.test(out) ? `${head} already has everything from ${branch}.` : `Merged ${branch} into ${head}.`;
    } catch (error) {
      const { conflicted } = await info(cwd);
      if (conflicted.length > 0) {
        return `Merged ${branch} into ${head}, but ${plural(conflicted.length, 'file')} ${conflicted.length === 1 ? 'has' : 'have'} conflicts. Fix them in your editor and commit, or abort the merge on the GitHub page.`;
      }
      throw error;
    }
  } catch (error) {
    throw explain(error);
  }
}

/** Pushes a branch (an agent's) from its folder to GitHub. */
export async function pushBranch(cwd: string, branch: string, token: string | null): Promise<string> {
  try {
    await remote(['push', '-u', 'origin', branch], { cwd, token });
    return `Pushed ${branch} to GitHub.`;
  } catch (error) {
    throw explain(error);
  }
}

const info = (cwd: string) => readGitInfo(cwd);

/** git's id of the empty tree, to diff against before the first commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Most of a new (untracked) file read for a draft. */
const NEW_FILE_BYTES = 16 * 1024;

/** A new file as a diff section, from its first bytes; binary files are only named. */
async function newFileDiff(cwd: string, path: string): Promise<string> {
  const header = `diff --git a/${path} b/${path}\nnew file\n`;
  try {
    const file = await open(join(cwd, path), 'r');
    try {
      const { buffer, bytesRead } = await file.read(Buffer.alloc(NEW_FILE_BYTES), 0, NEW_FILE_BYTES, 0);
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.includes(0)) return `${header}Binary file\n`;
      const lines = bytes.toString('utf8').split('\n');
      if (bytesRead === NEW_FILE_BYTES) lines.pop();
      return `${header}${lines.map((line) => `+${line}`).join('\n')}\n${bytesRead === NEW_FILE_BYTES ? '… rest of the file left out\n' : ''}`;
    } finally {
      await file.close();
    }
  } catch {
    // A folder (an untracked submodule or nested repository) or a file that went away.
    return header;
  }
}

/** Your uncommitted changes, for an agent drafting the commit message. */
export async function uncommittedChanges(cwd: string): Promise<Omit<DraftChanges, 'task'>> {
  const { uncommitted } = await readGitInfo(cwd);
  const head = await tryRun(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const base = (await hasRef(cwd, 'HEAD')) ? 'HEAD' : EMPTY_TREE;
  const stat = (await tryRun(['diff', '--stat=100', '--no-color', base], cwd)) ?? '';
  const tracked = (await tryRun(['diff', '--no-color', '--no-ext-diff', '-U3', base], cwd)) ?? '';
  const untracked = uncommitted.filter((f) => f.change === 'untracked').slice(0, 100);
  const added = await Promise.all(untracked.map((f) => newFileDiff(cwd, f.path)));
  return {
    branch: head && head !== 'HEAD' ? head : null,
    files: uncommitted,
    stat,
    diff: [tracked.trimEnd(), ...added].filter(Boolean).join('\n'),
  };
}

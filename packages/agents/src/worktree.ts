import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { WORKSPACE_FILE_LIMIT, parseNameStatus, type ChatWorktree, type FileChange } from '@pct/shared';

// Each agent chat works in its own git worktree: a second checkout of the
// project on its own branch (agent/<name>), next to the person's project
// folder. The agent's edits stay there until someone merges them, so they
// never mix with the person's uncommitted changes, and two agents never see
// each other's half-done work. Everything here runs the git on this PC.
//
// Checkpoints: each agent turn that changed files is committed (commitAll),
// so a turn can be undone (revertCommit) or the copy taken back to the end of
// one (resetTo). A branched chat can start its copy at a checkpoint with
// createWorktree's `from`.

export class WorktreeError extends Error {}

function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolvePromise(String(stdout));
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reject(new WorktreeError('Git is not installed or not on the PATH.'));
      reject(new WorktreeError(String(stderr).trim() || String(stdout).trim() || error.message));
    });
  });
}

const tryGit = (cwd: string, args: string[]) => git(cwd, args).then((out) => out.trim(), () => null);

/** Lower-case words joined by dashes, short enough for Windows paths. */
export function slugify(text: string, max = 32): string {
  const slug = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return slug || 'work';
}

/** The agent's branch for a chat: agent/<task or chat title>-<start of the chat id>. */
export function agentBranchName(title: string, chatId: string): string {
  const id = chatId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toLowerCase() || 'chat';
  return `agent/${slugify(title)}-${id}`;
}

/**
 * Where a chat's copy goes by default: a folder next to the project folder,
 * "<project>-agents/<branch without agent/>". Outside the project, so engines
 * and tools that scan the project folder do not pick up a second copy of it.
 */
export function defaultWorktreeFolder(root: string, branch: string): string {
  const parent = dirname(resolve(root));
  return join(parent, `${basename(resolve(root))}-agents`, branch.replace(/^agent\//, '').replace(/\//g, '-'));
}

/** Whether the folder is a git repository with at least one commit, so worktrees can be made from it. */
export async function canMakeWorktrees(root: string): Promise<boolean> {
  return (await tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])) !== null;
}

/** The branch checked out in a folder; null when detached or not a repository. */
export async function currentBranch(folder: string): Promise<string | null> {
  const head = await tryGit(folder, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return head || null;
}

async function commitOf(cwd: string, ref: string): Promise<string | null> {
  return tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

/** Whether the folder holds a checkout of this branch (the copy is still there). */
export async function worktreeReady(folder: string, branch: string): Promise<boolean> {
  if (!existsSync(folder)) return false;
  return (await currentBranch(folder)) === branch;
}

/**
 * Picks what a new copy starts from: the first of the given branches that
 * exists here or on origin, else the branch checked out in the project folder.
 */
export async function pickBase(root: string, preferred: (string | null | undefined)[]): Promise<{ base: string | null; ref: string }> {
  for (const name of preferred) {
    if (!name) continue;
    if (await commitOf(root, `refs/heads/${name}`)) return { base: name, ref: name };
    if (await commitOf(root, `refs/remotes/origin/${name}`)) return { base: name, ref: `origin/${name}` };
  }
  const current = await currentBranch(root);
  return { base: current, ref: 'HEAD' };
}

export interface CreateWorktree {
  /** The person's project folder (the main checkout). */
  root: string;
  folder: string;
  branch: string;
  /** What the branch starts from: a branch, a commit or HEAD. Ignored when the branch already exists. */
  from: string;
}

/**
 * Makes the copy, or reuses it when it is already there. An existing branch
 * (say the folder was deleted) is checked out again with its commits.
 * Returns the commit the branch started from.
 */
export async function createWorktree({ root, folder, branch, from }: CreateWorktree): Promise<{ baseCommit: string }> {
  const start = await commitOf(root, from);
  if (!start) throw new WorktreeError(`${from} is not a commit in this repository`);
  if (await worktreeReady(folder, branch)) {
    return { baseCommit: (await tryGit(root, ['merge-base', start, branch])) ?? start };
  }
  if (existsSync(folder)) throw new WorktreeError(`${folder} already exists and is not the agent's copy; move it out of the way`);
  // Copies whose folder was deleted by hand would block the branch.
  await tryGit(root, ['worktree', 'prune']);
  const exists = (await commitOf(root, `refs/heads/${branch}`)) !== null;
  if (exists) await git(root, ['worktree', 'add', folder, branch], 10 * 60_000);
  else await git(root, ['worktree', 'add', '--no-track', '-b', branch, folder, start], 10 * 60_000);
  return { baseCommit: exists ? ((await tryGit(root, ['merge-base', start, branch])) ?? start) : start };
}

export type WorktreeStatus = Pick<ChatWorktree, 'files' | 'truncated' | 'commits' | 'uncommitted' | 'head'>;

/**
 * What the agent changed in its copy: files since the branch left its base
 * (committed or not), commits not in the base yet, and uncommitted files.
 * The base branch is used when it is here, so a merge into it counts.
 */
export async function worktreeStatus(folder: string, base: { branch: string | null; commit: string }): Promise<WorktreeStatus> {
  const baseRef = (base.branch && (await commitOf(folder, `refs/heads/${base.branch}`))) || base.commit;
  const mergeBase = (await tryGit(folder, ['merge-base', 'HEAD', baseRef])) ?? base.commit;
  const diff = await git(folder, ['-c', 'core.quotepath=off', 'diff', '--name-status', '-z', mergeBase]);
  const untracked = await git(folder, ['-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard', '-z']);
  const files = [
    ...parseNameStatus(diff),
    ...untracked
      .split('\0')
      .filter(Boolean)
      .map((path) => ({ path, change: 'untracked' as const })),
  ];
  const commits = Number((await tryGit(folder, ['rev-list', '--count', `${baseRef}..HEAD`])) ?? 0) || 0;
  const status = await git(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  let uncommitted = 0;
  const entries = status.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    uncommitted++;
    if (entry[0] === 'R' || entry[0] === 'C') i++;
  }
  const head = await headCommit(folder);
  return { files: files.slice(0, WORKSPACE_FILE_LIMIT), truncated: files.length > WORKSPACE_FILE_LIMIT, commits, uncommitted, head };
}

/** Commits everything in the copy. Returns the new commit, or null when nothing changed. */
export async function commitAll(folder: string, message: string): Promise<string | null> {
  await git(folder, ['add', '-A']);
  if ((await tryGit(folder, ['diff', '--cached', '--quiet'])) !== null) return null;
  await git(folder, ['commit', '-q', '--no-verify', '-m', message]);
  return tryGit(folder, ['rev-parse', 'HEAD']);
}

/** The commit checked out in the folder. */
export async function headCommit(folder: string): Promise<string | null> {
  return commitOf(folder, 'HEAD');
}

/** Files that differ between two commits. */
export async function changedBetween(folder: string, from: string, to: string): Promise<{ path: string; change: FileChange }[]> {
  return parseNameStatus(await git(folder, ['-c', 'core.quotepath=off', 'diff', '--name-status', '-z', '--no-renames', from, to]));
}

/** Whether the commit is the other one or one of its ancestors (false when either is unknown). */
export async function isAncestor(folder: string, commit: string, of: string): Promise<boolean> {
  return (await tryGit(folder, ['merge-base', '--is-ancestor', commit, of])) !== null;
}

/**
 * Undoes one commit with a new commit that puts back every file it changed.
 * When later commits changed the same lines it stops, leaves the copy as it
 * was, and says which files are in the way. Returns the new commit.
 */
export async function revertCommit(folder: string, commit: string, message: string): Promise<string> {
  try {
    await git(folder, ['revert', '--no-commit', '--no-edit', commit]);
  } catch (error) {
    const conflicted = ((await tryGit(folder, ['-c', 'core.quotepath=off', 'diff', '--name-only', '--diff-filter=U'])) ?? '').split('\n').filter(Boolean);
    await tryGit(folder, ['revert', '--abort']);
    // Everything was committed before, so nothing of the person's is lost here.
    await tryGit(folder, ['reset', '-q', '--hard', 'HEAD']);
    if (conflicted.length > 0) {
      throw new WorktreeError(`later turns changed the same parts of ${conflicted.join(', ')}. Use "Go back to here" on the turn before it instead`);
    }
    throw error;
  }
  if ((await tryGit(folder, ['diff', '--cached', '--quiet'])) !== null) {
    await tryGit(folder, ['revert', '--quit']);
    throw new WorktreeError('its changes are already gone from the copy');
  }
  await git(folder, ['commit', '-q', '--no-verify', '-m', message]);
  return (await headCommit(folder))!;
}

/**
 * Takes the copy back to a commit. What it pointed at before is kept under
 * the backup ref, so later turns can still be brought back.
 */
export async function resetTo(folder: string, commit: string, backupRef: string): Promise<void> {
  await git(folder, ['update-ref', backupRef, 'HEAD']);
  await git(folder, ['reset', '-q', '--hard', commit]);
}

/** Whether every commit on the branch is already in the other one. */
export async function branchMerged(root: string, branch: string, into: string): Promise<boolean> {
  const count = await tryGit(root, ['rev-list', '--count', `${into}..${branch}`]);
  return count === '0';
}

/**
 * Removes the copy's folder. The branch is deleted too when asked, or kept
 * (with its commits) so nothing committed is lost.
 */
export async function removeWorktree(root: string, folder: string, branch: string, deleteBranch: boolean): Promise<void> {
  if (existsSync(folder)) await git(root, ['worktree', 'remove', '--force', folder], 10 * 60_000);
  await tryGit(root, ['worktree', 'prune']);
  if (deleteBranch && (await commitOf(root, `refs/heads/${branch}`))) await git(root, ['branch', '-D', branch]);
}

/** The main checkout a copy belongs to (the person's project folder). */
export async function mainCheckout(folder: string): Promise<string> {
  const common = (await git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  return resolve(basename(common) === '.git' ? dirname(common) : common);
}

/** The copy's changes since its branch left the base, as a unified diff; new files included. */
export async function worktreeDiff(folder: string, base: { branch: string | null; commit: string }, limit = 400_000): Promise<string> {
  const baseRef = (base.branch && (await commitOf(folder, `refs/heads/${base.branch}`))) || base.commit;
  const mergeBase = (await tryGit(folder, ['merge-base', 'HEAD', baseRef])) ?? base.commit;
  let out = await git(folder, ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', mergeBase]);
  const untracked = (await git(folder, ['-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  for (const path of untracked) {
    if (out.length > limit) break;
    // diff --no-index exits with 1 when the files differ, which they always do here.
    out += await new Promise<string>((done) =>
      execFile('git', ['diff', '--no-color', '--no-index', '--', '/dev/null', path], { cwd: folder, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (_e, stdout) =>
        done(String(stdout)),
      ),
    );
  }
  return out.length > limit ? `${out.slice(0, limit)}\n… (diff cut off; open the folder to see the rest)` : out;
}

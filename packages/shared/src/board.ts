import type { SessionState } from './client.js';
import { pullForBranch, type Lock, type Task } from './model.js';
import { APPROVAL_ACTIVITY_PREFIX, parseLockWait, pullProblems } from './overview.js';
import { samePath } from './paths.js';

// Board search and quick filters (issue #38), and which locks a commit frees.
// A large game has 40+ tasks; search and filters narrow the board live, and
// filters combine with each other and with the search.

export const BOARD_FILTERS = ['mine', 'agents', 'blocked', 'unverified'] as const;
export type BoardFilter = (typeof BOARD_FILTERS)[number];

export const BOARD_FILTER_LABELS: Record<BoardFilter, string> = {
  mine: 'Mine',
  agents: 'Agents',
  blocked: 'Blocked',
  unverified: 'Unverified',
};

export const BOARD_FILTER_HINTS: Record<BoardFilter, string> = {
  mine: 'Tasks you own, or that an agent works on for you',
  agents: 'Tasks an agent owns, works on, holds locks for, or has unmerged work for',
  blocked: 'A failing criterion, a pull request in trouble (checks failing, conflicts, changes requested), or an agent waiting on an approval or a lock',
  unverified: 'Acceptance criteria not tested yet, or a task in Testing or Done with no criteria at all',
};

type BoardInput = Pick<SessionState, 'tasks' | 'chats' | 'messages' | 'github' | 'locks' | 'planning'>;

/** Why a task is blocked, in short phrases; empty when it is not. */
export function taskBlockers(input: Omit<BoardInput, 'tasks' | 'planning'>, task: Task): string[] {
  const reasons: string[] = [];
  const failing = task.criteria.filter((c) => c.state === 'failing').length;
  if (failing > 0) reasons.push(`${failing} failing ${failing === 1 ? 'criterion' : 'criteria'}`);
  const pull = pullForBranch(input.github, task.branch);
  if (pull) reasons.push(...pullProblems(pull));
  for (const chat of input.chats) {
    if (chat.taskId !== task.id) continue;
    const pending = (input.messages[chat.id] ?? []).some((m) => m.approval?.state === 'pending');
    if (pending || (chat.state === 'waiting' && chat.activity?.startsWith(APPROVAL_ACTIVITY_PREFIX))) reasons.push('waiting on approval');
    else if (chat.state === 'waiting' && parseLockWait(chat.activity)) reasons.push('waiting on a lock');
  }
  return [...new Set(reasons)];
}

/** Whether the task's work is not shown to work yet. */
export function taskUnverified(task: Task): boolean {
  if (task.criteria.length === 0) return task.stage === 'testing' || task.stage === 'done';
  return task.criteria.some((c) => c.state === 'untested');
}

function matchesFilter(input: BoardInput, task: Task, filter: BoardFilter, youId: string | null): boolean {
  const chats = input.chats.filter((c) => c.taskId === task.id);
  switch (filter) {
    case 'mine':
      return !!youId && (task.owner?.id === youId || chats.some((c) => c.createdBy.id === youId && c.state !== 'idle'));
    case 'agents':
      return (
        task.owner?.kind === 'agent' ||
        chats.some((c) => c.state !== 'idle' || (c.worktree?.files.length ?? 0) > 0) ||
        input.locks.some((l) => l.taskId === task.id && l.holder.kind === 'agent')
      );
    case 'blocked':
      return taskBlockers(input, task).length > 0;
    case 'unverified':
      return taskUnverified(task);
  }
}

/** Words the search looks in: title, branch, owner, feature and acceptance criteria. */
function searchText(input: BoardInput, task: Task): string {
  const feature = task.featureId ? input.planning.find((i) => i.id === task.featureId) : undefined;
  return [task.title, task.branch, task.owner?.name, feature?.title, feature?.body, ...task.criteria.map((c) => c.text)]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

/** The tasks the board shows: every search word must appear, and every chosen filter must match. */
export function filterBoard(input: BoardInput, youId: string | null, query: string, filters: readonly BoardFilter[]): Task[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return input.tasks.filter((task) => {
    if (!filters.every((f) => matchesFilter(input, task, f, youId))) return false;
    if (words.length === 0) return true;
    const text = searchText(input, task);
    return words.every((w) => text.includes(w));
  });
}

/** Whether a lock covers a changed file: the same path, or a file inside a locked folder. */
function lockCovers(lock: Lock, file: string): boolean {
  return samePath(lock.path, file) || file.toLowerCase().startsWith(`${lock.path.toLowerCase()}/`);
}

/**
 * Locks to free after you commit in your project folder.
 * - yours: your own locks on files that have no uncommitted changes now. The
 *   app offers to release these; you may have locked a file for work still to come.
 * - agents: locks an agent running on your PC holds on files the commit
 *   included, when that agent works in your project folder (no copy of its
 *   own) and is between turns. These are freed straight away: the agent would
 *   free them at its next turn end anyway.
 */
export function locksAfterCommit(
  input: Pick<SessionState, 'locks' | 'chats' | 'participants'>,
  youId: string | null,
  committed: readonly string[],
  stillChanged: readonly string[],
): { yours: Lock[]; agents: Lock[] } {
  if (!youId) return { yours: [], agents: [] };
  const clean = (lock: Lock) => !stillChanged.some((file) => lockCovers(lock, file));
  const yours = input.locks.filter((l) => l.holder.id === youId && clean(l));
  const agents = input.locks.filter((lock) => {
    if (lock.holder.kind !== 'agent' || !lock.chatId || !clean(lock)) return false;
    if (!committed.some((file) => lockCovers(lock, file))) return false;
    const chat = input.chats.find((c) => c.id === lock.chatId);
    if (!chat || chat.worktree || chat.state !== 'idle') return false;
    const agent = input.participants.find((p) => p.id === lock.holder.id);
    return agent?.agent?.startedById === youId;
  });
  return { yours, agents };
}

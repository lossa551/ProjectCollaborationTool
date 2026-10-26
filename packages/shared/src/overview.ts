import type { SessionState } from './client.js';
import { STAGE_LABELS, type Activity, type ChatInfo, type Lock, type Participant, type PullRequest, type Task, type TaskStage } from './model.js';
import { filesOutsideScope, type Overlap } from './overlap.js';
import { samePath } from './paths.js';
import { featureStatus, plannedTasks, type FeatureState } from './planning.js';
import { issuesToClose, newIssues } from './issues.js';

// The Home screen (issue #34): what needs you, who is doing what, the state of
// the features, and what changed while you were away. Worked out here, in one
// place, so the nav count and (later) notifications agree with Home.

/** The one line an agent shows while it waits for someone to free a file; see parseLockWait. */
export function lockWaitActivity(names: string, path: string): string {
  return `Waiting for ${names} to release ${path}`;
}

/** The file an agent is waiting on, from its chat's activity line. */
export function parseLockWait(activity: string | null): string | null {
  const match = /^Waiting for .+? to release (.+)$/.exec(activity ?? '');
  return match ? match[1]! : null;
}

export const APPROVAL_ACTIVITY_PREFIX = 'Waiting for approval: ';

export function approvalActivity(action: string): string {
  return `${APPROVAL_ACTIVITY_PREFIX}${action}`;
}

export type NeedKind = 'approval' | 'lock-wait' | 'pull' | 'outside-scope' | 'overlap' | 'abandoned-lock' | 'plan' | 'close-issue';

/** Where you act on an item. */
export type NeedTarget =
  | { screen: 'chat'; chatId: string }
  | { screen: 'task'; taskId: string }
  | { screen: 'planning'; itemId: string }
  | { screen: 'overlaps' }
  | { screen: 'issues' }
  | { screen: 'url'; url: string };

export interface NeedItem {
  /** Stable while the item stays, so a list can keep its place. */
  id: string;
  kind: NeedKind;
  tone: 'bad' | 'warn';
  text: string;
  detail: string | null;
  target: NeedTarget;
  /** Done in place on Home instead of going somewhere. */
  act:
    | { type: 'release-lock' | 'recover-lock'; lockId: string }
    /** Closing needs the person to confirm the comment first; see issuesToClose. */
    | { type: 'close-issue'; number: number; comment: string; featureId: string }
    | null;
}

type OverviewInput = Pick<
  SessionState,
  'participants' | 'tasks' | 'locks' | 'github' | 'workspaces' | 'agents' | 'chats' | 'messages' | 'planning' | 'issueMarks'
>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function agentName(input: Pick<SessionState, 'agents'>, chat: ChatInfo): string {
  return input.agents.find((a) => a.id === chat.agentId)?.name ?? 'An agent';
}

/** Branches you work on: your checkout's, and those of the tasks you own. The default branch belongs to nobody. */
export function yourBranches(input: Pick<SessionState, 'tasks' | 'workspaces' | 'github'>, youId: string | null): Set<string> {
  const branches = new Set<string>();
  if (!youId) return branches;
  const own = input.workspaces[youId]?.branch;
  if (own) branches.add(own);
  for (const task of input.tasks) if (task.owner?.id === youId && task.branch) branches.add(task.branch);
  if (input.github.defaultBranch) branches.delete(input.github.defaultBranch);
  return branches;
}

/** What is wrong with an open pull request, if anything. */
export function pullProblems(pull: PullRequest): string[] {
  if (pull.state !== 'open') return [];
  const problems: string[] = [];
  if (pull.checks === 'failure') problems.push('checks failing');
  if (pull.mergeable === 'conflicting') problems.push('conflicts');
  if (pull.review === 'changes_requested') problems.push('changes requested');
  return problems;
}

/** The task someone's checkout is on: the one linked to its branch, preferring their own. */
export function taskOfWorkspace(tasks: Task[], participantId: string, branch: string | null): Task | undefined {
  if (!branch) return undefined;
  const linked = tasks.filter((t) => t.branch === branch);
  return linked.find((t) => t.owner?.id === participantId) ?? linked[0];
}

/** Features whose plan lists tasks but has not been approved yet. */
function plansWaiting(input: OverviewInput) {
  return input.planning.filter(
    (item) =>
      item.kind === 'feature' &&
      item.approvedAt === null &&
      plannedTasks(item.tasks).length > 0 &&
      !input.tasks.some((t) => t.featureId === item.id),
  );
}

/**
 * Everything that needs a person, most urgent first: agents held up by you or
 * waiting for a decision, your pull requests and files in trouble, then things
 * anyone can pick up.
 */
export function needsYou(input: OverviewInput, youId: string | null, overlaps: Overlap[]): NeedItem[] {
  const items: NeedItem[] = [];

  for (const chat of input.chats) {
    const pending = (input.messages[chat.id] ?? []).filter((m) => m.approval?.state === 'pending');
    const name = agentName(input, chat);
    if (pending.length > 0) {
      for (const m of pending) {
        items.push({
          id: `approval:${m.id}`,
          kind: 'approval',
          tone: 'warn',
          text: `${name} asks to ${lowerFirst(m.approval!.action)}`,
          detail: chat.title,
          target: { screen: 'chat', chatId: chat.id },
          act: null,
        });
      }
    } else if (chat.state === 'waiting' && chat.activity?.startsWith(APPROVAL_ACTIVITY_PREFIX)) {
      // The chat's messages are not loaded here yet; its activity line says enough.
      items.push({
        id: `approval:${chat.id}`,
        kind: 'approval',
        tone: 'warn',
        text: `${name} asks to ${lowerFirst(chat.activity.slice(APPROVAL_ACTIVITY_PREFIX.length))}`,
        detail: chat.title,
        target: { screen: 'chat', chatId: chat.id },
        act: null,
      });
    }

    const waitingOn = chat.state === 'waiting' ? parseLockWait(chat.activity) : null;
    if (waitingOn && youId) {
      const yours = input.locks.find((l) => l.holder.id === youId && samePath(l.path, waitingOn));
      if (yours) {
        items.push({
          id: `lock-wait:${chat.id}:${yours.id}`,
          kind: 'lock-wait',
          tone: 'warn',
          text: `${name} is waiting for you to release ${yours.path}`,
          detail: chat.title,
          target: { screen: 'chat', chatId: chat.id },
          act: { type: 'release-lock', lockId: yours.id },
        });
      }
    }
  }

  const branches = yourBranches(input, youId);
  for (const pull of input.github.pulls) {
    const problems = pullProblems(pull);
    if (problems.length === 0 || !branches.has(pull.branch)) continue;
    items.push({
      id: `pull:${pull.number}`,
      kind: 'pull',
      tone: 'bad',
      text: `PR #${pull.number} ${pull.title}: ${problems.join(', ')}`,
      detail: pull.branch,
      target: { screen: 'url', url: pull.url },
      act: null,
    });
  }

  const workspace = youId ? input.workspaces[youId] : undefined;
  const task = workspace && youId ? taskOfWorkspace(input.tasks, youId, workspace.branch) : undefined;
  if (workspace && task) {
    const outside = filesOutsideScope(
      workspace.files.map((f) => f.path),
      task.scope,
    );
    if (outside.length > 0) {
      items.push({
        id: `outside-scope:${task.id}`,
        kind: 'outside-scope',
        tone: 'bad',
        text: `Your workspace has ${plural(outside.length, 'file')} outside "${task.title}"`,
        detail: outside.slice(0, 3).join(', ') + (outside.length > 3 ? ', …' : ''),
        target: { screen: 'task', taskId: task.id },
        act: null,
      });
    }
  }

  if (youId) {
    const mine = overlaps.filter((o) =>
      o.sources.some((s) => (s.kind === 'workspace' && s.participantId === youId) || (s.kind === 'lock' && s.holderId === youId)),
    );
    if (mine.length > 0) {
      items.push({
        id: 'overlap',
        kind: 'overlap',
        tone: 'warn',
        text: `${plural(mine.length, 'file')} you are changing ${mine.length === 1 ? 'is' : 'are'} also changed elsewhere`,
        detail: mine.slice(0, 3).map((o) => o.path).join(', ') + (mine.length > 3 ? ', …' : ''),
        target: { screen: 'overlaps' },
        act: null,
      });
    }
  }

  for (const lock of input.locks) {
    if (!lock.abandoned || lock.holder.id === youId) continue;
    items.push({
      id: `abandoned:${lock.id}`,
      kind: 'abandoned-lock',
      tone: 'warn',
      text: `${lock.path} is still locked by ${lock.holder.name}, who stopped answering`,
      detail: 'You can recover the lock',
      target: lock.taskId ? { screen: 'task', taskId: lock.taskId } : { screen: 'overlaps' },
      act: { type: 'recover-lock', lockId: lock.id },
    });
  }

  for (const item of plansWaiting(input)) {
    const count = plannedTasks(item.tasks).length;
    items.push({
      id: `plan:${item.id}`,
      kind: 'plan',
      tone: 'warn',
      text: `Plan "${item.title}" is waiting for approval`,
      detail: `${plural(count, 'task')} planned`,
      target: { screen: 'planning', itemId: item.id },
      act: null,
    });
  }

  for (const close of issuesToClose(input)) {
    items.push({
      id: `close-issue:${close.issue.number}`,
      kind: 'close-issue',
      tone: 'warn',
      text: `"${close.feature.title}" is done: close issue #${close.issue.number}?`,
      detail: close.issue.title,
      target: { screen: 'url', url: close.issue.url },
      act: { type: 'close-issue', number: close.issue.number, comment: close.comment, featureId: close.feature.id },
    });
  }

  return items;
}

const lowerFirst = (text: string) => (text ? text[0]!.toLowerCase() + text.slice(1) : text);

/** How many features are in each state, for the Home overview. */
export function featureCounts(input: Pick<SessionState, 'planning' | 'tasks'>): Record<FeatureState, number> {
  const counts: Record<FeatureState, number> = { blocked: 0, unverified: 0, ready: 0, 'in-progress': 0, planning: 0 };
  for (const item of input.planning) {
    if (item.kind !== 'feature') continue;
    counts[featureStatus(item, input.planning, input.tasks).state] += 1;
  }
  return counts;
}

/** One line of "Who is doing what". */
export interface Doing {
  participant: Participant;
  task: Task | null;
  branch: string | null;
  /** Changed files in their checkout; null for agents and people without a project folder. */
  files: number | null;
  /** What an agent is doing right now, and in which chat. */
  activity: string | null;
  chatId: string | null;
  state: ChatInfo['state'] | null;
  locks: Lock[];
}

export function whoIsDoing(input: Pick<SessionState, 'participants' | 'tasks' | 'locks' | 'workspaces' | 'chats'>): Doing[] {
  return input.participants.map((participant) => {
    const locks = input.locks.filter((l) => l.holder.id === participant.id);
    if (participant.agent) {
      const chats = input.chats
        .filter((c) => c.agentId === participant.agent!.profileId && c.state !== 'idle')
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const chat = chats[0] ?? null;
      const task = chat?.taskId ? (input.tasks.find((t) => t.id === chat.taskId) ?? null) : null;
      return {
        participant,
        task,
        branch: task?.branch ?? null,
        files: null,
        activity: chat ? (chat.activity ?? (chat.state === 'waiting' ? 'Waiting' : 'Working')) : null,
        chatId: chat?.id ?? null,
        state: chat?.state ?? null,
        locks,
      };
    }
    const workspace = input.workspaces[participant.id];
    const own = input.tasks
      .filter((t) => t.owner?.id === participant.id && t.stage !== 'done' && t.stage !== 'planning')
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const task = taskOfWorkspace(input.tasks, participant.id, workspace?.branch ?? null) ?? own[0] ?? null;
    return {
      participant,
      task,
      branch: workspace?.branch ?? null,
      files: workspace ? workspace.files.length : null,
      activity: null,
      chatId: null,
      state: null,
      locks,
    };
  });
}

// "Since you were last here": what changed while you were away, grouped by
// what it means rather than as a raw feed.

export interface DigestLine {
  text: string;
  target: NeedTarget | null;
}

export interface DigestGroup {
  key: 'stages' | 'pulls' | 'issues' | 'criteria' | 'agents' | 'plans' | 'memory' | 'people';
  title: string;
  lines: DigestLine[];
}

const MOVED = /^moved "(.+)" to (Planning|Implementing|Review|Testing|Done)$/;

export function sinceLastHere(
  input: Pick<SessionState, 'tasks' | 'github' | 'agents' | 'chats' | 'planning' | 'memory' | 'activity'>,
  since: number,
  yourName: string | null,
): DigestGroup[] {
  const groups: DigestGroup[] = [];
  const recent = input.activity.filter((a) => a.at > since && a.actorName !== yourName);
  const taskByTitle = (title: string) => input.tasks.find((t) => t.title === title);

  // Tasks that moved stage, by the stage they ended up in (their latest move only).
  const lastMove = new Map<string, TaskStage>();
  for (const entry of recent) {
    const match = MOVED.exec(entry.text);
    if (!match) continue;
    const stage = (Object.keys(STAGE_LABELS) as TaskStage[]).find((s) => STAGE_LABELS[s] === match[2]);
    if (stage) lastMove.set(match[1]!, stage);
  }
  if (lastMove.size > 0) {
    const byStage = new Map<TaskStage, string[]>();
    for (const [title, stage] of lastMove) byStage.set(stage, [...(byStage.get(stage) ?? []), title]);
    groups.push({
      key: 'stages',
      title: 'Tasks that moved',
      lines: [...byStage].map(([stage, titles]) => ({
        text: `${STAGE_LABELS[stage]}: ${titles.map((t) => `"${t}"`).join(', ')}`,
        target: titles.length === 1 && taskByTitle(titles[0]!) ? { screen: 'task', taskId: taskByTitle(titles[0]!)!.id } : null,
      })),
    });
  }

  const pulls = input.github.pulls.filter((p) => p.updatedAt > since && (p.state === 'merged' || pullProblems(p).length > 0));
  if (pulls.length > 0) {
    groups.push({
      key: 'pulls',
      title: 'Pull requests',
      lines: pulls.map((p) => ({
        text: `#${p.number} ${p.title}: ${p.state === 'merged' ? 'merged' : pullProblems(p).join(', ')}`,
        target: { screen: 'url', url: p.url },
      })),
    });
  }

  const opened = newIssues(input, since);
  if (opened.length > 0) {
    groups.push({
      key: 'issues',
      title: 'New issues',
      lines: opened.map((i) => ({ text: `#${i.number} ${i.title} (${i.author})`, target: { screen: 'url', url: i.url } })),
    });
  }

  const criteria = input.tasks.flatMap((task) =>
    task.criteria.filter((c) => c.at !== null && c.at > since && c.state !== 'untested').map((c) => ({ task, c })),
  );
  if (criteria.length > 0) {
    const failing = criteria.filter((x) => x.c.state === 'failing');
    const verified = criteria.length - failing.length;
    groups.push({
      key: 'criteria',
      title: 'Test results',
      lines: [
        ...failing.map(({ task, c }) => ({
          text: `Failing: ${c.text} ("${task.title}"${c.by ? `, ${c.by}` : ''})`,
          target: { screen: 'task', taskId: task.id } as const,
        })),
        ...(verified > 0 ? [{ text: `${plural(verified, 'criterion', 'criteria')} verified`, target: null }] : []),
      ],
    });
  }

  const chats = input.chats.filter((c) => c.updatedAt > since && c.state === 'idle');
  if (chats.length > 0) {
    groups.push({
      key: 'agents',
      title: 'Agents that finished',
      lines: chats.map((c) => ({ text: `${agentName(input, c)} in "${c.title}"`, target: { screen: 'chat', chatId: c.id } })),
    });
  }

  const plans = input.planning.filter((i) => i.createdAt > since || (i.approvedAt !== null && i.approvedAt > since));
  if (plans.length > 0) {
    groups.push({
      key: 'plans',
      title: 'Planning',
      lines: plans.map((i) => ({
        text: i.approvedAt !== null && i.approvedAt > since ? `Approved "${i.title}"` : `New ${i.kind}: "${i.title}" (${i.createdBy})`,
        target: { screen: 'planning', itemId: i.id },
      })),
    });
  }

  const memory = input.memory.filter((e) => e.createdAt > since);
  if (memory.length > 0) {
    groups.push({
      key: 'memory',
      title: 'Project memory',
      lines: memory.map((e) => ({ text: `"${e.title}" (${e.createdBy})`, target: null })),
    });
  }

  const byActor = new Map<string, number>();
  for (const entry of recent) if (entry.actorName) byActor.set(entry.actorName, (byActor.get(entry.actorName) ?? 0) + 1);
  if (byActor.size > 0) {
    groups.push({
      key: 'people',
      title: 'Who was busy',
      lines: [...byActor]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ text: `${name}: ${plural(count, 'change')}`, target: null })),
    });
  }
  return groups;
}

/** An activity line, possibly standing for a run of similar ones. */
export interface GroupedActivity extends Activity {
  count: number;
}

const LOCK_EVENT = /^(locked|released) (\S+?)( \(exclusive\))?$/;
const GROUP_WINDOW_MS = 10 * 60_000;

/** Folds runs of lock events by the same person into one line: "locked 3 files in scripts/player". */
export function groupActivity(entries: Activity[]): GroupedActivity[] {
  const out: (GroupedActivity & { verb?: string; paths?: string[] })[] = [];
  for (const entry of entries) {
    const match = LOCK_EVENT.exec(entry.text);
    const last = out[out.length - 1];
    if (match && last && last.verb === match[1] && last.actorName === entry.actorName && entry.at - last.at <= GROUP_WINDOW_MS) {
      last.paths!.push(match[2]!);
      last.count += 1;
      last.at = entry.at;
      last.id = entry.id;
      last.taskId = last.taskId === entry.taskId ? last.taskId : null;
      last.text = `${match[1]} ${last.paths!.length} files${commonFolder(last.paths!)}`;
      continue;
    }
    out.push({ ...entry, count: 1, ...(match ? { verb: match[1], paths: [match[2]!] } : {}) });
  }
  return out.map(({ verb: _verb, paths: _paths, ...entry }) => entry);
}

function commonFolder(paths: string[]): string {
  const parts = paths.map((p) => p.split('/').slice(0, -1));
  const first = parts[0] ?? [];
  let n = 0;
  while (n < first.length && parts.every((p) => p[n] === first[n])) n += 1;
  return n > 0 ? ` in ${first.slice(0, n).join('/')}` : '';
}

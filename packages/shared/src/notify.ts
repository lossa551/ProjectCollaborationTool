import type { SessionState } from './client.js';
import type { ChatAgentState, ChatInfo } from './model.js';
import { samePath } from './paths.js';
import { needsYou, parseLockWait, pullProblems, yourBranches, type NeedTarget } from './overview.js';

// Windows notifications (issue #35): what to tell you about while the app is
// in the background. The tracker compares each session state with the last
// one and returns only what is new, so a toast shows once per thing.

export type NoticeKind = 'approval' | 'agent' | 'lock-wait' | 'pull' | 'connection' | 'engine';

export const NOTICE_KINDS: { kind: NoticeKind; label: string; detail: string }[] = [
  { kind: 'approval', label: 'Approvals', detail: 'An agent asks for approval in a chat you started or opened.' },
  { kind: 'agent', label: 'Agents finished or stuck', detail: 'An agent in a chat you started or opened finishes a turn, fails, or waits for a lock.' },
  { kind: 'lock-wait', label: 'Your locks', detail: 'Someone is waiting for a file you have locked.' },
  { kind: 'pull', label: 'Your pull requests', detail: 'A check fails or a merge conflict appears on your pull request.' },
  { kind: 'connection', label: 'Host connection', detail: 'The host goes offline or comes back (when you joined a session).' },
  { kind: 'engine', label: 'Game engine', detail: 'Godot or Summer Engine opens your project while others hold locks in it, or the Locks plugin is missing.' },
];

/** How a failed agent turn starts its notice in the chat; the runner writes it. */
export const AGENT_ERROR_PREFIX = 'Something went wrong: ';

export interface Notice {
  /** Stable while the thing stays, so it is not shown twice. */
  key: string;
  kind: NoticeKind;
  title: string;
  body: string;
  /** Where clicking the toast takes you; null just brings the app forward. */
  target: NeedTarget | null;
}

export type NoticeInput = Pick<
  SessionState,
  'status' | 'you' | 'session' | 'participants' | 'tasks' | 'locks' | 'github' | 'workspaces' | 'agents' | 'chats' | 'messages' | 'planning' | 'issueMarks'
>;

/** Chats you follow: ones you started, and ones you opened in this app (their messages are loaded). */
export function watchedChat(input: Pick<SessionState, 'you' | 'messages'>, chat: ChatInfo): boolean {
  return chat.createdBy.id === input.you?.id || input.messages[chat.id] !== undefined;
}

const agentName = (input: Pick<SessionState, 'agents'>, chat: ChatInfo) =>
  input.agents.find((a) => a.id === chat.agentId)?.name ?? 'An agent';

/** Things that need you now, each with a key that stays the same while it lasts. */
export function standingNotices(input: NoticeInput): Notice[] {
  const youId = input.you?.id ?? null;
  const notices: Notice[] = [];
  const chatOf = (id: string) => input.chats.find((c) => c.id === id);

  for (const need of needsYou(input, youId, [])) {
    if (need.kind === 'approval' && need.target.screen === 'chat') {
      const chat = chatOf(need.target.chatId);
      if (!chat || !watchedChat(input, chat)) continue;
      notices.push({ key: need.id, kind: 'approval', title: 'Approval needed', body: `${need.text} (${chat.title})`, target: need.target });
    } else if (need.kind === 'lock-wait') {
      notices.push({ key: need.id, kind: 'lock-wait', title: 'Waiting for your lock', body: need.text, target: need.target });
    }
  }

  // Agents in your chats held up by someone else's lock.
  for (const chat of input.chats) {
    const path = chat.state === 'waiting' ? parseLockWait(chat.activity) : null;
    if (!path || !watchedChat(input, chat)) continue;
    if (input.locks.some((l) => l.holder.id === youId && samePath(l.path, path))) continue; // Told as lock-wait.
    notices.push({
      key: `stuck-lock:${chat.id}:${path}`,
      kind: 'agent',
      title: `${agentName(input, chat)} is stuck`,
      body: `${chat.activity} (${chat.title})`,
      target: { screen: 'chat', chatId: chat.id },
    });
  }

  const branches = yourBranches(input, youId);
  for (const pull of input.github.pulls) {
    if (!branches.has(pull.branch)) continue;
    const problems = pullProblems(pull);
    for (const [problem, text] of [
      ['checks failing', 'A check failed'],
      ['conflicts', 'Merge conflict'],
    ] as const) {
      if (!problems.includes(problem)) continue;
      notices.push({
        key: `pull:${pull.number}:${problem}`,
        kind: 'pull',
        title: `${text} on PR #${pull.number}`,
        body: pull.title,
        target: { screen: 'url', url: pull.url },
      });
    }
  }
  return notices;
}

/** The chat's last notice, when the turn that just ended failed. */
function failure(input: Pick<SessionState, 'messages'>, chatId: string): string | null {
  const messages = input.messages[chatId] ?? [];
  const last = [...messages].reverse().find((m) => m.kind !== 'checkpoint');
  return last?.kind === 'notice' && last.text.startsWith(AGENT_ERROR_PREFIX) ? last.text.slice(AGENT_ERROR_PREFIX.length) : null;
}

/**
 * Works out which notices are new since the last state. The first state of a
 * session only sets the baseline: what already needed you is on Home.
 */
export class NoticeTracker {
  private sessionId: string | null = null;
  private shown = new Set<string>();
  private chatStates = new Map<string, ChatAgentState>();
  private connected = false;
  private offline = false;

  update(input: NoticeInput, options: { joiner: boolean }): Notice[] {
    const sessionId = input.session?.id ?? null;
    const standing = sessionId ? standingNotices(input) : [];
    if (sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      this.shown = new Set(standing.map((n) => n.key));
      this.chatStates = new Map(input.chats.map((c) => [c.id, c.state]));
      this.connected = input.status === 'connected';
      this.offline = false;
      return [];
    }
    if (!sessionId) return [];

    const fresh: Notice[] = standing.filter((n) => !this.shown.has(n.key));
    // Keep only what still stands, so the same thing coming back later shows again.
    this.shown = new Set(standing.map((n) => n.key));

    for (const chat of input.chats) {
      const before = this.chatStates.get(chat.id);
      if (before && before !== 'idle' && chat.state === 'idle' && watchedChat(input, chat)) {
        const error = failure(input, chat.id);
        fresh.push({
          key: `turn:${chat.id}:${chat.updatedAt}`,
          kind: 'agent',
          title: error ? `${agentName(input, chat)} is stuck` : `${agentName(input, chat)} finished`,
          body: error ? `${error} (${chat.title})` : chat.title,
          target: { screen: 'chat', chatId: chat.id },
        });
      }
    }
    this.chatStates = new Map(input.chats.map((c) => [c.id, c.state]));

    if (input.status === 'connected') {
      if (this.offline && options.joiner) {
        fresh.push({ key: 'host-back', kind: 'connection', title: 'Host is back', body: 'The session is live again; changes made offline are syncing.', target: null });
      }
      this.connected = true;
      this.offline = false;
    } else if (input.status === 'reconnecting' && this.connected && !this.offline) {
      this.offline = true;
      if (options.joiner) {
        fresh.push({ key: 'host-offline', kind: 'connection', title: 'Host went offline', body: 'You can keep working; changes sync when the host is back.', target: null });
      }
    }
    return fresh;
  }
}

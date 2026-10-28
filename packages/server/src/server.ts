import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  CloseCode,
  DEFAULT_PRICES,
  PROTOCOL_VERSION,
  addUsage,
  withDefaultTiers,
  formatCost,
  usageKey,
  commitDraftUsageId,
  SOCKET_PATH,
  decodeBytes,
  encodeBytes,
  parseClientMessage,
  type Activity,
  type ChatInfo,
  type GitHubStatus,
  type Lock,
  type ErrorCode,
  type Participant,
  type ServerMessage,
  type SessionInfo,
  type UsageRow,
  type Workspace,
} from '@pct/shared';
import { TaskBoard } from './board.js';
import { AgentChats, CHAT_HISTORY_LIMIT } from './chats.js';
import { SharedDocs } from './docs.js';
import { GitHubWatcher, describeGitHubChanges, type GitHubOptions } from './github.js';
import { LockTable } from './locks.js';
import { MemoryStorage, type Identity, type SessionAccess, type Storage } from './storage.js';

export interface ServerOptions {
  /** Port to listen on; 0 picks a free one. Default 7420. */
  port?: number;
  /** Interface to bind; default 0.0.0.0 so Tailscale peers can connect. */
  host?: string;
  /** Shared secret every participant must present. Otherwise the stored one, or a new one that is then stored. */
  secret?: string;
  sessionName?: string;
  storage?: Storage;
  /** PEM key and certificate to serve wss:// instead of ws://. */
  tls?: { key: string | Buffer; cert: string | Buffer };
  /** How often to ping clients and drop the ones that stopped answering. */
  heartbeatMs?: number;
  /** How long a lock holder may be silent before the lock counts as abandoned. Default 60 s. */
  lockStaleMs?: number;
  /** How long a new connection may take to send its hello. */
  helloTimeoutMs?: number;
  /** How the server reaches GitHub; the token can also be set later with setGitHubToken. */
  github?: GitHubOptions;
  log?: (line: string) => void;
}

export interface RunningServer {
  port: number;
  /** The secret in the current invite code; newSecret changes it. */
  readonly secret: string;
  session: SessionInfo;
  /** Local WebSocket URL, for a client on the same machine. */
  localUrl: string;
  participants(): Participant[];
  github(): GitHubStatus;
  /** Sets or clears the token used for GitHub; polling starts again with it. */
  setGitHubToken(token: string | null): void;
  /**
   * Makes a new invite secret and sends it to everyone connected. The old
   * code then only lets back in people who had joined before (their saved
   * Rejoin keeps working); anyone holding only the old code is refused.
   */
  newSecret(by: string | null): Promise<string>;
  /**
   * Host only: disconnects a person and the agents they started, frees their
   * locks and refuses them until they get an invite code made after this.
   */
  removeParticipant(id: string, by: string | null): Promise<{ ok: true; name: string } | { ok: false; message: string }>;
  close(): Promise<void>;
}

interface Connection {
  socket: WebSocket;
  participant: Participant | null;
  alive: boolean;
  /** Set when the host removed them, so leaving is not reported as well. */
  removed?: boolean;
}

const ACTIVITY_ON_JOIN = 100;
/** Earlier invite secrets kept, so people offline through a few new codes can still rejoin. */
const RETIRED_SECRETS = 10;

export function generateSecret(): string {
  return randomBytes(24).toString('base64url');
}

function secretsMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const storage = options.storage ?? new MemoryStorage();
  let secret = options.secret ?? (await storage.loadSecret());
  if (!secret) {
    secret = generateSecret();
    await storage.saveSecret(secret);
  }
  let sessionSecret = secret;
  let access: SessionAccess = (await storage.loadAccess()) ?? { issuedAt: 0, retired: [], removed: [] };
  const log = options.log ?? (() => {});
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
  const lockStaleMs = options.lockStaleMs ?? 60_000;

  let session = await storage.loadSession();
  if (!session) {
    session = { id: randomUUID(), name: options.sessionName ?? 'New session', createdAt: Date.now() };
    await storage.saveSession(session);
  } else if (options.sessionName && options.sessionName !== session.name) {
    session = { ...session, name: options.sessionName };
    await storage.saveSession(session);
  }
  const currentSession = session;
  const board = new TaskBoard(await storage.listTasks());
  // Holders of locks saved before a restart get a fresh grace period to come back.
  const startedAt = Date.now();
  const locks = new LockTable(
    (await storage.listLocks()).map((lock) => ({ ...lock, heartbeatAt: startedAt })),
    (await storage.loadLockRules()) ?? undefined,
  );
  /** Activity sent to clients when they join; storage keeps the full log. */
  const recentActivity = await storage.listActivity(ACTIVITY_ON_JOIN);
  const chats = new AgentChats(await storage.listAgents(), await storage.listChats(), storage);
  const docs = new SharedDocs(await storage.loadDocs(), (docId, state) => persist('shared document', storage.saveDoc(docId, state)));
  let bloat = await storage.loadBloat();
  const usage = new Map((await storage.listUsage()).map((row) => [usageKey(row), row] as const));
  // Tables saved before long-prompt prices existed (#92) get the default ones.
  const saved = await storage.loadPrices();
  let prices = saved ? withDefaultTiers(saved) : DEFAULT_PRICES;
  /** Each participant's local checkout, while they are connected. */
  const workspaces = new Map<string, Workspace>();

  const connections = new Set<Connection>();
  const joined = () =>
    [...connections].flatMap((c) => (c.participant ? [c.participant] : []));

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION, session: currentSession.name }));
      return;
    }
    res.writeHead(404).end();
  };
  const http = options.tls ? createHttpsServer(options.tls, onRequest) : createHttpServer(onRequest);
  const wss = new WebSocketServer({ server: http, path: SOCKET_PATH, maxPayload: 1024 * 1024 });

  const send = (conn: Connection, message: ServerMessage) => {
    if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(JSON.stringify(message));
  };
  const broadcast = (message: ServerMessage, except?: Connection) => {
    for (const conn of connections) {
      if (conn !== except && conn.participant) send(conn, message);
    }
  };
  const fail = (conn: Connection, code: ErrorCode, message: string, closeCode?: number) => {
    send(conn, { type: 'error', code, message });
    if (closeCode) conn.socket.close(closeCode, message);
  };
  const persist = (what: string, write: Promise<void>) =>
    write.catch((err: unknown) => log(`failed to save ${what}: ${String(err)}`));

  /** Adds a line to the activity feed and sends it to everyone. */
  const record = (actor: { name: string } | null, text: string, taskId: string | null = null) => {
    const entry: Activity = { id: randomUUID(), at: Date.now(), actorName: actor?.name ?? null, text, taskId };
    recentActivity.push(entry);
    if (recentActivity.length > ACTIVITY_ON_JOIN) recentActivity.shift();
    void persist('activity', storage.appendActivity(entry));
    broadcast({ type: 'activity', entry });
  };

  const findParticipant = (id: string) => joined().find((p) => p.id === id);

  const github = new GitHubWatcher(
    options.github ?? {},
    (status, previous) => {
      broadcast({ type: 'github.status', status });
      for (const change of describeGitHubChanges(previous, status)) {
        const task = change.branch ? board.list().find((t) => t.branch === change.branch) : undefined;
        record(null, change.text, task?.id ?? null);
      }
    },
    () => board.list().flatMap((t) => (t.branch ? [t.branch] : [])),
  );
  github.setRepo(await storage.loadGitHubRepo());

  const chatChanged = (chat: ChatInfo) => {
    void persist('chat', storage.saveChat(chat));
    broadcast({ type: 'chat.changed', chat });
  };

  const lockChanged = (lock: Lock) => {
    void persist('lock', storage.saveLock(lock));
    broadcast({ type: 'lock.changed', lock });
  };

  wss.on('connection', (socket) => {
    const conn: Connection = { socket, participant: null, alive: true };
    connections.add(conn);
    const helloTimer = setTimeout(() => {
      if (!conn.participant) socket.close(CloseCode.helloTimeout, 'No hello received');
    }, helloTimeoutMs);

    socket.on('pong', () => {
      conn.alive = true;
    });

    const handle = async (data: RawData, isBinary: boolean) => {
      const message = isBinary ? null : parseClientMessage(data.toString());
      if (!message) return fail(conn, 'bad_message', 'Could not read message');

      if (message.type === 'hello') {
        if (conn.participant) return fail(conn, 'already_joined', 'Already joined');
        if (message.protocol !== PROTOCOL_VERSION) {
          return fail(
            conn,
            'protocol_mismatch',
            `Server speaks protocol ${PROTOCOL_VERSION}, client sent ${message.protocol}. Update the app.`,
            CloseCode.protocolMismatch,
          );
        }
        const current = secretsMatch(message.secret, sessionSecret);
        const retired = current ? undefined : access.retired.find((r) => secretsMatch(message.secret, r.secret));
        if (!current && !retired) {
          return fail(conn, 'bad_secret', 'The invite code is wrong or out of date', CloseCode.badSecret);
        }
        if (message.agent) {
          const profile = message.kind === 'agent' ? chats.getAgent(message.agent.profileId) : undefined;
          if (!profile) return fail(conn, 'not_found', 'That agent is not set up in this session', CloseCode.agentRunning);
        }
        clearTimeout(helloTimer);
        const now = Date.now();
        const tokenHash = createHash('sha256').update(message.identity).digest('hex');
        const known = await storage.findIdentity(tokenHash);
        if (conn.socket.readyState !== conn.socket.OPEN) return;
        const refused = admit(known, message, retired);
        if (refused) return fail(conn, refused.code, refused.message, refused.closeCode);
        const identity = {
          id: known?.id ?? randomUUID(),
          name: message.name,
          kind: message.kind,
          createdAt: known?.createdAt ?? now,
          lastSeenAt: now,
        };
        void persist('identity', storage.saveIdentity(tokenHash, identity));
        if (conn.socket.readyState !== conn.socket.OPEN) return;

        // The same identity joining again (a second window, or a reconnect
        // before the old socket timed out) takes over from the old connection.
        for (const other of connections) {
          if (other.participant?.id !== identity.id) continue;
          other.participant = null;
          fail(other, 'replaced', 'You joined this session from another window', CloseCode.replaced);
        }
        // One runner per agent: a second PC starting the same agent is turned away.
        const running = message.agent && joined().find((p) => p.agent?.profileId === message.agent!.profileId);
        if (running) {
          return fail(
            conn,
            'agent_running',
            `${running.name} is already running on ${running.agent!.startedBy}'s PC`,
            CloseCode.agentRunning,
          );
        }

        const participant: Participant = {
          id: identity.id,
          name: identity.name,
          kind: identity.kind,
          status: 'active',
          focus: null,
          connectedAt: now,
          agent: message.agent ?? null,
        };
        conn.participant = participant;
        for (const lock of locks.refresh(participant.id, now)) lockChanged(lock);
        send(conn, {
          type: 'welcome',
          protocol: PROTOCOL_VERSION,
          you: participant,
          session: currentSession,
          participants: joined(),
          tasks: board.list(),
          locks: locks.list(),
          lockRules: locks.getRules(),
          activity: recentActivity,
          github: github.getStatus(),
          workspaces: [...workspaces].map(([participantId, workspace]) => ({ participantId, workspace })),
          agents: chats.listAgents(),
          chats: chats.listChats(),
          bloat,
          usage: [...usage.values()],
          prices,
        });
        // Joined with an earlier code: their app saves the current one for next time.
        if (retired) send(conn, { type: 'session.secret', secret: sessionSecret });
        broadcast({ type: 'participant.joined', participant }, conn);
        record(participant, 'joined the session');
        log(`${participant.name} (${participant.kind}) joined`);
        return;
      }

      const participant = conn.participant;
      if (!participant) return fail(conn, 'not_joined', 'Send hello first');

      switch (message.type) {
        case 'presence.update':
          participant.status = message.status;
          participant.focus = message.focus;
          broadcast({ type: 'presence', participantId: participant.id, status: message.status, focus: message.focus });
          break;
        case 'ping':
          send(conn, { type: 'pong', t: message.t });
          break;
        case 'task.create': {
          const result = board.create(message);
          if (!result.ok) return fail(conn, 'bad_message', result.message);
          if (result.descriptions.length === 0) {
            send(conn, { type: 'task.changed', task: result.task });
            break;
          }
          void persist('task', storage.saveTask(result.task));
          broadcast({ type: 'task.changed', task: result.task });
          for (const text of result.descriptions) record(participant, text, result.task.id);
          break;
        }
        case 'task.update': {
          // An agent must not raise its own budget.
          if (message.changes.budget !== undefined && participant.kind !== 'human') {
            return fail(conn, 'not_allowed', 'Only people set budgets');
          }
          const result = board.update(message.taskId, message.changes, findParticipant, message.expected);
          if (!result.ok) return fail(conn, 'not_found', result.message);
          if (result.conflicts.length > 0) {
            fail(conn, 'conflict', `Not applied: ${result.conflicts.join('; ')}.`);
            // Send the current task so the client drops its own version.
            send(conn, { type: 'task.changed', task: result.task });
          }
          if (result.descriptions.length === 0) break;
          void persist('task', storage.saveTask(result.task));
          broadcast({ type: 'task.changed', task: result.task });
          for (const text of result.descriptions) record(participant, text, result.task.id);
          // A finished task frees the locks its agents took for it.
          if (message.changes.stage === 'done') {
            const freed = locks.agentLocksOnTask(result.task.id);
            for (const lock of freed) {
              locks.drop(lock.id);
              void persist('lock', storage.deleteLock(lock.id));
              broadcast({ type: 'lock.removed', lockId: lock.id });
            }
            if (freed.length > 0) {
              const what = freed.length === 1 ? freed[0]!.path : `${freed.length} files`;
              record(null, `Agent locks on ${what} were released because "${result.task.title}" is done`, result.task.id);
            }
          }
          // A newly linked branch gets its ahead/behind and changed files.
          if (message.changes.branch) void github.refresh();
          break;
        }
        case 'task.delete': {
          const result = board.delete(message.taskId);
          // Already gone (deleted by someone else, or a replayed delete): nothing to do.
          if (!result.ok) break;
          void persist('task', storage.deleteTask(result.task.id));
          broadcast({ type: 'task.removed', taskId: result.task.id });
          for (const text of result.descriptions) record(participant, text, null);
          for (const lock of locks.detachTask(result.task.id)) lockChanged(lock);
          for (const chat of chats.detachTask(result.task.id)) chatChanged(chat);
          break;
        }
        case 'task.verify': {
          const result = board.verify(message.taskId, message.criterionId, message, participant.name);
          // A result for a task or criterion deleted in the meantime (often replayed after being offline) is dropped.
          if (!result.ok) break;
          if (result.descriptions.length === 0) break;
          void persist('task', storage.saveTask(result.task));
          broadcast({ type: 'task.changed', task: result.task });
          for (const text of result.descriptions) record(participant, text, result.task.id);
          break;
        }
        case 'doc.sync': {
          let stateVector: Uint8Array;
          try {
            stateVector = decodeBytes(message.stateVector);
          } catch {
            return fail(conn, 'bad_message', 'Could not read that document state');
          }
          const state = docs.stateFor(message.docId, stateVector);
          send(conn, {
            type: 'doc.state',
            docId: message.docId,
            update: encodeBytes(state.update),
            stateVector: encodeBytes(state.stateVector),
          });
          break;
        }
        case 'doc.update': {
          let update: Uint8Array;
          try {
            update = decodeBytes(message.update);
          } catch {
            return fail(conn, 'bad_message', 'Could not read that document change');
          }
          const result = docs.apply(message.docId, update);
          if (!result.ok) return fail(conn, 'bad_message', result.message);
          broadcast({ type: 'doc.changed', docId: message.docId, update: message.update }, conn);
          for (const text of result.descriptions) record(participant, text);
          break;
        }
        case 'bloat.report': {
          bloat = message.report;
          void persist('bloat check', storage.saveBloat(bloat));
          broadcast({ type: 'bloat.changed', report: bloat });
          record(participant, 'ran a bloat check');
          break;
        }
        case 'lock.acquire': {
          if (message.taskId && !board.get(message.taskId)) return fail(conn, 'not_found', 'That task no longer exists');
          const holder = { id: participant.id, name: participant.name, kind: participant.kind };
          const result = locks.acquire(message.path, holder, message);
          if (!result.ok) return fail(conn, result.code, result.message);
          lockChanged(result.lock);
          if (result.description) record(participant, result.description, result.lock.taskId);
          break;
        }
        case 'lock.release':
        case 'lock.recover': {
          const result =
            message.type === 'lock.release'
              ? locks.release(message.lockId, participant)
              : locks.recover(message.lockId, participant.id);
          if (!result.ok) return fail(conn, result.code, result.message);
          void persist('lock', storage.deleteLock(result.lock.id));
          broadcast({ type: 'lock.removed', lockId: result.lock.id });
          if (result.description) record(participant, result.description, result.lock.taskId);
          break;
        }
        case 'lock.rules.update': {
          const rules = locks.setRules(message.rules);
          void persist('lock rules', storage.saveLockRules(rules));
          broadcast({ type: 'lock.rules.changed', rules });
          record(participant, 'changed which files need an exclusive lock');
          break;
        }
        case 'github.link': {
          const repo = message.repo;
          void persist('GitHub repository', storage.saveGitHubRepo(repo));
          github.setRepo(repo);
          record(participant, repo ? `linked the session to ${repo.owner}/${repo.name} on GitHub` : 'unlinked the GitHub repository');
          break;
        }
        case 'github.issue.create':
        case 'github.issue.close': {
          const answer = (issue: { number: number; url: string } | null, error: string | null) =>
            send(conn, { type: 'github.issue.result', requestId: message.requestId, issue, error });
          // People decide what goes on GitHub; agents work through tasks.
          if (participant.kind !== 'human') return answer(null, 'Only people change issues on GitHub.');
          // Not awaited: the connection's other messages should not wait on GitHub.
          void (async () => {
            try {
              if (message.type === 'github.issue.create') {
                const issue = await github.createIssue(message.title, message.body);
                record(participant, `opened issue #${issue.number} "${message.title}" on GitHub`);
                answer(issue, null);
              } else {
                const title = github.getStatus().issues.find((i) => i.number === message.number)?.title;
                const issue = await github.closeIssue(message.number, message.comment);
                record(participant, `closed issue #${issue.number}${title ? ` "${title}"` : ''} on GitHub`);
                answer(issue, null);
              }
            } catch (error) {
              answer(null, error instanceof Error ? error.message : String(error));
            }
          })();
          break;
        }
        case 'workspace.update':
          if (message.workspace) workspaces.set(participant.id, message.workspace);
          else workspaces.delete(participant.id);
          broadcast({ type: 'workspace.changed', participantId: participant.id, workspace: message.workspace });
          break;
        case 'agent.save': {
          if (participant.kind !== 'human') return fail(conn, 'not_allowed', 'Only people set up agents');
          const result = chats.saveAgent(message.agent);
          if (!result.ok) return fail(conn, result.code, result.message);
          void persist('agent', storage.saveAgent(result.value));
          broadcast({ type: 'agent.changed', agent: result.value });
          if (result.description) record(participant, result.description);
          break;
        }
        case 'agent.delete': {
          if (participant.kind !== 'human') return fail(conn, 'not_allowed', 'Only people remove agents');
          const result = chats.deleteAgent(message.agentId);
          if (!result.ok) return fail(conn, result.code, result.message);
          void persist('agent', storage.deleteAgent(result.value.id));
          broadcast({ type: 'agent.removed', agentId: result.value.id });
          if (result.description) record(participant, result.description);
          // Its runner stops: the profile it runs is gone.
          for (const other of connections) {
            if (other.participant?.agent?.profileId === result.value.id) {
              fail(other, 'not_found', 'This agent was removed from the session', CloseCode.agentRunning);
            }
          }
          break;
        }
        case 'chat.create': {
          if (participant.kind !== 'human') return fail(conn, 'not_allowed', 'Only people start chats');
          if (message.taskId && !board.get(message.taskId)) return fail(conn, 'not_found', 'That task no longer exists');
          const result = chats.createChat(message, participant);
          if (!result.ok) return fail(conn, result.code, result.message);
          if (!result.description) {
            send(conn, { type: 'chat.changed', chat: result.value });
            break;
          }
          chatChanged(result.value);
          record(participant, result.description, result.value.taskId);
          break;
        }
        case 'chat.branch': {
          if (participant.kind !== 'human') return fail(conn, 'not_allowed', 'Only people branch chats');
          const result = await chats.branchChat(message, participant);
          if (!result.ok) return fail(conn, result.code, result.message);
          const { chat, messages } = result.value;
          if (!result.description) {
            send(conn, { type: 'chat.changed', chat });
            break;
          }
          chatChanged(chat);
          for (const m of messages) void persist('chat message', storage.saveChatMessage(m));
          // Everyone gets the copied messages at once, so the chat's agent can pick up where it left off.
          broadcast({ type: 'chat.history', chatId: chat.id, messages: messages.slice(-CHAT_HISTORY_LIMIT) });
          record(participant, result.description, chat.taskId);
          break;
        }
        case 'chat.update': {
          if (message.budget !== undefined && participant.kind !== 'human') return fail(conn, 'not_allowed', 'Only people set budgets');
          if (message.taskId && !board.get(message.taskId)) return fail(conn, 'not_found', 'That task no longer exists');
          const before = chats.getChat(message.chatId);
          const result = chats.updateChat(message.chatId, message);
          if (!result.ok) return fail(conn, result.code, result.message);
          chatChanged(result.value);
          if (message.budget !== undefined && before && before.budget !== message.budget) {
            const what = `the chat "${result.value.title}"`;
            record(
              participant,
              message.budget === null ? `removed the budget of ${what}` : `set a ${formatCost(message.budget)} budget for ${what}`,
              result.value.taskId,
            );
          }
          break;
        }
        case 'chat.delete': {
          if (participant.kind !== 'human') return fail(conn, 'not_allowed', 'Only people delete chats');
          const result = chats.deleteChat(message.chatId);
          if (!result.ok) break;
          void persist('chat', storage.deleteChat(result.value.id));
          broadcast({ type: 'chat.removed', chatId: result.value.id });
          if (result.description) record(participant, result.description, result.value.taskId);
          break;
        }
        case 'chat.open': {
          if (!chats.getChat(message.chatId)) return fail(conn, 'not_found', 'That chat no longer exists');
          send(conn, { type: 'chat.history', chatId: message.chatId, messages: await chats.history(message.chatId) });
          break;
        }
        case 'chat.post': {
          const result = await chats.post(message.chatId, message.message, participant);
          if (!result.ok) return fail(conn, result.code, result.message);
          if (result.value.persist) void persist('chat message', storage.saveChatMessage(result.value.message));
          broadcast({ type: 'chat.message', message: result.value.message });
          break;
        }
        case 'chat.decide': {
          const result = await chats.decide(message.chatId, message.messageId, message.approve, participant);
          if (!result.ok) return fail(conn, result.code, result.message);
          void persist('chat message', storage.saveChatMessage(result.value));
          broadcast({ type: 'chat.message', message: result.value });
          if (result.description) record(participant, result.description, chats.getChat(message.chatId)?.taskId ?? null);
          break;
        }
        case 'chat.agent': {
          const result = chats.setAgentState(message.chatId, message.state, message.context, participant, message.activity);
          if (!result.ok) return fail(conn, result.code, result.message);
          chatChanged(result.value);
          break;
        }
        case 'chat.worktree': {
          const result = chats.setWorktree(message.chatId, message.worktree, participant);
          if (!result.ok) return fail(conn, result.code, result.message);
          chatChanged(result.value);
          // An agent acting for a person (an undo) records it as theirs.
          const actor = message.noteBy && participant.kind === 'agent' ? { name: message.noteBy } : participant;
          if (message.note) record(actor, message.note, result.value.taskId);
          break;
        }
        case 'usage.record': {
          // Only a chat's own agent reports what it used; drafts (commit messages) count as the agent's own.
          const profileId = participant.agent?.profileId;
          const chat =
            chats.getChat(message.usage.chatId) ??
            (profileId && message.usage.chatId === commitDraftUsageId(profileId) ? { agentId: profileId, taskId: message.usage.taskId ?? null } : null);
          if (!chat) break;
          if (profileId !== chat.agentId) return fail(conn, 'not_allowed', 'Only the chat’s agent reports its usage');
          const key = usageKey(message.usage);
          const row: UsageRow = addUsage(usage.get(key), message.usage, chat, Date.now(), prices);
          usage.set(key, row);
          void persist('usage', storage.saveUsage(row));
          broadcast({ type: 'usage.changed', row });
          break;
        }
        case 'prices.update': {
          if (participant.kind !== 'human') return fail(conn, 'not_allowed', 'Only people change prices');
          prices = message.prices;
          void persist('prices', storage.savePrices(prices));
          broadcast({ type: 'prices.changed', prices });
          record(participant, 'changed the model prices');
          break;
        }
        case 'chat.stop': {
          if (!chats.getChat(message.chatId)) return fail(conn, 'not_found', 'That chat no longer exists');
          broadcast({ type: 'chat.stopped', chatId: message.chatId, by: participant.name });
          break;
        }
        case 'chat.undo': {
          const chat = chats.getChat(message.chatId);
          const running = !!chat && joined().some((p) => p.agent?.profileId === chat.agentId);
          const result = await chats.checkUndo(message.chatId, message.messageId, participant, running);
          if (!result.ok) return fail(conn, result.code, result.message);
          broadcast({ type: 'chat.undo', chatId: message.chatId, messageId: message.messageId, mode: message.mode, by: participant.name });
          break;
        }
      }
    };

    // Handle one message at a time per connection, since joining waits on storage.
    let queue = Promise.resolve();
    socket.on('message', (data, isBinary) => {
      queue = queue
        .then(() => handle(data, isBinary))
        .catch((err: unknown) => log(`failed to handle a message: ${String(err)}`));
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      connections.delete(conn);
      const participant = conn.participant;
      if (participant && !joined().some((p) => p.id === participant.id)) {
        workspaces.delete(participant.id);
        const left = chats.agentLeft(participant);
        for (const chat of left.chats) chatChanged(chat);
        for (const m of left.messages) {
          void persist('chat message', storage.saveChatMessage(m));
          broadcast({ type: 'chat.message', message: m });
        }
        broadcast({ type: 'participant.left', participantId: participant.id });
        if (!conn.removed) record(participant, 'left the session');
        log(`${participant.name} left`);
      }
    });
  });

  /** Why a hello with a valid secret is still turned away, or null to let it in. */
  const admit = (
    known: Identity | null,
    hello: { kind: Participant['kind']; agent?: { startedBy: string; startedById?: string } },
    retired: { retiredAt: number } | undefined,
  ): { code: ErrorCode; message: string; closeCode: number } | null => {
    // An earlier code only lets back in people who had joined before it was replaced.
    if (retired && !(known && known.kind === 'human' && hello.kind === 'human' && !hello.agent && known.createdAt <= retired.retiredAt)) {
      return { code: 'bad_secret', message: 'This invite code was replaced by a new one. Ask the host for the new code.', closeCode: CloseCode.badSecret };
    }
    const removal = known && access.removed.find((r) => r.id === known.id);
    if (removal) {
      // A code made after the removal is the host inviting them back.
      if (retired || access.issuedAt <= removal.at) {
        return { code: 'removed', message: 'The host removed you from this session. Ask them for a new invite code to come back.', closeCode: CloseCode.removed };
      }
      access = { ...access, removed: access.removed.filter((r) => r !== removal) };
      void persist('session access', storage.saveAccess(access));
    }
    const starter = hello.agent?.startedById && access.removed.find((r) => r.id === hello.agent!.startedById);
    if (starter) {
      return { code: 'removed', message: `${starter.name} was removed from this session, so agents started on their PC cannot join.`, closeCode: CloseCode.removed };
    }
    return null;
  };

  const newSecret = async (by: string | null) => {
    const now = Date.now();
    const next = generateSecret();
    const nextAccess: SessionAccess = {
      ...access,
      issuedAt: now,
      retired: [{ secret: sessionSecret, retiredAt: now }, ...access.retired].slice(0, RETIRED_SECRETS),
    };
    await storage.saveSecret(next);
    await storage.saveAccess(nextAccess);
    sessionSecret = next;
    access = nextAccess;
    broadcast({ type: 'session.secret', secret: next });
    record(by ? { name: by } : null, 'made a new invite code; the old one no longer lets anyone new join');
    log('made a new invite code');
    return next;
  };

  const removeParticipant = async (id: string, by: string | null) => {
    const person = joined().find((p) => p.id === id && p.kind === 'human');
    if (!person) return { ok: false as const, message: 'They are not in the session now.' };
    const nextAccess = { ...access, removed: [...access.removed.filter((r) => r.id !== id), { id, name: person.name, at: Date.now() }] };
    await storage.saveAccess(nextAccess);
    access = nextAccess;
    record(by ? { name: by } : null, `removed ${person.name} from the session`);
    // Their agents run on their PC, so they go too.
    const gone = new Set([id]);
    for (const conn of connections) {
      const p = conn.participant;
      if (!p || (p.id !== id && p.agent?.startedById !== id)) continue;
      gone.add(p.id);
      conn.removed = true;
      const why = p.id === id ? 'The host removed you from this session. Ask them for a new invite code to come back.' : `${person.name} was removed from the session, so their agents stopped`;
      fail(conn, 'removed', why, CloseCode.removed);
    }
    const freed = locks.list().filter((lock) => gone.has(lock.holder.id));
    for (const lock of freed) {
      locks.drop(lock.id);
      void persist('lock', storage.deleteLock(lock.id));
      broadcast({ type: 'lock.removed', lockId: lock.id });
    }
    if (freed.length > 0) {
      const what = freed.length === 1 ? `lock on ${freed[0]!.path} was` : `${freed.length} locks were`;
      record(null, `${person.name}'s ${what} freed because they were removed from the session`);
    }
    log(`${person.name} was removed`);
    return { ok: true as const, name: person.name };
  };

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const conn of connections) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      // Answering pings is the heartbeat for everything this participant holds.
      if (conn.participant) for (const lock of locks.refresh(conn.participant.id, now)) lockChanged(lock);
      conn.alive = false;
      conn.socket.ping();
    }
    for (const lock of locks.sweep(lockStaleMs, now)) {
      lockChanged(lock);
      record(null, `${lock.holder.name}'s lock on ${lock.path} was abandoned`, lock.taskId);
    }
  }, heartbeatMs);

  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(options.port ?? 7420, options.host ?? '0.0.0.0', () => {
        http.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    // A busy port: leave nothing running, so the caller can try another.
    clearInterval(heartbeat);
    wss.close();
    throw error;
  }
  const port = (http.address() as AddressInfo).port;
  github.start();
  const scheme = options.tls ? 'wss' : 'ws';

  return {
    port,
    get secret() {
      return sessionSecret;
    },
    session: currentSession,
    localUrl: `${scheme}://127.0.0.1:${port}${SOCKET_PATH}`,
    participants: joined,
    github: () => github.getStatus(),
    setGitHubToken: (token) => github.setToken(token),
    newSecret,
    removeParticipant,
    async close() {
      clearInterval(heartbeat);
      github.stop();
      for (const conn of connections) conn.socket.close(CloseCode.serverShutdown, 'Server shutting down');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await docs.flush();
      await storage.close();
    },
  };
}

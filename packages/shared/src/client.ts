import type {
  Activity,
  AgentProfile,
  ChatAgentState,
  ChatContext,
  DuplicateCheck,
  ChatInfo,
  ChatMessage,
  ChatWorktree,
  Criterion,
  CriterionState,
  Handoff,
  GitHubStatus,
  Lock,
  LockRules,
  Participant,
  ParticipantKind,
  PresenceStatus,
  RepoRef,
  SessionInfo,
  Task,
  TaskStage,
  UndoMode,
  Workspace,
} from './model.js';
import { DEFAULT_LOCK_RULES, EMPTY_GITHUB_STATUS } from './model.js';
import type { BloatReport } from './bloat.js';
import { DEFAULT_PRICES, addUsage, usageKey, type PriceTable, type UsageReport, type UsageRow } from './usage.js';
import { commitDraftUsageId } from './commit-message.js';
import { DOC_IDS, Y, decodeBytes, encodeBytes, isEmptyUpdate, type DocId } from './docs.js';
import { applyMemoryOp, readMemory, type MemoryEntry, type MemoryOp } from './memory.js';
import { DEFAULT_MILESTONES, applyPlanOp, readIssueMarks, readMilestones, readPlanning, type IssueMarks, type Milestone, type PlanItem, type PlanOp } from './planning.js';
import {
  CloseCode,
  PROTOCOL_VERSION,
  parseServerMessage,
  type AgentSaveMessage,
  type ChatPostMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
  type SessionSnapshot,
} from './protocol.js';

// Connects one participant to a session server and keeps a live copy of the
// session state. Runs anywhere a standard WebSocket exists: the Electron main
// process, a browser, Node 22+, or an agent runner.

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface SessionState {
  status: ConnectionStatus;
  url: string | null;
  you: Participant | null;
  session: SessionInfo | null;
  participants: Participant[];
  tasks: Task[];
  locks: Lock[];
  lockRules: LockRules;
  /** Most recent activity, oldest first. */
  activity: Activity[];
  github: GitHubStatus;
  /** Local checkouts by participant id, as each one's app reports them. */
  workspaces: Record<string, Workspace>;
  agents: AgentProfile[];
  chats: ChatInfo[];
  /** Messages of the chats this client opened (or saw messages in), oldest first. */
  messages: Record<string, ChatMessage[]>;
  /** The planning space: features, ideas and notes. */
  planning: PlanItem[];
  /** The roadmap's milestones, in order. */
  milestones: Milestone[];
  /** What people noted about GitHub issues: links, triage, keep open. By issue number. */
  issueMarks: Record<number, IssueMarks>;
  /** Project memory: decisions, conventions, known issues and plans. */
  memory: MemoryEntry[];
  /** The last bloat check anyone ran. */
  bloat: BloatReport | null;
  /** What agents used, per chat, day and model. */
  usage: UsageRow[];
  /** Model prices the session estimates cost with. */
  prices: PriceTable;
  /** Task changes made while offline, waiting to be sent. */
  pending: number;
  error: { code: ErrorCode | 'connection_lost'; message: string } | null;
}

export interface JoinOptions {
  url: string;
  secret: string;
  name: string;
  kind?: ParticipantKind;
  /** For an agent runner: the agent profile it runs and who started it. */
  agent?: { profileId: string; startedBy: string; startedById?: string };
  /** Secret kept on this machine; see HelloMessage.identity. Use newIdentity() to make one. */
  identity: string;
}

/** A fresh identity secret for a person or agent that has none yet. */
export function newIdentity(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SessionClientOptions {
  /** Defaults to the global WebSocket. */
  createSocket?: (url: string) => WebSocket;
  /** Reconnect delays in ms; the last one repeats. */
  backoff?: number[];
  /** How long to wait for a connection to open before trying again. Default 8 s. */
  connectTimeoutMs?: number;
}

type Listener = (state: SessionState) => void;
type MessageListener = (message: ServerMessage) => void;

const INITIAL_STATE: SessionState = {
  status: 'idle',
  url: null,
  you: null,
  session: null,
  participants: [],
  tasks: [],
  locks: [],
  lockRules: DEFAULT_LOCK_RULES,
  activity: [],
  github: EMPTY_GITHUB_STATUS,
  workspaces: {},
  agents: [],
  chats: [],
  messages: {},
  planning: [],
  milestones: DEFAULT_MILESTONES,
  issueMarks: {},
  memory: [],
  bloat: null,
  usage: [],
  prices: DEFAULT_PRICES,
  pending: 0,
  error: null,
};

/** What came of a change to a GitHub issue. */
export type IssueResult = { ok: true; number: number; url: string } | { ok: false; error: string };

/** How long to wait for GitHub through the server before giving up. */
const ISSUE_TIMEOUT_MS = 45_000;

/** How many messages the client keeps per chat. */
export const CHAT_MESSAGE_LIMIT = 500;

type TaskMessage = SessionSnapshot['queue'][number];

/** How many activity entries the client keeps. */
export const ACTIVITY_LIMIT = 100;

export interface TaskChanges {
  title?: string;
  stage?: TaskStage;
  ownerId?: string | null;
  scope?: string[];
  readFirst?: string[];
  branch?: string | null;
  /** Acceptance criteria as written; a criterion keeps its result while its id stays. */
  criteria?: { id: string; text: string }[];
  /** Dollars the task's agents may spend, or null for no limit. */
  budget?: number | null;
}

/** Marks document changes that came from the server, so they are not sent back. */
const REMOTE = Symbol('remote');

// Closing with these codes means retrying will not help.
const FATAL_CLOSE_CODES = new Set<number>([
  CloseCode.badSecret,
  CloseCode.protocolMismatch,
  CloseCode.replaced,
  CloseCode.agentRunning,
  CloseCode.removed,
]);

export class SessionClient {
  private state: SessionState = INITIAL_STATE;
  private readonly listeners = new Set<Listener>();
  private readonly messageListeners = new Set<MessageListener>();
  private socket: WebSocket | null = null;
  private join: JoinOptions | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly createSocket: (url: string) => WebSocket;
  private readonly backoff: number[];
  private readonly connectTimeoutMs: number;
  /** Offline task changes, in the order they were made. */
  private queue: TaskMessage[] = [];
  /** Our own workspace, sent again after every reconnect. */
  private workspace: Workspace | null = null;
  /** The shared documents, edited locally and merged with the server's copy. */
  private docs = {} as Record<DocId, Y.Doc>;
  /** Documents the server has sent its state for since this connection opened; live edits go out only for these. */
  private readonly synced = new Set<DocId>();
  /** GitHub issue requests waiting for the server's answer, by request id. */
  private readonly issueRequests = new Map<string, (result: IssueResult) => void>();

  constructor(options: SessionClientOptions = {}) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.backoff = options.backoff ?? [500, 1000, 2000, 4000, 8000];
    this.connectTimeoutMs = options.connectTimeoutMs ?? 8000;
  }

  getState(): SessionState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every message from the server, after the state has been updated with it. */
  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  /**
   * Joins a session. With a snapshot from an earlier run, the board shows
   * right away (even if the server is unreachable) and changes made offline
   * are sent once the server answers.
   */
  connect(options: JoinOptions, snapshot?: SessionSnapshot): void {
    this.disconnect();
    this.join = options;
    this.attempt = 0;
    this.queue = snapshot ? [...snapshot.queue] : [];
    this.resetDocs(snapshot?.docs);
    this.setState({
      ...INITIAL_STATE,
      ...(snapshot && {
        session: snapshot.session,
        tasks: snapshot.tasks,
        locks: snapshot.locks,
        lockRules: snapshot.lockRules,
        activity: snapshot.activity,
        github: snapshot.github,
        agents: snapshot.agents,
        chats: snapshot.chats,
        bloat: snapshot.bloat,
        usage: snapshot.usage,
        prices: snapshot.prices ?? DEFAULT_PRICES,
      }),
      planning: readPlanning(this.docs.planning),
      milestones: readMilestones(this.docs.planning),
      issueMarks: readIssueMarks(this.docs.planning),
      memory: readMemory(this.docs.memory),
      pending: this.queue.length,
      status: 'connecting',
      url: options.url,
    });
    this.open();
  }

  /** What to save so the next connect can start from here; null before the first join. */
  getSnapshot(): SessionSnapshot | null {
    const { session, tasks, locks, lockRules, activity, github, agents, chats, bloat, usage, prices } = this.state;
    if (!session) return null;
    const docs = Object.fromEntries(DOC_IDS.map((id) => [id, encodeBytes(Y.encodeStateAsUpdate(this.docs[id]))]));
    return { session, tasks, locks, lockRules, activity, github, agents, chats, bloat, usage, prices, docs, queue: [...this.queue] };
  }

  /** Task changes are allowed while connected, and offline once we know the session. */
  canEditTasks(): boolean {
    return this.state.status === 'connected' || (this.join !== null && this.state.session !== null);
  }

  disconnect(): void {
    this.join = null;
    this.workspace = null;
    this.clearRetry();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'leaving');
    this.failIssueRequests();
    if (this.state.status !== 'idle') this.setState({ ...this.state, status: 'closed' });
  }

  setPresence(status: PresenceStatus, focus: string | null = null): void {
    this.send({ type: 'presence.update', status, focus });
  }

  /** Returns the new task's id. */
  createTask(
    title: string,
    options: { stage?: TaskStage; scope?: string[]; readFirst?: string[]; featureId?: string | null; criteria?: { id: string; text: string }[] } = {},
  ): string {
    const id = crypto.randomUUID();
    this.sendTask({ type: 'task.create', id, title, ...options });
    return id;
  }

  updateTask(taskId: string, changes: TaskChanges): void {
    const task = this.state.tasks.find((t) => t.id === taskId);
    const expected: TaskChanges = {};
    if (task) {
      if (changes.title !== undefined) expected.title = task.title;
      if (changes.stage !== undefined) expected.stage = task.stage;
      if (changes.ownerId !== undefined) expected.ownerId = task.owner?.id ?? null;
      if (changes.scope !== undefined) expected.scope = task.scope;
      if (changes.readFirst !== undefined) expected.readFirst = task.readFirst;
      if (changes.branch !== undefined) expected.branch = task.branch;
      if (changes.criteria !== undefined) expected.criteria = task.criteria.map(({ id, text }) => ({ id, text }));
      if (changes.budget !== undefined) expected.budget = task.budget;
    }
    this.sendTask({ type: 'task.update', taskId, changes, expected });
  }

  deleteTask(taskId: string): void {
    this.sendTask({ type: 'task.delete', taskId });
  }

  /** Records a test result for an acceptance criterion. */
  verifyCriterion(taskId: string, criterionId: string, state: CriterionState, evidence: string): void {
    this.sendTask({ type: 'task.verify', taskId, criterionId, state, evidence });
  }

  /** Records what an agent answered to the review-time duplicate question; needs the server. */
  recordDuplicateCheck(taskId: string, check: Omit<DuplicateCheck, 'at'>): void {
    this.send({ type: 'task.duplicates', taskId, check });
  }

  /**
   * Changes the planning space. Works offline too: the change is kept in the
   * local copy and merged when the server is back. Returns false when the
   * item is gone or the session is not known yet.
   */
  editPlanning(op: PlanOp): boolean {
    if (!this.canEditTasks()) return false;
    return applyPlanOp(this.docs.planning, op, this.authorName());
  }

  /** Changes project memory; offline like the planning space. */
  editMemory(op: MemoryOp): boolean {
    if (!this.canEditTasks()) return false;
    return applyMemoryOp(this.docs.memory, op, this.authorName());
  }

  /** Whether a shared document has been merged with the server's copy since connecting. */
  hasSynced(docId: DocId): boolean {
    return this.synced.has(docId);
  }

  /** Shares the result of a bloat check with the session. */
  shareBloat(report: BloatReport): void {
    this.send({ type: 'bloat.report', report });
  }

  private authorName(): string {
    return this.state.you?.name ?? this.join?.name ?? 'Someone';
  }

  /** Starts over with fresh documents, or the ones saved in a snapshot. */
  private resetDocs(saved: Partial<Record<DocId, string>> = {}): void {
    for (const doc of Object.values(this.docs)) doc.destroy();
    this.synced.clear();
    this.docs = {} as Record<DocId, Y.Doc>;
    for (const id of DOC_IDS) {
      const doc = new Y.Doc();
      const state = saved[id];
      if (state) {
        try {
          Y.applyUpdate(doc, decodeBytes(state), REMOTE);
        } catch {
          // A damaged cache only loses the offline copy; the server has the rest.
        }
      }
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin !== REMOTE && this.synced.has(id)) this.send({ type: 'doc.update', docId: id, update: encodeBytes(update) });
        this.refreshDoc(id);
      });
      this.docs[id] = doc;
    }
  }

  private refreshDoc(id: DocId): void {
    if (id === 'planning') {
      const doc = this.docs.planning;
      this.setState({ ...this.state, planning: readPlanning(doc), milestones: readMilestones(doc), issueMarks: readIssueMarks(doc) });
    } else this.setState({ ...this.state, memory: readMemory(this.docs.memory) });
  }

  /** Sends now when connected; otherwise applies the change locally and queues it. */
  private sendTask(message: TaskMessage): void {
    if (this.state.status === 'connected') {
      this.send(message);
      return;
    }
    if (!this.canEditTasks()) return;
    // Owners need the server to check who is connected, so they wait for it.
    if (message.type === 'task.update' && message.changes.ownerId !== undefined) return;
    this.queue.push(message);
    this.setState({ ...this.state, tasks: applyLocally(this.state.tasks, message), pending: this.queue.length });
  }

  acquireLock(
    path: string,
    options: { taskId?: string | null; exclusive?: boolean; chatId?: string | null; reason?: string | null } = {},
  ): void {
    this.send({ type: 'lock.acquire', path, ...options });
  }

  releaseLock(lockId: string): void {
    this.send({ type: 'lock.release', lockId });
  }

  recoverLock(lockId: string): void {
    this.send({ type: 'lock.recover', lockId });
  }

  setLockRules(rules: LockRules): void {
    this.send({ type: 'lock.rules.update', rules });
  }

  setPrices(prices: PriceTable): void {
    this.send({ type: 'prices.update', prices });
  }

  /**
   * Reports what one model call used (agents only). Counted here at once, so
   * a budget check right after sees it before the server answers.
   */
  recordUsage(usage: UsageReport): void {
    if (this.state.status !== 'connected') return;
    const profileId = this.state.you?.agent?.profileId;
    const chat =
      this.state.chats.find((c) => c.id === usage.chatId) ??
      (profileId && usage.chatId === commitDraftUsageId(profileId) ? { agentId: profileId, taskId: usage.taskId ?? null } : undefined);
    if (chat) {
      const key = usageKey(usage);
      const row = addUsage(this.state.usage.find((r) => usageKey(r) === key), usage, chat, Date.now(), this.state.prices);
      this.setState({ ...this.state, usage: upsertUsage(this.state.usage, row) });
    }
    this.send({ type: 'usage.record', usage });
  }

  linkRepo(repo: RepoRef | null): void {
    this.send({ type: 'github.link', repo });
  }

  /** Opens an issue on GitHub; the host's server does it with its token. */
  createIssue(title: string, body: string): Promise<IssueResult> {
    return this.issueRequest({ type: 'github.issue.create', requestId: crypto.randomUUID(), title, body });
  }

  /** Comments on an issue and closes it as completed. */
  closeIssue(number: number, comment: string): Promise<IssueResult> {
    return this.issueRequest({ type: 'github.issue.close', requestId: crypto.randomUUID(), number, comment });
  }

  private issueRequest(message: Extract<ClientMessage, { type: 'github.issue.create' | 'github.issue.close' }>): Promise<IssueResult> {
    if (this.state.status !== 'connected') return Promise.resolve({ ok: false, error: 'GitHub can be changed only while connected to the session.' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({ ok: false, error: 'GitHub did not answer in time. Check on GitHub whether it worked.' }), ISSUE_TIMEOUT_MS);
      const finish = (result: IssueResult) => {
        clearTimeout(timer);
        this.issueRequests.delete(message.requestId);
        resolve(result);
      };
      this.issueRequests.set(message.requestId, finish);
      this.send(message);
    });
  }

  private failIssueRequests(): void {
    for (const finish of [...this.issueRequests.values()]) {
      finish({ ok: false, error: 'The connection dropped before GitHub answered. Check on GitHub whether it worked.' });
    }
  }

  /** Shares your local checkout with the session; null stops sharing it. */
  setWorkspace(workspace: Workspace | null): void {
    this.workspace = workspace;
    this.send({ type: 'workspace.update', workspace });
  }

  saveAgent(agent: AgentSaveMessage['agent']): void {
    this.send({ type: 'agent.save', agent });
  }

  deleteAgent(agentId: string): void {
    this.send({ type: 'agent.delete', agentId });
  }

  /** Starts a chat with an agent; returns the chat's id. */
  createChat(options: { agentId: string; title: string; taskId?: string | null; handoff?: Handoff | null }): string {
    const id = crypto.randomUUID();
    this.send({ type: 'chat.create', id, ...options });
    return id;
  }

  /**
   * Starts a new chat with the messages of another chat up to and including one
   * of them; with a handoff, it starts from the handoff and the files instead.
   */
  branchChat(options: { fromChatId: string; fromMessageId: string; title: string; agentId?: string; handoff?: Handoff }): string {
    const id = crypto.randomUUID();
    this.send({ type: 'chat.branch', id, ...options });
    return id;
  }

  updateChat(chatId: string, changes: { title?: string; taskId?: string | null; budget?: number | null }): void {
    this.send({ type: 'chat.update', chatId, ...changes });
  }

  deleteChat(chatId: string): void {
    this.send({ type: 'chat.delete', chatId });
  }

  /** Loads a chat's messages into state.messages. */
  openChat(chatId: string): void {
    this.send({ type: 'chat.open', chatId });
  }

  /** Posts a message, or updates one you posted earlier with the same id. Returns the id. */
  postChat(
    chatId: string,
    message: Omit<ChatPostMessage['message'], 'id'> & { id?: string },
  ): string {
    const id = message.id ?? crypto.randomUUID();
    this.send({ type: 'chat.post', chatId, message: { ...message, id } });
    return id;
  }

  decideApproval(chatId: string, messageId: string, approve: boolean): void {
    this.send({ type: 'chat.decide', chatId, messageId, approve });
  }

  /** For the chat's agent: whether it is working, and what it has in context. */
  setChatAgentState(chatId: string, state: ChatAgentState, context?: ChatContext | null, activity?: string | null): void {
    this.send({
      type: 'chat.agent',
      chatId,
      state,
      ...(context !== undefined && { context }),
      ...(activity !== undefined && { activity }),
    });
  }

  /** Reports the agent's own copy of the project for a chat; null once it is gone. */
  setChatWorktree(chatId: string, worktree: ChatWorktree | null, note?: string, noteBy?: string): void {
    this.send({ type: 'chat.worktree', chatId, worktree, ...(note && { note: note.slice(0, 300) }), ...(note && noteBy && { noteBy: noteBy.slice(0, 64) }) });
  }

  stopChat(chatId: string): void {
    this.send({ type: 'chat.stop', chatId });
  }

  /** Asks the chat's agent to undo the turn of a checkpoint message, or take its copy back to it. */
  undoTurn(chatId: string, messageId: string, mode: UndoMode): void {
    this.send({ type: 'chat.undo', chatId, messageId, mode });
  }

  private open(): void {
    const join = this.join;
    if (!join) return;
    const socket = this.createSocket(join.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.send({
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        secret: join.secret,
        name: join.name,
        kind: join.kind ?? 'human',
        identity: join.identity,
        ...(join.agent && { agent: join.agent }),
      });
    });

    socket.addEventListener('message', (event) => {
      if (socket !== this.socket || typeof event.data !== 'string') return;
      const message = parseServerMessage(event.data);
      if (!message) return;
      this.handle(message);
      for (const listener of this.messageListeners) listener(message);
    });

    // Called once per socket however it goes down: a close, an error (Node's
    // WebSocket reports a refused connection only as an error), or a timeout.
    const down = (code: number, reason: string) => {
      clearTimeout(connectTimer);
      if (socket !== this.socket) return;
      this.socket = null;
      if (!this.join) return;
      if (FATAL_CLOSE_CODES.has(code)) {
        this.join = null;
        this.setState({
          ...this.state,
          status: 'closed',
          error: this.state.error ?? { code: 'connection_lost', message: reason || 'Connection refused' },
        });
        return;
      }
      this.scheduleReconnect();
    };

    // An unreachable host (say, the host PC is off) can leave a connect attempt hanging.
    const connectTimer = setTimeout(() => {
      if (socket.readyState !== 0) return;
      down(1006, 'Timed out');
      socket.close();
    }, this.connectTimeoutMs);

    socket.addEventListener('open', () => clearTimeout(connectTimer));
    socket.addEventListener('error', () => {
      if (socket.readyState !== 1) down(1006, '');
    });
    socket.addEventListener('close', (event) => down(event.code, event.reason));
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome': {
        this.attempt = 0;
        // Changes queued for a different session (the invite now points
        // somewhere else) must not be sent here.
        if (this.state.session && this.state.session.id !== message.session.id) {
          this.queue = [];
          this.resetDocs();
        }
        this.synced.clear();
        const queue = this.queue;
        this.queue = [];
        this.setState({
          ...this.state,
          status: 'connected',
          you: message.you,
          session: message.session,
          participants: message.participants,
          tasks: message.tasks,
          locks: message.locks,
          lockRules: message.lockRules,
          activity: message.activity.slice(-ACTIVITY_LIMIT),
          github: message.github,
          workspaces: Object.fromEntries(message.workspaces.map((w) => [w.participantId, w.workspace])),
          agents: message.agents,
          chats: message.chats,
          bloat: message.bloat,
          usage: message.usage,
          prices: message.prices,
          planning: readPlanning(this.docs.planning),
          milestones: readMilestones(this.docs.planning),
          issueMarks: readIssueMarks(this.docs.planning),
          memory: readMemory(this.docs.memory),
          // Keep loaded messages of chats that still exist; chat.open fetches what was missed.
          messages: Object.fromEntries(
            Object.entries(this.state.messages).filter(([chatId]) => message.chats.some((c) => c.id === chatId)),
          ),
          pending: 0,
          error: null,
        });
        if (this.workspace) this.send({ type: 'workspace.update', workspace: this.workspace });
        // Replay offline changes in order; the server checks each for conflicts.
        for (const queued of queue) this.send(queued);
        // Offline document edits go out once the server says what it has (doc.state).
        for (const id of DOC_IDS) {
          this.send({ type: 'doc.sync', docId: id, stateVector: encodeBytes(Y.encodeStateVector(this.docs[id])) });
        }
        break;
      }
      case 'participant.joined':
        this.setState({
          ...this.state,
          participants: [
            ...this.state.participants.filter((p) => p.id !== message.participant.id),
            message.participant,
          ],
        });
        break;
      case 'participant.left': {
        const { [message.participantId]: _gone, ...workspaces } = this.state.workspaces;
        this.setState({
          ...this.state,
          participants: this.state.participants.filter((p) => p.id !== message.participantId),
          workspaces,
        });
        break;
      }
      case 'presence':
        this.setState({
          ...this.state,
          participants: this.state.participants.map((p) =>
            p.id === message.participantId ? { ...p, status: message.status, focus: message.focus } : p,
          ),
        });
        break;
      case 'task.changed': {
        const exists = this.state.tasks.some((t) => t.id === message.task.id);
        this.setState({
          ...this.state,
          tasks: exists
            ? this.state.tasks.map((t) => (t.id === message.task.id ? message.task : t))
            : [...this.state.tasks, message.task],
        });
        break;
      }
      case 'task.removed':
        this.setState({ ...this.state, tasks: this.state.tasks.filter((t) => t.id !== message.taskId) });
        break;
      case 'lock.changed': {
        const exists = this.state.locks.some((l) => l.id === message.lock.id);
        this.setState({
          ...this.state,
          locks: exists
            ? this.state.locks.map((l) => (l.id === message.lock.id ? message.lock : l))
            : [...this.state.locks, message.lock],
        });
        break;
      }
      case 'lock.removed':
        this.setState({ ...this.state, locks: this.state.locks.filter((l) => l.id !== message.lockId) });
        break;
      case 'lock.rules.changed':
        this.setState({ ...this.state, lockRules: message.rules });
        break;
      case 'usage.changed':
        this.setState({ ...this.state, usage: upsertUsage(this.state.usage, message.row) });
        break;
      case 'prices.changed':
        this.setState({ ...this.state, prices: message.prices });
        break;
      case 'activity':
        this.setState({ ...this.state, activity: [...this.state.activity, message.entry].slice(-ACTIVITY_LIMIT) });
        break;
      case 'github.status':
        this.setState({ ...this.state, github: message.status });
        break;
      case 'github.issue.result':
        this.issueRequests.get(message.requestId)?.(
          message.issue ? { ok: true, ...message.issue } : { ok: false, error: message.error ?? 'GitHub refused the change.' },
        );
        break;
      case 'workspace.changed': {
        const { [message.participantId]: _old, ...rest } = this.state.workspaces;
        this.setState({
          ...this.state,
          workspaces: message.workspace ? { ...rest, [message.participantId]: message.workspace } : rest,
        });
        break;
      }
      case 'agent.changed':
        this.setState({ ...this.state, agents: upsert(this.state.agents, message.agent) });
        break;
      case 'agent.removed':
        this.setState({ ...this.state, agents: this.state.agents.filter((a) => a.id !== message.agentId) });
        break;
      case 'chat.changed':
        this.setState({ ...this.state, chats: upsert(this.state.chats, message.chat) });
        break;
      case 'chat.removed': {
        const { [message.chatId]: _gone, ...messages } = this.state.messages;
        this.setState({ ...this.state, chats: this.state.chats.filter((c) => c.id !== message.chatId), messages });
        break;
      }
      case 'chat.message': {
        const list = this.state.messages[message.message.chatId] ?? [];
        this.setState({
          ...this.state,
          messages: {
            ...this.state.messages,
            [message.message.chatId]: upsert(list, message.message).slice(-CHAT_MESSAGE_LIMIT),
          },
        });
        break;
      }
      case 'chat.history':
        this.setState({
          ...this.state,
          messages: { ...this.state.messages, [message.chatId]: message.messages.slice(-CHAT_MESSAGE_LIMIT) },
        });
        break;
      case 'chat.stopped':
      case 'chat.undo':
        break;
      case 'doc.state': {
        const doc = this.docs[message.docId];
        try {
          Y.applyUpdate(doc, decodeBytes(message.update), REMOTE);
          const missing = Y.encodeStateAsUpdate(doc, decodeBytes(message.stateVector));
          if (!isEmptyUpdate(missing)) this.send({ type: 'doc.update', docId: message.docId, update: encodeBytes(missing) });
          this.synced.add(message.docId);
        } catch {
          this.setState({ ...this.state, error: { code: 'bad_message', message: 'Could not read a shared document from the server' } });
        }
        break;
      }
      case 'doc.changed':
        try {
          Y.applyUpdate(this.docs[message.docId], decodeBytes(message.update), REMOTE);
        } catch {
          // A broken update is skipped; the next sync fills the gap.
        }
        break;
      case 'bloat.changed':
        this.setState({ ...this.state, bloat: message.report });
        break;
      case 'session.secret':
        // Reconnects use the new invite code; the app saves it for Rejoin (see onMessage).
        if (this.join) this.join = { ...this.join, secret: message.secret };
        break;
      case 'error':
        this.setState({ ...this.state, error: { code: message.code, message: message.message } });
        break;
      case 'pong':
        break;
    }
  }

  private scheduleReconnect(): void {
    this.failIssueRequests();
    const delay = this.backoff[Math.min(this.attempt, this.backoff.length - 1)] ?? 1000;
    this.attempt += 1;
    this.synced.clear();
    this.setState({
      ...this.state,
      status: 'reconnecting',
      participants: [],
      workspaces: {},
      error: { code: 'connection_lost', message: 'Lost connection to the session server' },
    });
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
  }

  private setState(next: SessionState): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}

/** Replaces the item with the same id, or adds it at the end. */
function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  return items.some((i) => i.id === item.id) ? items.map((i) => (i.id === item.id ? item : i)) : [...items, item];
}

/** The local effect of a task change, shown until the server confirms it. */
function upsertUsage(rows: UsageRow[], row: UsageRow): UsageRow[] {
  const key = usageKey(row);
  const index = rows.findIndex((r) => usageKey(r) === key);
  if (index < 0) return [...rows, row];
  const next = [...rows];
  next[index] = row;
  return next;
}

function applyLocally(tasks: Task[], message: TaskMessage): Task[] {
  switch (message.type) {
    case 'task.create': {
      const now = Date.now();
      return [
        ...tasks,
        {
          id: message.id ?? crypto.randomUUID(),
          title: message.title,
          stage: message.stage ?? 'planning',
          owner: null,
          scope: message.scope ?? [],
          readFirst: message.readFirst ?? [],
          branch: null,
          featureId: message.featureId ?? null,
          criteria: (message.criteria ?? []).map(({ id, text }) => newCriterion(id, text)),
          budget: null,
          duplicateCheck: null,
          createdAt: now,
          updatedAt: now,
          version: 0,
        },
      ];
    }
    case 'task.update':
      return tasks.map((t) =>
        t.id === message.taskId
          ? {
              ...t,
              title: message.changes.title ?? t.title,
              stage: message.changes.stage ?? t.stage,
              scope: message.changes.scope ?? t.scope,
              readFirst: message.changes.readFirst ?? t.readFirst,
              branch: message.changes.branch !== undefined ? message.changes.branch : t.branch,
              criteria: message.changes.criteria ? mergeCriteria(t.criteria, message.changes.criteria) : t.criteria,
              budget: message.changes.budget !== undefined ? message.changes.budget : t.budget,
            }
          : t,
      );
    case 'task.verify':
      return tasks.map((t) =>
        t.id === message.taskId
          ? {
              ...t,
              criteria: t.criteria.map((c) =>
                c.id === message.criterionId ? { ...c, state: message.state, evidence: message.evidence, at: Date.now() } : c,
              ),
            }
          : t,
      );
    case 'task.delete':
      return tasks.filter((t) => t.id !== message.taskId);
  }
}

function newCriterion(id: string, text: string): Criterion {
  return { id, text, state: 'untested', evidence: '', by: null, at: null };
}

/**
 * New acceptance criteria from their texts. A criterion whose id is kept keeps
 * its result, unless its text changed: then it needs testing again.
 */
export function mergeCriteria(current: Criterion[], next: { id: string; text: string }[]): Criterion[] {
  return next.map(({ id, text }) => {
    const existing = current.find((c) => c.id === id);
    if (!existing) return newCriterion(id, text);
    return existing.text === text ? existing : newCriterion(id, text);
  });
}

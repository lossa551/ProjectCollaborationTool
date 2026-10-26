import type {
  Activity,
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
  Workspace,
} from './model.js';
import { DEFAULT_LOCK_RULES, EMPTY_GITHUB_STATUS } from './model.js';
import {
  CloseCode,
  PROTOCOL_VERSION,
  parseServerMessage,
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
  /** Task changes made while offline, waiting to be sent. */
  pending: number;
  error: { code: ErrorCode | 'connection_lost'; message: string } | null;
}

export interface JoinOptions {
  url: string;
  secret: string;
  name: string;
  kind?: ParticipantKind;
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
  pending: 0,
  error: null,
};

type TaskMessage = SessionSnapshot['queue'][number];

/** How many activity entries the client keeps. */
export const ACTIVITY_LIMIT = 100;

export interface TaskChanges {
  title?: string;
  stage?: TaskStage;
  ownerId?: string | null;
  scope?: string[];
  branch?: string | null;
}

// Closing with these codes means retrying will not help.
const FATAL_CLOSE_CODES = new Set<number>([CloseCode.badSecret, CloseCode.protocolMismatch, CloseCode.replaced]);

export class SessionClient {
  private state: SessionState = INITIAL_STATE;
  private readonly listeners = new Set<Listener>();
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
    this.setState({
      ...INITIAL_STATE,
      ...(snapshot && {
        session: snapshot.session,
        tasks: snapshot.tasks,
        locks: snapshot.locks,
        lockRules: snapshot.lockRules,
        activity: snapshot.activity,
        github: snapshot.github,
      }),
      pending: this.queue.length,
      status: 'connecting',
      url: options.url,
    });
    this.open();
  }

  /** What to save so the next connect can start from here; null before the first join. */
  getSnapshot(): SessionSnapshot | null {
    const { session, tasks, locks, lockRules, activity, github } = this.state;
    if (!session) return null;
    return { session, tasks, locks, lockRules, activity, github, queue: [...this.queue] };
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
    if (this.state.status !== 'idle') this.setState({ ...this.state, status: 'closed' });
  }

  setPresence(status: PresenceStatus, focus: string | null = null): void {
    this.send({ type: 'presence.update', status, focus });
  }

  createTask(title: string, options: { stage?: TaskStage; scope?: string[] } = {}): void {
    this.sendTask({ type: 'task.create', id: crypto.randomUUID(), title, ...options });
  }

  updateTask(taskId: string, changes: TaskChanges): void {
    const task = this.state.tasks.find((t) => t.id === taskId);
    const expected: TaskChanges = {};
    if (task) {
      if (changes.title !== undefined) expected.title = task.title;
      if (changes.stage !== undefined) expected.stage = task.stage;
      if (changes.ownerId !== undefined) expected.ownerId = task.owner?.id ?? null;
      if (changes.scope !== undefined) expected.scope = task.scope;
      if (changes.branch !== undefined) expected.branch = task.branch;
    }
    this.sendTask({ type: 'task.update', taskId, changes, expected });
  }

  deleteTask(taskId: string): void {
    this.sendTask({ type: 'task.delete', taskId });
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

  acquireLock(path: string, options: { taskId?: string | null; exclusive?: boolean } = {}): void {
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

  linkRepo(repo: RepoRef | null): void {
    this.send({ type: 'github.link', repo });
  }

  /** Shares your local checkout with the session; null stops sharing it. */
  setWorkspace(workspace: Workspace | null): void {
    this.workspace = workspace;
    this.send({ type: 'workspace.update', workspace });
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
      });
    });

    socket.addEventListener('message', (event) => {
      if (socket !== this.socket || typeof event.data !== 'string') return;
      const message = parseServerMessage(event.data);
      if (message) this.handle(message);
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
        if (this.state.session && this.state.session.id !== message.session.id) this.queue = [];
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
          pending: 0,
          error: null,
        });
        if (this.workspace) this.send({ type: 'workspace.update', workspace: this.workspace });
        // Replay offline changes in order; the server checks each for conflicts.
        for (const queued of queue) this.send(queued);
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
      case 'activity':
        this.setState({ ...this.state, activity: [...this.state.activity, message.entry].slice(-ACTIVITY_LIMIT) });
        break;
      case 'github.status':
        this.setState({ ...this.state, github: message.status });
        break;
      case 'workspace.changed': {
        const { [message.participantId]: _old, ...rest } = this.state.workspaces;
        this.setState({
          ...this.state,
          workspaces: message.workspace ? { ...rest, [message.participantId]: message.workspace } : rest,
        });
        break;
      }
      case 'error':
        this.setState({ ...this.state, error: { code: message.code, message: message.message } });
        break;
      case 'pong':
        break;
    }
  }

  private scheduleReconnect(): void {
    const delay = this.backoff[Math.min(this.attempt, this.backoff.length - 1)] ?? 1000;
    this.attempt += 1;
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

/** The local effect of a task change, shown until the server confirms it. */
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
          branch: null,
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
              branch: message.changes.branch !== undefined ? message.changes.branch : t.branch,
            }
          : t,
      );
    case 'task.delete':
      return tasks.filter((t) => t.id !== message.taskId);
  }
}

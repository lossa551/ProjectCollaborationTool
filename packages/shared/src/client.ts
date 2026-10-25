import type { Participant, ParticipantKind, PresenceStatus, SessionInfo } from './model.js';
import {
  CloseCode,
  PROTOCOL_VERSION,
  parseServerMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
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
  error: { code: ErrorCode | 'connection_lost'; message: string } | null;
}

export interface JoinOptions {
  url: string;
  secret: string;
  name: string;
  kind?: ParticipantKind;
}

export interface SessionClientOptions {
  /** Defaults to the global WebSocket. */
  createSocket?: (url: string) => WebSocket;
  /** Reconnect delays in ms; the last one repeats. */
  backoff?: number[];
}

type Listener = (state: SessionState) => void;

const INITIAL_STATE: SessionState = {
  status: 'idle',
  url: null,
  you: null,
  session: null,
  participants: [],
  error: null,
};

// Closing with these codes means retrying will not help.
const FATAL_CLOSE_CODES = new Set<number>([CloseCode.badSecret, CloseCode.protocolMismatch]);

export class SessionClient {
  private state: SessionState = INITIAL_STATE;
  private readonly listeners = new Set<Listener>();
  private socket: WebSocket | null = null;
  private join: JoinOptions | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly createSocket: (url: string) => WebSocket;
  private readonly backoff: number[];

  constructor(options: SessionClientOptions = {}) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.backoff = options.backoff ?? [500, 1000, 2000, 4000, 8000];
  }

  getState(): SessionState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(options: JoinOptions): void {
    this.disconnect();
    this.join = options;
    this.attempt = 0;
    this.setState({ ...INITIAL_STATE, status: 'connecting', url: options.url });
    this.open();
  }

  disconnect(): void {
    this.join = null;
    this.clearRetry();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'leaving');
    if (this.state.status !== 'idle') this.setState({ ...this.state, status: 'closed' });
  }

  setPresence(status: PresenceStatus, focus: string | null = null): void {
    this.send({ type: 'presence.update', status, focus });
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
      });
    });

    socket.addEventListener('message', (event) => {
      if (socket !== this.socket || typeof event.data !== 'string') return;
      const message = parseServerMessage(event.data);
      if (message) this.handle(message);
    });

    socket.addEventListener('close', (event) => {
      if (socket !== this.socket) return;
      this.socket = null;
      if (!this.join) return;
      if (FATAL_CLOSE_CODES.has(event.code)) {
        this.join = null;
        this.setState({
          ...this.state,
          status: 'closed',
          error: this.state.error ?? { code: 'connection_lost', message: event.reason || 'Connection refused' },
        });
        return;
      }
      this.scheduleReconnect();
    });
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
        this.attempt = 0;
        this.setState({
          ...this.state,
          status: 'connected',
          you: message.you,
          session: message.session,
          participants: message.participants,
          error: null,
        });
        break;
      case 'participant.joined':
        this.setState({
          ...this.state,
          participants: [
            ...this.state.participants.filter((p) => p.id !== message.participant.id),
            message.participant,
          ],
        });
        break;
      case 'participant.left':
        this.setState({
          ...this.state,
          participants: this.state.participants.filter((p) => p.id !== message.participantId),
        });
        break;
      case 'presence':
        this.setState({
          ...this.state,
          participants: this.state.participants.map((p) =>
            p.id === message.participantId ? { ...p, status: message.status, focus: message.focus } : p,
          ),
        });
        break;
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

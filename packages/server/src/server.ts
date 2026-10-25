import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CloseCode,
  PROTOCOL_VERSION,
  SOCKET_PATH,
  parseClientMessage,
  type ErrorCode,
  type Participant,
  type ServerMessage,
  type SessionInfo,
} from '@pct/shared';
import { MemoryStorage, type Storage } from './storage.js';

export interface ServerOptions {
  /** Port to listen on; 0 picks a free one. Default 7420. */
  port?: number;
  /** Interface to bind; default 0.0.0.0 so Tailscale peers can connect. */
  host?: string;
  /** Shared secret every participant must present. Generated when omitted. */
  secret?: string;
  sessionName?: string;
  storage?: Storage;
  /** PEM key and certificate to serve wss:// instead of ws://. */
  tls?: { key: string | Buffer; cert: string | Buffer };
  /** How often to ping clients and drop the ones that stopped answering. */
  heartbeatMs?: number;
  /** How long a new connection may take to send its hello. */
  helloTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface RunningServer {
  port: number;
  secret: string;
  session: SessionInfo;
  /** Local WebSocket URL, for a client on the same machine. */
  localUrl: string;
  participants(): Participant[];
  close(): Promise<void>;
}

interface Connection {
  socket: WebSocket;
  participant: Participant | null;
  alive: boolean;
}

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
  const secret = options.secret ?? generateSecret();
  const log = options.log ?? (() => {});
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const helloTimeoutMs = options.helloTimeoutMs ?? 10_000;

  let session = await storage.loadSession();
  if (!session) {
    session = { id: randomUUID(), name: options.sessionName ?? 'New session', createdAt: Date.now() };
    await storage.saveSession(session);
  }
  const currentSession = session;

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
  const record = (type: string, actorId: string | null, data: Record<string, unknown> = {}) =>
    storage.appendEvent({ at: Date.now(), type, actorId, data }).catch((err: unknown) => {
      log(`failed to record ${type}: ${String(err)}`);
    });

  wss.on('connection', (socket) => {
    const conn: Connection = { socket, participant: null, alive: true };
    connections.add(conn);
    const helloTimer = setTimeout(() => {
      if (!conn.participant) socket.close(CloseCode.helloTimeout, 'No hello received');
    }, helloTimeoutMs);

    socket.on('pong', () => {
      conn.alive = true;
    });

    socket.on('message', (data, isBinary) => {
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
        if (!secretsMatch(message.secret, secret)) {
          return fail(conn, 'bad_secret', 'The invite code is wrong or out of date', CloseCode.badSecret);
        }
        clearTimeout(helloTimer);
        const participant: Participant = {
          id: randomUUID(),
          name: message.name,
          kind: message.kind,
          status: 'active',
          focus: null,
          connectedAt: Date.now(),
        };
        conn.participant = participant;
        send(conn, {
          type: 'welcome',
          protocol: PROTOCOL_VERSION,
          you: participant,
          session: currentSession,
          participants: joined(),
        });
        broadcast({ type: 'participant.joined', participant }, conn);
        void record('participant.joined', participant.id, { name: participant.name, kind: participant.kind });
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
      }
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      connections.delete(conn);
      const participant = conn.participant;
      if (participant) {
        broadcast({ type: 'participant.left', participantId: participant.id });
        void record('participant.left', participant.id);
        log(`${participant.name} left`);
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const conn of connections) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      conn.socket.ping();
    }
  }, heartbeatMs);

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 7420, options.host ?? '0.0.0.0', () => {
      http.off('error', reject);
      resolve();
    });
  });
  const port = (http.address() as AddressInfo).port;
  const scheme = options.tls ? 'wss' : 'ws';

  return {
    port,
    secret,
    session: currentSession,
    localUrl: `${scheme}://127.0.0.1:${port}${SOCKET_PATH}`,
    participants: joined,
    async close() {
      clearInterval(heartbeat);
      for (const conn of connections) conn.socket.close(CloseCode.serverShutdown, 'Server shutting down');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await storage.close();
    },
  };
}

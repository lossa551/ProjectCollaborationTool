import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  CloseCode,
  PROTOCOL_VERSION,
  SOCKET_PATH,
  parseClientMessage,
  type Activity,
  type Lock,
  type ErrorCode,
  type Participant,
  type ServerMessage,
  type SessionInfo,
} from '@pct/shared';
import { TaskBoard } from './board.js';
import { LockTable } from './locks.js';
import { MemoryStorage, type Storage } from './storage.js';

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

const ACTIVITY_ON_JOIN = 100;

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
  const sessionSecret = secret;
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
  const record = (actor: Participant | null, text: string, taskId: string | null = null) => {
    const entry: Activity = { id: randomUUID(), at: Date.now(), actorName: actor?.name ?? null, text, taskId };
    recentActivity.push(entry);
    if (recentActivity.length > ACTIVITY_ON_JOIN) recentActivity.shift();
    void persist('activity', storage.appendActivity(entry));
    broadcast({ type: 'activity', entry });
  };

  const findParticipant = (id: string) => joined().find((p) => p.id === id);

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
        if (!secretsMatch(message.secret, sessionSecret)) {
          return fail(conn, 'bad_secret', 'The invite code is wrong or out of date', CloseCode.badSecret);
        }
        clearTimeout(helloTimer);
        const now = Date.now();
        const tokenHash = createHash('sha256').update(message.identity).digest('hex');
        const known = await storage.findIdentity(tokenHash);
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

        const participant: Participant = {
          id: identity.id,
          name: identity.name,
          kind: identity.kind,
          status: 'active',
          focus: null,
          connectedAt: now,
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
        });
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
              ? locks.release(message.lockId, participant.id)
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
        broadcast({ type: 'participant.left', participantId: participant.id });
        record(participant, 'left the session');
        log(`${participant.name} left`);
      }
    });
  });

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
    secret: sessionSecret,
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

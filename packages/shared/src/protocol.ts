import { z } from 'zod';
import {
  Activity,
  Lock,
  LockRules,
  Participant,
  ParticipantKind,
  PresenceStatus,
  SessionInfo,
  Task,
  TaskScope,
  TaskStage,
  TaskTitle,
} from './model.js';

/** Bumped whenever a message changes in a way older clients cannot read. */
export const PROTOCOL_VERSION = 3;

/** Path of the WebSocket endpoint on the session server. */
export const SOCKET_PATH = '/ws';

// Client to server

export const HelloMessage = z.object({
  type: z.literal('hello'),
  protocol: z.number().int(),
  secret: z.string(),
  name: z.string().trim().min(1).max(64),
  kind: ParticipantKind,
});

export const PresenceUpdateMessage = z.object({
  type: z.literal('presence.update'),
  status: PresenceStatus,
  focus: z.string().max(512).nullable(),
});

export const PingMessage = z.object({
  type: z.literal('ping'),
  t: z.number(),
});

export const TaskCreateMessage = z.object({
  type: z.literal('task.create'),
  title: TaskTitle,
  stage: TaskStage.optional(),
  scope: TaskScope.optional(),
});

export const TaskUpdateMessage = z.object({
  type: z.literal('task.update'),
  taskId: z.string(),
  changes: z.object({
    title: TaskTitle.optional(),
    stage: TaskStage.optional(),
    /** A connected participant's id, or null to unassign. */
    ownerId: z.string().nullable().optional(),
    scope: TaskScope.optional(),
  }),
});

export const TaskDeleteMessage = z.object({
  type: z.literal('task.delete'),
  taskId: z.string(),
});

export const LockAcquireMessage = z.object({
  type: z.literal('lock.acquire'),
  path: z.string().min(1).max(260),
  taskId: z.string().nullable().optional(),
  /** Ask for an exclusive lock even if the rules would give a soft one. */
  exclusive: z.boolean().optional(),
});

export const LockReleaseMessage = z.object({
  type: z.literal('lock.release'),
  lockId: z.string(),
});

/** Frees an abandoned lock held by someone else. */
export const LockRecoverMessage = z.object({
  type: z.literal('lock.recover'),
  lockId: z.string(),
});

export const LockRulesUpdateMessage = z.object({
  type: z.literal('lock.rules.update'),
  rules: LockRules,
});

export const ClientMessage = z.discriminatedUnion('type', [
  HelloMessage,
  PresenceUpdateMessage,
  PingMessage,
  TaskCreateMessage,
  TaskUpdateMessage,
  TaskDeleteMessage,
  LockAcquireMessage,
  LockReleaseMessage,
  LockRecoverMessage,
  LockRulesUpdateMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// Server to client

export const WelcomeMessage = z.object({
  type: z.literal('welcome'),
  protocol: z.number().int(),
  you: Participant,
  session: SessionInfo,
  participants: z.array(Participant),
  tasks: z.array(Task),
  locks: z.array(Lock),
  lockRules: LockRules,
  /** Most recent activity, oldest first. */
  activity: z.array(Activity),
});

export const ParticipantJoinedMessage = z.object({
  type: z.literal('participant.joined'),
  participant: Participant,
});

export const ParticipantLeftMessage = z.object({
  type: z.literal('participant.left'),
  participantId: z.string(),
});

export const PresenceMessage = z.object({
  type: z.literal('presence'),
  participantId: z.string(),
  status: PresenceStatus,
  focus: z.string().nullable(),
});

export const TaskChangedMessage = z.object({
  type: z.literal('task.changed'),
  task: Task,
});

export const TaskRemovedMessage = z.object({
  type: z.literal('task.removed'),
  taskId: z.string(),
});

export const LockChangedMessage = z.object({
  type: z.literal('lock.changed'),
  lock: Lock,
});

export const LockRemovedMessage = z.object({
  type: z.literal('lock.removed'),
  lockId: z.string(),
});

export const LockRulesChangedMessage = z.object({
  type: z.literal('lock.rules.changed'),
  rules: LockRules,
});

export const ActivityMessage = z.object({
  type: z.literal('activity'),
  entry: Activity,
});

export const PongMessage = z.object({
  type: z.literal('pong'),
  t: z.number(),
});

export const ErrorCode = z.enum([
  'bad_message',
  'bad_secret',
  'protocol_mismatch',
  'not_joined',
  'already_joined',
  'not_found',
  'locked',
  'not_allowed',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorMessage = z.object({
  type: z.literal('error'),
  code: ErrorCode,
  message: z.string(),
});

export const ServerMessage = z.discriminatedUnion('type', [
  WelcomeMessage,
  ParticipantJoinedMessage,
  ParticipantLeftMessage,
  PresenceMessage,
  TaskChangedMessage,
  TaskRemovedMessage,
  LockChangedMessage,
  LockRemovedMessage,
  LockRulesChangedMessage,
  ActivityMessage,
  PongMessage,
  ErrorMessage,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** WebSocket close codes the server uses (4000-4999 is the app range). */
export const CloseCode = {
  badSecret: 4001,
  protocolMismatch: 4002,
  helloTimeout: 4003,
  serverShutdown: 4004,
} as const;

function parse<T>(schema: z.ZodType<T>, raw: string): T | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}

export const parseClientMessage = (raw: string) => parse(ClientMessage, raw);
export const parseServerMessage = (raw: string) => parse(ServerMessage, raw);

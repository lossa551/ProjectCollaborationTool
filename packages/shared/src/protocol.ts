import { z } from 'zod';
import { Participant, ParticipantKind, PresenceStatus, SessionInfo } from './model.js';

/** Bumped whenever a message changes in a way older clients cannot read. */
export const PROTOCOL_VERSION = 1;

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

export const ClientMessage = z.discriminatedUnion('type', [
  HelloMessage,
  PresenceUpdateMessage,
  PingMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// Server to client

export const WelcomeMessage = z.object({
  type: z.literal('welcome'),
  protocol: z.number().int(),
  you: Participant,
  session: SessionInfo,
  participants: z.array(Participant),
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

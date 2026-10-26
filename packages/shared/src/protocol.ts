import { z } from 'zod';
import {
  Activity,
  AgentApprovals,
  AgentConnection,
  AgentName,
  AgentProfile,
  ApprovalState,
  BranchName,
  ChatAgentState,
  ChatContext,
  ChatInfo,
  ChatMessage,
  ChatMessageKind,
  ChatTitle,
  ChatTool,
  CHAT_TEXT_LIMIT,
  Handoff,
  EMPTY_GITHUB_STATUS,
  GitHubStatus,
  Lock,
  LockRules,
  Participant,
  ParticipantKind,
  PresenceStatus,
  RepoRef,
  SessionInfo,
  Task,
  TaskScope,
  TaskStage,
  TaskTitle,
  Workspace,
} from './model.js';

/** Bumped whenever a message changes in a way older clients cannot read. */
export const PROTOCOL_VERSION = 7;

/** Path of the WebSocket endpoint on the session server. */
export const SOCKET_PATH = '/ws';

// Client to server

export const HelloMessage = z.object({
  type: z.literal('hello'),
  protocol: z.number().int(),
  secret: z.string(),
  name: z.string().trim().min(1).max(64),
  kind: ParticipantKind,
  /**
   * A random secret this person or agent keeps on their own machine. The same
   * identity means the same participant id across reconnects and restarts,
   * so tasks and locks stay theirs. Never shown to others.
   */
  identity: z.string().min(16).max(128),
  /** Set when an agent runner joins: which agent profile it runs and who started it. */
  agent: z.object({ profileId: z.string(), startedBy: z.string().max(64) }).optional(),
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
  /**
   * Chosen by the client so changes made offline can refer to a task before
   * the server has seen it. Creating an id that already exists does nothing,
   * so replaying a create after a dropped connection is safe.
   */
  id: z.string().min(8).max(64).optional(),
  title: TaskTitle,
  stage: TaskStage.optional(),
  scope: TaskScope.optional(),
});

const TaskFields = z.object({
  title: TaskTitle.optional(),
  stage: TaskStage.optional(),
  /** A connected participant's id, or null to unassign. */
  ownerId: z.string().nullable().optional(),
  scope: TaskScope.optional(),
  /** A branch name, or null to unlink. */
  branch: BranchName.nullable().optional(),
});

export const TaskUpdateMessage = z.object({
  type: z.literal('task.update'),
  taskId: z.string(),
  changes: TaskFields,
  /**
   * What the client saw before its change, per changed field. If someone else
   * changed that field in the meantime (typically while this client was
   * offline), the server keeps their value and reports a conflict.
   */
  expected: TaskFields.optional(),
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

/** Links the session to a GitHub repository, or unlinks it with null. */
export const GitHubLinkMessage = z.object({
  type: z.literal('github.link'),
  repo: RepoRef.nullable(),
});

/** Your local checkout: branch and changed files. Null when you stop sharing it. */
export const WorkspaceUpdateMessage = z.object({
  type: z.literal('workspace.update'),
  workspace: Workspace.nullable(),
});

/** Creates (without an id) or changes an agent profile. */
export const AgentSaveMessage = z.object({
  type: z.literal('agent.save'),
  agent: z.object({
    id: z.string().optional(),
    name: AgentName,
    connection: AgentConnection,
    responsibilities: z.string().max(4000),
    allowedPaths: TaskScope,
    approvals: AgentApprovals,
  }),
});

export const AgentDeleteMessage = z.object({
  type: z.literal('agent.delete'),
  agentId: z.string(),
});

export const ChatCreateMessage = z.object({
  type: z.literal('chat.create'),
  /** Chosen by the client so it can open the chat right away. */
  id: z.string().min(8).max(64),
  agentId: z.string(),
  title: ChatTitle,
  taskId: z.string().nullable().optional(),
  handoff: Handoff.nullable().optional(),
});

export const ChatUpdateMessage = z.object({
  type: z.literal('chat.update'),
  chatId: z.string(),
  title: ChatTitle.optional(),
  taskId: z.string().nullable().optional(),
});

export const ChatDeleteMessage = z.object({
  type: z.literal('chat.delete'),
  chatId: z.string(),
});

/** Asks for a chat's messages; the server answers with chat.history. */
export const ChatOpenMessage = z.object({
  type: z.literal('chat.open'),
  chatId: z.string(),
});

/**
 * Posts a message, or updates one of your own with the same id (agents
 * stream their answers this way). People can only post text and handoffs.
 */
export const ChatPostMessage = z.object({
  type: z.literal('chat.post'),
  chatId: z.string(),
  message: z.object({
    id: z.string().min(8).max(64),
    kind: ChatMessageKind,
    text: z.string().max(CHAT_TEXT_LIMIT),
    streaming: z.boolean().optional(),
    tool: ChatTool.nullable().optional(),
    /** Agents open an approval card with state "pending"; only people decide it. */
    approval: z.object({ action: z.string().max(500), reason: z.string().max(1000), state: ApprovalState }).nullable().optional(),
  }),
});

/** A person approves or denies an agent's pending request. */
export const ChatDecideMessage = z.object({
  type: z.literal('chat.decide'),
  chatId: z.string(),
  messageId: z.string(),
  approve: z.boolean(),
});

/** The chat's agent reports whether it is working and what context it has. */
export const ChatAgentMessage = z.object({
  type: z.literal('chat.agent'),
  chatId: z.string(),
  state: ChatAgentState,
  context: ChatContext.nullable().optional(),
});

/** Asks the chat's agent to stop what it is doing. */
export const ChatStopMessage = z.object({
  type: z.literal('chat.stop'),
  chatId: z.string(),
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
  GitHubLinkMessage,
  WorkspaceUpdateMessage,
  AgentSaveMessage,
  AgentDeleteMessage,
  ChatCreateMessage,
  ChatUpdateMessage,
  ChatDeleteMessage,
  ChatOpenMessage,
  ChatPostMessage,
  ChatDecideMessage,
  ChatAgentMessage,
  ChatStopMessage,
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
  github: GitHubStatus,
  workspaces: z.array(z.object({ participantId: z.string(), workspace: Workspace })),
  agents: z.array(AgentProfile),
  chats: z.array(ChatInfo),
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

export const GitHubStatusMessage = z.object({
  type: z.literal('github.status'),
  status: GitHubStatus,
});

export const WorkspaceChangedMessage = z.object({
  type: z.literal('workspace.changed'),
  participantId: z.string(),
  workspace: Workspace.nullable(),
});

export const AgentChangedMessage = z.object({
  type: z.literal('agent.changed'),
  agent: AgentProfile,
});

export const AgentRemovedMessage = z.object({
  type: z.literal('agent.removed'),
  agentId: z.string(),
});

export const ChatChangedMessage = z.object({
  type: z.literal('chat.changed'),
  chat: ChatInfo,
});

export const ChatRemovedMessage = z.object({
  type: z.literal('chat.removed'),
  chatId: z.string(),
});

/** A new or updated chat message. */
export const ChatMessageMessage = z.object({
  type: z.literal('chat.message'),
  message: ChatMessage,
});

/** The messages of a chat, oldest first, in answer to chat.open. */
export const ChatHistoryMessage = z.object({
  type: z.literal('chat.history'),
  chatId: z.string(),
  messages: z.array(ChatMessage),
});

/** Someone asked the chat's agent to stop. */
export const ChatStoppedMessage = z.object({
  type: z.literal('chat.stopped'),
  chatId: z.string(),
  by: z.string(),
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
  'replaced',
  'conflict',
  'agent_running',
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
  GitHubStatusMessage,
  WorkspaceChangedMessage,
  AgentChangedMessage,
  AgentRemovedMessage,
  ChatChangedMessage,
  ChatRemovedMessage,
  ChatMessageMessage,
  ChatHistoryMessage,
  ChatStoppedMessage,
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
  /** The same identity connected again from somewhere else. */
  replaced: 4005,
  /** That agent is already running on someone's PC. */
  agentRunning: 4006,
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

/** What a client saves about a session between runs (see SessionClient.getSnapshot). */
export const SessionSnapshot = z.object({
  session: SessionInfo,
  tasks: z.array(Task),
  locks: z.array(Lock),
  lockRules: LockRules,
  activity: z.array(Activity),
  github: GitHubStatus.default(EMPTY_GITHUB_STATUS),
  agents: z.array(AgentProfile).default([]),
  chats: z.array(ChatInfo).default([]),
  queue: z.array(z.discriminatedUnion('type', [TaskCreateMessage, TaskUpdateMessage, TaskDeleteMessage])),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;

export type AgentSaveMessage = z.infer<typeof AgentSaveMessage>;
export type ChatPostMessage = z.infer<typeof ChatPostMessage>;

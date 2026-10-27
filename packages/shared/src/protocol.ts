import { z } from 'zod';
import {
  Activity,
  AgentApprovals,
  AgentConnection,
  AgentName,
  AgentProfile,
  ApprovalState,
  BranchName,
  Budget,
  ChatActivity,
  ChatAgentState,
  ChatContext,
  ChatInfo,
  ChatMessage,
  ChatMessageKind,
  ChatTitle,
  ChatTool,
  ChatCheckpoint,
  ChatWorktree,
  UndoMode,
  CHAT_TEXT_LIMIT,
  CRITERIA_LIMIT,
  CriterionState,
  CriterionText,
  Handoff,
  EMPTY_GITHUB_STATUS,
  GitHubStatus,
  Lock,
  LockReason,
  LockRules,
  Participant,
  ParticipantKind,
  PresenceStatus,
  RepoRef,
  SessionInfo,
  Task,
  TaskScope,
  ReadList,
  TaskStage,
  TaskTitle,
  Workspace,
} from './model.js';
import { BloatReport } from './bloat.js';
import { ISSUE_BODY_LIMIT, ISSUE_COMMENT_LIMIT, ISSUE_TITLE_LIMIT } from './issues.js';
import { IssueNumber } from './planning.js';
import { DocId, EncodedUpdate } from './docs.js';
import { PriceTable, UsageReport, UsageRow } from './usage.js';

/** Bumped whenever a message changes in a way older clients cannot read. */
export const PROTOCOL_VERSION = 14;

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
  agent: z.object({ profileId: z.string(), startedBy: z.string().max(64), startedById: z.string().max(64).optional() }).optional(),
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

/** Acceptance criteria as written; results stay with the criterion of the same id. */
export const CriteriaTexts = z.array(z.object({ id: z.string().min(1).max(64), text: CriterionText })).max(CRITERIA_LIMIT);

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
  readFirst: ReadList.optional(),
  /** The planning-space feature the task comes from. */
  featureId: z.string().max(64).nullable().optional(),
  criteria: CriteriaTexts.optional(),
});

const TaskFields = z.object({
  title: TaskTitle.optional(),
  stage: TaskStage.optional(),
  /** A connected participant's id, or null to unassign. */
  ownerId: z.string().nullable().optional(),
  scope: TaskScope.optional(),
  /** Files to read first. */
  readFirst: ReadList.optional(),
  /** A branch name, or null to unlink. */
  branch: BranchName.nullable().optional(),
  criteria: CriteriaTexts.optional(),
  /** Dollars all the task's agent chats may spend, or null for no limit. */
  budget: Budget.nullable().optional(),
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

/** Records a test result for one acceptance criterion. People and agents both can. */
export const TaskVerifyMessage = z.object({
  type: z.literal('task.verify'),
  taskId: z.string(),
  criterionId: z.string(),
  state: CriterionState,
  evidence: z.string().max(4000),
});

/** Starts syncing a shared document: what this client has, as a Yjs state vector. */
export const DocSyncMessage = z.object({
  type: z.literal('doc.sync'),
  docId: DocId,
  stateVector: EncodedUpdate,
});

/** A change to a shared document (a Yjs update); the server merges and relays it. */
export const DocUpdateMessage = z.object({
  type: z.literal('doc.update'),
  docId: DocId,
  update: EncodedUpdate,
});

/** Shares the result of a bloat check run on your project folder. */
export const BloatReportMessage = z.object({
  type: z.literal('bloat.report'),
  report: BloatReport,
});

export const LockAcquireMessage = z.object({
  type: z.literal('lock.acquire'),
  path: z.string().min(1).max(260),
  taskId: z.string().nullable().optional(),
  /** Ask for an exclusive lock even if the rules would give a soft one. */
  exclusive: z.boolean().optional(),
  /** The agent chat the lock is for. */
  chatId: z.string().nullable().optional(),
  reason: LockReason.nullable().optional(),
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

/** Opens an issue on GitHub with the host's token; answered with github.issue.result. */
export const GitHubIssueCreateMessage = z.object({
  type: z.literal('github.issue.create'),
  requestId: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(ISSUE_TITLE_LIMIT),
  body: z.string().max(ISSUE_BODY_LIMIT),
});

/** Closes an issue as completed, after posting a comment; answered with github.issue.result. */
export const GitHubIssueCloseMessage = z.object({
  type: z.literal('github.issue.close'),
  requestId: z.string().min(1).max(64),
  number: IssueNumber,
  comment: z.string().trim().min(1).max(ISSUE_COMMENT_LIMIT),
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

/** Starts a new chat with a copy of another chat's messages up to and including one of them. */
export const ChatBranchMessage = z.object({
  type: z.literal('chat.branch'),
  /** Chosen by the client so it can open the chat right away. */
  id: z.string().min(8).max(64),
  fromChatId: z.string(),
  fromMessageId: z.string(),
  /** The agent that carries on; the parent chat's agent when left out. */
  agentId: z.string().optional(),
  title: ChatTitle,
});

export const ChatUpdateMessage = z.object({
  type: z.literal('chat.update'),
  chatId: z.string(),
  title: ChatTitle.optional(),
  taskId: z.string().nullable().optional(),
  /** Dollars the chat's agent may spend, or null for no limit. */
  budget: Budget.nullable().optional(),
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
    /** Agents only, on checkpoint messages. */
    checkpoint: ChatCheckpoint.nullable().optional(),
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
  /** One line on what it is doing now; left out keeps the last one. Cleared when idle. */
  activity: ChatActivity.nullable().optional(),
});

/**
 * Reports the agent's own copy of the project for a chat (null once it is
 * gone). Sent by the agent and by its owner's app after merging or
 * discarding; a note is recorded in the activity feed.
 */
export const ChatWorktreeMessage = z.object({
  type: z.literal('chat.worktree'),
  chatId: z.string(),
  worktree: ChatWorktree.nullable(),
  /** What happened, e.g. "merged agent/jump into main". */
  note: z.string().trim().min(1).max(300).optional(),
  /** The agent did it for this person (say, an undo): the note is theirs in the activity feed. */
  noteBy: z.string().trim().min(1).max(64).optional(),
});

/** Asks the chat's agent to stop what it is doing. */
export const ChatStopMessage = z.object({
  type: z.literal('chat.stop'),
  chatId: z.string(),
});

/** A person asks the chat's agent to undo a turn, or take its copy back to one (a checkpoint message). */
export const ChatUndoMessage = z.object({
  type: z.literal('chat.undo'),
  chatId: z.string(),
  messageId: z.string(),
  mode: UndoMode,
});

/** An agent's runner reports what a model call used. */
export const UsageRecordMessage = z.object({
  type: z.literal('usage.record'),
  usage: UsageReport,
});

/** Changes the session's model prices. */
export const PricesUpdateMessage = z.object({
  type: z.literal('prices.update'),
  prices: PriceTable,
});

export const ClientMessage = z.discriminatedUnion('type', [
  HelloMessage,
  PresenceUpdateMessage,
  PingMessage,
  TaskCreateMessage,
  TaskUpdateMessage,
  TaskDeleteMessage,
  TaskVerifyMessage,
  DocSyncMessage,
  DocUpdateMessage,
  BloatReportMessage,
  LockAcquireMessage,
  LockReleaseMessage,
  LockRecoverMessage,
  LockRulesUpdateMessage,
  GitHubLinkMessage,
  GitHubIssueCreateMessage,
  GitHubIssueCloseMessage,
  WorkspaceUpdateMessage,
  AgentSaveMessage,
  AgentDeleteMessage,
  ChatCreateMessage,
  ChatBranchMessage,
  ChatUpdateMessage,
  ChatDeleteMessage,
  ChatOpenMessage,
  ChatPostMessage,
  ChatDecideMessage,
  ChatAgentMessage,
  ChatWorktreeMessage,
  ChatStopMessage,
  ChatUndoMessage,
  UsageRecordMessage,
  PricesUpdateMessage,
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
  bloat: BloatReport.nullable(),
  /** What agents used, per chat, day and model. */
  usage: z.array(UsageRow),
  prices: PriceTable,
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

/** The answer to github.issue.create or github.issue.close, sent only to whoever asked. */
export const GitHubIssueResultMessage = z.object({
  type: z.literal('github.issue.result'),
  requestId: z.string(),
  /** The issue's number and address when it worked; what went wrong otherwise. */
  issue: z.object({ number: z.number().int(), url: z.string() }).nullable(),
  error: z.string().nullable(),
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

/** Someone asked the chat's agent to undo a turn; its runner does it in the chat's copy. */
export const ChatUndoRequestedMessage = z.object({
  type: z.literal('chat.undo'),
  chatId: z.string(),
  messageId: z.string(),
  mode: UndoMode,
  by: z.string(),
});

/**
 * The answer to doc.sync: what the client is missing, and the server's state
 * vector so the client can send back what the server is missing.
 */
export const DocStateMessage = z.object({
  type: z.literal('doc.state'),
  docId: DocId,
  update: EncodedUpdate,
  stateVector: EncodedUpdate,
});

/** Someone else changed a shared document. */
export const DocChangedMessage = z.object({
  type: z.literal('doc.changed'),
  docId: DocId,
  update: EncodedUpdate,
});

export const BloatChangedMessage = z.object({
  type: z.literal('bloat.changed'),
  report: BloatReport,
});

/**
 * The host made a new invite code. Everyone connected gets its secret, so
 * reconnecting (and a saved Rejoin) keeps working; the old code stops working.
 */
export const SessionSecretMessage = z.object({
  type: z.literal('session.secret'),
  secret: z.string().min(1),
});

export const UsageChangedMessage = z.object({
  type: z.literal('usage.changed'),
  row: UsageRow,
});

export const PricesChangedMessage = z.object({
  type: z.literal('prices.changed'),
  prices: PriceTable,
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
  /** The host removed you from the session. */
  'removed',
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
  GitHubIssueResultMessage,
  WorkspaceChangedMessage,
  AgentChangedMessage,
  AgentRemovedMessage,
  ChatChangedMessage,
  ChatRemovedMessage,
  ChatMessageMessage,
  ChatHistoryMessage,
  ChatStoppedMessage,
  ChatUndoRequestedMessage,
  DocStateMessage,
  DocChangedMessage,
  BloatChangedMessage,
  SessionSecretMessage,
  UsageChangedMessage,
  PricesChangedMessage,
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
  /** The host removed this person (or an agent they started) from the session. */
  removed: 4007,
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
  bloat: BloatReport.nullable().default(null),
  usage: z.array(UsageRow).default([]),
  prices: PriceTable.optional(),
  /** Each shared document's full Yjs state, including edits not synced yet. */
  docs: z.partialRecord(DocId, z.string()).default({}),
  queue: z.array(z.discriminatedUnion('type', [TaskCreateMessage, TaskUpdateMessage, TaskDeleteMessage, TaskVerifyMessage])),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;

export type AgentSaveMessage = z.infer<typeof AgentSaveMessage>;
export type ChatPostMessage = z.infer<typeof ChatPostMessage>;

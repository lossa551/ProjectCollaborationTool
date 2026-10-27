import { z } from 'zod';

// Core records of a session. People and agents are both participants: they
// show up in presence, hold locks and own tasks the same way.

export const ParticipantKind = z.enum(['human', 'agent']);
export type ParticipantKind = z.infer<typeof ParticipantKind>;

export const PresenceStatus = z.enum(['active', 'idle', 'away']);
export type PresenceStatus = z.infer<typeof PresenceStatus>;

export const Participant = z.object({
  id: z.string(),
  name: z.string(),
  kind: ParticipantKind,
  status: PresenceStatus,
  /** What the participant is looking at or working on, e.g. a task id or file path. */
  focus: z.string().nullable(),
  connectedAt: z.number(),
  /** For a running agent: its agent profile and the person whose PC runs it. */
  agent: z.object({ profileId: z.string(), startedBy: z.string(), startedById: z.string().optional() }).nullable().default(null),
});
export type Participant = z.infer<typeof Participant>;

export const SessionInfo = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const TaskStage = z.enum(['planning', 'implementing', 'review', 'testing', 'done']);
export type TaskStage = z.infer<typeof TaskStage>;

export const STAGE_LABELS: Record<TaskStage, string> = {
  planning: 'Planning',
  implementing: 'Implementing',
  review: 'Review',
  testing: 'Testing',
  done: 'Done',
};

/**
 * Who owns a task. Name and kind are kept so the card still reads right while
 * the owner is offline. Participant ids are per connection until stable
 * identities land (issue #4).
 */
export const TaskOwner = z.object({
  id: z.string(),
  name: z.string(),
  kind: ParticipantKind,
});
export type TaskOwner = z.infer<typeof TaskOwner>;

export const TaskTitle = z.string().trim().min(1).max(200);
export const TaskScope = z.array(z.string().trim().min(1).max(260)).max(100);
/** Files (or folders) an agent should read before starting, so it does not have to explore. */
export const ReadList = z.array(z.string().trim().min(1).max(260)).max(50);
/** A git branch name, as GitHub shows it. */
export const BranchName = z.string().trim().min(1).max(255);

/** Whether an acceptance criterion has been checked, and how it went. */
export const CriterionState = z.enum(['untested', 'verified', 'failing']);
export type CriterionState = z.infer<typeof CriterionState>;

export const CRITERION_STATE_LABELS: Record<CriterionState, string> = {
  untested: 'Not tested',
  verified: 'Verified',
  failing: 'Failing',
};

export const CriterionText = z.string().trim().min(1).max(1000);
export const CRITERIA_LIMIT = 50;

export const Criterion = z.object({
  id: z.string().min(1).max(64),
  text: CriterionText,
  state: CriterionState,
  /** The recorded test result: what was checked and what happened. */
  evidence: z.string().max(4000),
  /** Who recorded the result, and when. */
  by: z.string().max(64).nullable(),
  at: z.number().nullable(),
});
export type Criterion = z.infer<typeof Criterion>;

export const Task = z.object({
  id: z.string(),
  title: TaskTitle,
  stage: TaskStage,
  owner: TaskOwner.nullable(),
  /** Paths the task is allowed to change (glob patterns). */
  scope: TaskScope,
  /** Files to read first, chosen when the task is planned. */
  readFirst: ReadList.default([]),
  /** The git branch the work happens on; its pull request shows on the card. */
  branch: BranchName.nullable().default(null),
  /** The planning-space feature this task was created from. */
  featureId: z.string().nullable().default(null),
  /** What must be true before the task is done, each with its test result. */
  criteria: z.array(Criterion).max(CRITERIA_LIMIT).default([]),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Bumped on every change; lets offline edits detect conflicts later. */
  version: z.number().int(),
});
export type Task = z.infer<typeof Task>;

/** One line in the activity feed. */
export const Activity = z.object({
  id: z.string(),
  at: z.number(),
  actorName: z.string().nullable(),
  text: z.string(),
  taskId: z.string().nullable(),
});
export type Activity = z.infer<typeof Activity>;

/** Exclusive locks block others (binary assets); soft locks only warn (code). */
export const LockKind = z.enum(['exclusive', 'soft']);
export type LockKind = z.infer<typeof LockKind>;

export const LockReason = z.string().trim().max(200);

export const Lock = z.object({
  id: z.string(),
  /** Repo-relative path with forward slashes. */
  path: z.string(),
  kind: LockKind,
  /** Snapshot like a task owner, so the lock reads right while the holder is away. */
  holder: TaskOwner,
  taskId: z.string().nullable(),
  /** The agent chat the lock was taken for, so people can see the conversation behind it. */
  chatId: z.string().nullable().default(null),
  /** Why the file is locked, in a few words (an agent uses its chat's title). */
  reason: LockReason.nullable().default(null),
  acquiredAt: z.number(),
  /** Last time the holder was seen connected. */
  heartbeatAt: z.number(),
  /** The holder stopped answering; anyone may recover the lock. */
  abandoned: z.boolean(),
});
export type Lock = z.infer<typeof Lock>;

export const LockRules = z.object({
  /** Files matching these patterns need an exclusive lock; everything else gets a soft lock. */
  exclusivePatterns: z.array(z.string().trim().min(1).max(200)).max(200),
});
export type LockRules = z.infer<typeof LockRules>;

/**
 * Binary formats that can never be merged. Engine integrations add their own
 * (e.g. .tscn for Godot, .uasset for Unreal); users can edit the list.
 */
export const DEFAULT_LOCK_RULES: LockRules = {
  exclusivePatterns: [
    '*.psd',
    '*.kra',
    '*.blend',
    '*.fbx',
    '*.png',
    '*.jpg',
    '*.wav',
    '*.ogg',
    '*.mp3',
    '*.sqlite',
    '*.db',
  ],
};

// GitHub status. The server polls GitHub for the linked repository and sends
// everyone the same picture, so only the host needs a token.

export const RepoRef = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
});
export type RepoRef = z.infer<typeof RepoRef>;

/** Reads "owner/name", a GitHub URL, or a git remote URL. */
export function parseRepoRef(input: string): RepoRef | null {
  const text = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const match = /(?:github\.com[/:])?([^/:\s]+)\/([^/\s]+)$/.exec(text);
  if (!match) return null;
  const parsed = RepoRef.safeParse({ owner: match[1], name: match[2] });
  return parsed.success ? parsed.data : null;
}

export const CheckState = z.enum(['success', 'failure', 'pending', 'none']);
export type CheckState = z.infer<typeof CheckState>;

export const CheckRun = z.object({
  name: z.string(),
  state: CheckState,
  url: z.string().nullable(),
});
export type CheckRun = z.infer<typeof CheckRun>;

export const PullRequest = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['open', 'merged', 'closed']),
  draft: z.boolean(),
  author: z.string(),
  branch: z.string(),
  base: z.string(),
  /** Whether it can merge into its base; "unknown" while GitHub is still working it out. */
  mergeable: z.enum(['mergeable', 'conflicting', 'unknown']),
  review: z.enum(['approved', 'changes_requested', 'review_required', 'none']),
  checks: CheckState,
  checkRuns: z.array(CheckRun),
  /** Changed files (open pull requests only, at most 300). */
  files: z.array(z.string()),
  updatedAt: z.number(),
});
export type PullRequest = z.infer<typeof PullRequest>;

export const Branch = z.object({
  name: z.string(),
  sha: z.string(),
  /** Commits ahead of and behind the default branch; only worked out for branches linked to a task. */
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  /** Files changed on the branch since it left the default branch, when ahead/behind is known. */
  files: z.array(z.string()).nullable(),
});
export type Branch = z.infer<typeof Branch>;

export const IssueLabel = z.object({
  name: z.string(),
  /** Hex colour without the "#", as GitHub gives it. */
  color: z.string(),
});
export type IssueLabel = z.infer<typeof IssueLabel>;

/** An open issue (not a pull request) in the linked repository. */
export const Issue = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  labels: z.array(IssueLabel),
  /** GitHub logins. */
  assignees: z.array(z.string()),
  /** The issue text, shortened; used when a feature is made from it. */
  body: z.string(),
  comments: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Issue = z.infer<typeof Issue>;

export const GitHubStatus = z.object({
  repo: RepoRef.nullable(),
  defaultBranch: z.string().nullable(),
  /** The server has a token; without one it polls rarely (public repositories only). */
  authenticated: z.boolean(),
  /** What went wrong on the last poll; the data below is then from the last good one. */
  error: z.string().nullable(),
  fetchedAt: z.number().nullable(),
  branches: z.array(Branch),
  /** Open pull requests, then the most recently closed or merged ones. */
  pulls: z.array(PullRequest),
  /** Open issues, most recently updated first. */
  issues: z.array(Issue).default([]),
});
export type GitHubStatus = z.infer<typeof GitHubStatus>;

export const EMPTY_GITHUB_STATUS: GitHubStatus = {
  repo: null,
  defaultBranch: null,
  authenticated: false,
  error: null,
  fetchedAt: null,
  branches: [],
  pulls: [],
  issues: [],
};

/** The pull request for a branch: the open one, else the most recent closed one. */
export function pullForBranch(status: GitHubStatus, branch: string | null): PullRequest | null {
  if (!branch) return null;
  const matches = status.pulls.filter((p) => p.branch === branch);
  return matches.find((p) => p.state === 'open') ?? matches.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

// Workspaces: each person's (and later each agent's) local checkout, reported
// by their own app so others can see who is changing what before it is pushed.

export const FileChange = z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked']);
export type FileChange = z.infer<typeof FileChange>;

export const WORKSPACE_FILE_LIMIT = 500;

export const Workspace = z.object({
  /** Checked-out branch; null when detached. */
  branch: BranchName.nullable(),
  /** What the changes are measured against, e.g. origin/main. */
  base: z.string().max(255).nullable(),
  /** Changed files since the branch left the base, committed or not. */
  files: z
    .array(z.object({ path: z.string().min(1).max(1024), change: FileChange }))
    .max(WORKSPACE_FILE_LIMIT),
  /** More files changed than are listed. */
  truncated: z.boolean(),
  updatedAt: z.number(),
});
export type Workspace = z.infer<typeof Workspace>;

// Agents. An agent profile is shared with the session (so both people see what
// each agent may do), but it runs on the PC of whoever starts it, and its API
// key never leaves that PC. A running agent joins as its own participant.

/** Model APIs the app runs its own agent loop for. Ollama is the local runtime. */
export const ApiProvider = z.enum(['anthropic', 'deepseek', 'openai', 'ollama', 'openai-compatible']);
export type ApiProvider = z.infer<typeof ApiProvider>;

export const API_PROVIDERS: Record<ApiProvider, { label: string; baseUrl: string | null; model: string; needsKey: boolean }> = {
  anthropic: { label: 'Claude (Anthropic API)', baseUrl: null, model: 'claude-opus-5-5', needsKey: true },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', needsKey: true },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', needsKey: true },
  ollama: { label: 'Ollama (local model)', baseUrl: 'http://localhost:11434/v1', model: 'qwen3', needsKey: false },
  'openai-compatible': { label: 'Other OpenAI-compatible API', baseUrl: null, model: '', needsKey: true },
};

/** Where a provider's key is kept on a PC: per provider, or per address for other compatible APIs. */
export function apiKeyName(provider: ApiProvider, baseUrl: string | null): string {
  if (provider !== 'openai-compatible') return provider;
  try {
    return `openai-compatible:${new URL(baseUrl ?? '').host}`;
  } catch {
    return 'openai-compatible';
  }
}

/** The environment variable a provider's key can also come from. */
export const API_KEY_ENV: Partial<Record<ApiProvider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/** Command-line agents run headless; their tool use is routed through the app. */
export const CliTool = z.enum(['claude-code', 'codex']);
export type CliTool = z.infer<typeof CliTool>;

export const CLI_TOOLS: Record<CliTool, { label: string; command: string }> = {
  'claude-code': { label: 'Claude Code', command: 'claude' },
  codex: { label: 'Codex CLI', command: 'codex' },
};

export const AgentConnection = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('api'),
    provider: ApiProvider,
    model: z.string().trim().min(1).max(100),
    /** Only for providers without a fixed address (openai-compatible), or to override one. */
    baseUrl: z.string().trim().url().max(300).nullable().default(null),
  }),
  z.object({
    type: z.literal('cli'),
    tool: CliTool,
    /** Passed to the tool's --model flag; null uses the tool's own default. */
    model: z.string().trim().min(1).max(100).nullable().default(null),
  }),
]);
export type AgentConnection = z.infer<typeof AgentConnection>;

/** allow: just do it; ask: show an approval card in the chat; deny: refuse. */
export const ApprovalPolicy = z.enum(['allow', 'ask', 'deny']);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

export const AgentApprovals = z.object({
  /** Editing files inside the agent's allowed paths and the task's scope. */
  editInScope: ApprovalPolicy,
  /** Editing anything else. */
  editOutsideScope: ApprovalPolicy,
  /** Running shell commands. */
  commands: ApprovalPolicy,
});
export type AgentApprovals = z.infer<typeof AgentApprovals>;

export const DEFAULT_APPROVALS: AgentApprovals = { editInScope: 'allow', editOutsideScope: 'ask', commands: 'ask' };

export const AgentName = z.string().trim().min(1).max(64);

export const AgentProfile = z.object({
  id: z.string(),
  name: AgentName,
  connection: AgentConnection,
  /** What this agent is for, given to it as instructions. */
  responsibilities: z.string().max(4000),
  /** Paths the agent may change (glob patterns); empty means anywhere the task allows. */
  allowedPaths: TaskScope,
  approvals: AgentApprovals,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type AgentProfile = z.infer<typeof AgentProfile>;

export function describeConnection(connection: AgentConnection): string {
  if (connection.type === 'cli') {
    const label = CLI_TOOLS[connection.tool].label;
    return connection.model ? `${label} · ${connection.model}` : label;
  }
  return `${API_PROVIDERS[connection.provider].label} · ${connection.model}`;
}

// Agent chats. Shared: everyone in the session sees every chat live and can
// post in it. The agent's own messages (text, tool use, approval cards) come
// from its runner on the PC that started it.

/** What one agent or stage hands to the next, so nothing agreed gets lost. */
export const Handoff = z.object({
  fromChatId: z.string().nullable(),
  /** Name of the agent or person handing off. */
  fromName: z.string().max(64).nullable(),
  /** The stage the work moves into. */
  stage: TaskStage.nullable(),
  plan: z.string().max(20000),
  decisions: z.array(z.string().trim().min(1).max(1000)).max(50),
  criteria: z.array(z.string().trim().min(1).max(1000)).max(50),
  scope: TaskScope,
  readFirst: ReadList.default([]),
  notes: z.string().max(10000),
});
export type Handoff = z.infer<typeof Handoff>;

/** What the agent has in its context, as its runner reports it. */
export const ChatContext = z.object({
  items: z
    .array(z.object({ label: z.string().max(200), detail: z.string().max(500), tokens: z.number().int() }))
    .max(200),
  /** Rough size of everything sent to the model, in tokens. */
  tokens: z.number().int(),
});
export type ChatContext = z.infer<typeof ChatContext>;

export const ChatAgentState = z.enum(['idle', 'working', 'waiting']);
export type ChatAgentState = z.infer<typeof ChatAgentState>;

export const ChatTitle = z.string().trim().min(1).max(200);
export const ChatActivity = z.string().max(300);

/** Where a branched chat came from: the chat and the last message it copied. */
export const ChatBranch = z.object({
  chatId: z.string(),
  messageId: z.string(),
  /** The parent's title when branched, so the link still reads well if it is renamed or deleted. */
  title: ChatTitle,
});
export type ChatBranch = z.infer<typeof ChatBranch>;

/**
 * The agent's own copy of the project for one chat: a git worktree on its own
 * branch, on the PC of the person who started the agent. Its edits stay there
 * until someone merges them, so they never mix with a person's own changes.
 */
export const ChatWorktree = z.object({
  /** The agent's branch, e.g. agent/double-jump-3f2a1c. */
  branch: BranchName,
  /** The branch it started from, e.g. main; null when that was a detached commit. */
  base: BranchName.nullable(),
  /** The commit it started from. */
  baseCommit: z.string().min(4).max(64),
  /** Where the copy is, on its owner's PC. */
  folder: z.string().min(1).max(1024),
  /** The person whose PC holds the copy; only they can open, merge or discard it. */
  owner: z.object({ id: z.string(), name: z.string() }),
  /** Files changed on the branch since it started, committed or not. */
  files: z
    .array(z.object({ path: z.string().min(1).max(1024), change: FileChange }))
    .max(WORKSPACE_FILE_LIMIT),
  truncated: z.boolean(),
  /** Commits on the branch that are not in the base yet. */
  commits: z.number().int().min(0),
  /** Files changed but not committed in the copy. */
  uncommitted: z.number().int().min(0),
  /** The commit checked out in the copy now, so people can see which turn it is at. */
  head: z.string().max(64).nullable().default(null),
  updatedAt: z.number(),
});
export type ChatWorktree = z.infer<typeof ChatWorktree>;

export const ChatInfo = z.object({
  id: z.string(),
  title: ChatTitle,
  agentId: z.string(),
  taskId: z.string().nullable(),
  createdBy: TaskOwner,
  handoff: Handoff.nullable(),
  branchedFrom: ChatBranch.nullable().default(null),
  /** The agent's own copy of the project; null until it starts, or without git. */
  worktree: ChatWorktree.nullable().default(null),
  state: ChatAgentState,
  /** What the agent is doing right now, in one line, e.g. "Editing src/player.ts". Null when idle. */
  activity: ChatActivity.nullable().default(null),
  context: ChatContext.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ChatInfo = z.infer<typeof ChatInfo>;

export const ChatMessageKind = z.enum(['text', 'tool', 'approval', 'notice', 'handoff', 'checkpoint']);
export type ChatMessageKind = z.infer<typeof ChatMessageKind>;

export const ToolStatus = z.enum(['running', 'done', 'failed', 'blocked']);
export type ToolStatus = z.infer<typeof ToolStatus>;

export const ChatTool = z.object({
  name: z.string().max(100),
  /** One line, e.g. the path or command. */
  summary: z.string().max(500),
  status: ToolStatus,
  output: z.string().max(4000),
});
export type ChatTool = z.infer<typeof ChatTool>;

export const ApprovalState = z.enum(['pending', 'approved', 'denied', 'expired']);
export type ApprovalState = z.infer<typeof ApprovalState>;

export const ChatApproval = z.object({
  /** What the agent wants to do, e.g. "Edit scripts/ui/menu.gd". */
  action: z.string().max(500),
  /** Why it needs approval: outside the plan, a soft lock held by someone else, a command. */
  reason: z.string().max(1000),
  state: ApprovalState,
  decidedBy: z.string().max(64).nullable(),
});
export type ChatApproval = z.infer<typeof ChatApproval>;

/** Undo this turn reverts its commit; go back resets the copy to the state after it. */
export const UndoMode = z.enum(['undo', 'go-back']);
export type UndoMode = z.infer<typeof UndoMode>;

/**
 * The end of an agent turn that changed files: the agent's copy was saved as
 * a commit on its branch, so the turn can be undone, or the copy taken back
 * to it. A branched chat keeps its parent's checkpoints, so it can start its
 * own copy from one of them.
 */
export const ChatCheckpoint = z.object({
  /** Counts the chat's turns that changed files, from 1. */
  turn: z.number().int().min(1),
  /** The copy after the turn. */
  commit: z.string().min(4).max(64),
  /** The copy before it. */
  parent: z.string().min(4).max(64),
  /** The agent branch the commit is on. */
  branch: BranchName,
  files: z
    .array(z.object({ path: z.string().min(1).max(1024), change: FileChange }))
    .max(WORKSPACE_FILE_LIMIT),
  truncated: z.boolean(),
  /** Set while the turn's changes are not in the copy: undone, or the copy went back to before it. */
  undone: z.object({ by: z.string().max(64), at: z.number(), how: UndoMode }).nullable(),
  /** The commit that undid the turn, after "Undo this turn". */
  revertCommit: z.string().max(64).nullable().default(null),
});
export type ChatCheckpoint = z.infer<typeof ChatCheckpoint>;

/**
 * The last checkpoint at or before a message, still in its copy. Where a
 * chat branched from that message would start its own copy.
 */
export function checkpointAt(messages: ChatMessage[], messageId: string): ChatCheckpoint | null {
  const end = messages.findIndex((m) => m.id === messageId);
  for (let i = end; i >= 0; i--) {
    const checkpoint = messages[i]!.checkpoint;
    if (checkpoint && !checkpoint.undone) return checkpoint;
  }
  return null;
}

export const CHAT_TEXT_LIMIT = 100_000;

export const ChatMessage = z.object({
  id: z.string(),
  chatId: z.string(),
  author: TaskOwner,
  kind: ChatMessageKind,
  text: z.string().max(CHAT_TEXT_LIMIT),
  /** Still being written; the agent keeps updating it. */
  streaming: z.boolean(),
  tool: ChatTool.nullable(),
  approval: ChatApproval.nullable(),
  /** Only on checkpoint messages. */
  checkpoint: ChatCheckpoint.nullable().default(null),
  at: z.number(),
  updatedAt: z.number(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** Rough token count for showing context size (about four characters a token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The handoff package as text, the way the receiving agent reads it. */
export function renderHandoff(handoff: Handoff, taskTitle: string | null): string {
  const lines: string[] = [];
  lines.push(`Handoff${handoff.fromName ? ` from ${handoff.fromName}` : ''}${taskTitle ? ` for "${taskTitle}"` : ''}.`);
  if (handoff.stage) lines.push(`Stage: ${STAGE_LABELS[handoff.stage]}`);
  if (handoff.plan.trim()) lines.push('', 'Plan:', handoff.plan.trim());
  if (handoff.decisions.length) lines.push('', 'Decisions:', ...handoff.decisions.map((d) => `- ${d}`));
  if (handoff.criteria.length) lines.push('', 'Acceptance criteria:', ...handoff.criteria.map((c) => `- ${c}`));
  if (handoff.scope.length) lines.push('', 'Allowed paths:', ...handoff.scope.map((s) => `- ${s}`));
  if (handoff.readFirst.length) lines.push('', 'Read first:', ...handoff.readFirst.map((s) => `- ${s}`));
  if (handoff.notes.trim()) lines.push('', 'Notes:', handoff.notes.trim());
  return lines.join('\n');
}

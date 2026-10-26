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
/** A git branch name, as GitHub shows it. */
export const BranchName = z.string().trim().min(1).max(255);

export const Task = z.object({
  id: z.string(),
  title: TaskTitle,
  stage: TaskStage,
  owner: TaskOwner.nullable(),
  /** Paths the task is allowed to change (glob patterns). */
  scope: TaskScope,
  /** The git branch the work happens on; its pull request shows on the card. */
  branch: BranchName.nullable().default(null),
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

export const Lock = z.object({
  id: z.string(),
  /** Repo-relative path with forward slashes. */
  path: z.string(),
  kind: LockKind,
  /** Snapshot like a task owner, so the lock reads right while the holder is away. */
  holder: TaskOwner,
  taskId: z.string().nullable(),
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

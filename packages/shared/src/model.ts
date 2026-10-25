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

export const Task = z.object({
  id: z.string(),
  title: TaskTitle,
  stage: TaskStage,
  owner: TaskOwner.nullable(),
  /** Paths the task is allowed to change (glob patterns). */
  scope: TaskScope,
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

// Lock shapes from docs/design. The server does not serve them yet (issue #3);
// they are here so both sides agree on them from the start.

/** Exclusive locks block others (binary assets); soft locks only warn (code). */
export const LockKind = z.enum(['exclusive', 'soft']);
export type LockKind = z.infer<typeof LockKind>;

export const Lock = z.object({
  path: z.string(),
  kind: LockKind,
  holderId: z.string(),
  taskId: z.string().nullable(),
  acquiredAt: z.number(),
  /** Last heartbeat from the holder; a stale heartbeat makes the lock recoverable. */
  heartbeatAt: z.number(),
});
export type Lock = z.infer<typeof Lock>;

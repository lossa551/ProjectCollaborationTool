import type { SessionState } from './client.js';
import { pullForBranch, type PullRequest, type Task, type TaskOwner, type TaskStage } from './model.js';
import { featureStatus, type AssignStage, type FeatureStatus, type Milestone, type PlanItem, type PlanOp } from './planning.js';

// The roadmap (issue #42): every feature, grouped by milestone and in priority
// order, with how far each one is. Worked out here so the Roadmap view and the
// milestone summary on Home agree.

/** Blocked features this close to a milestone's target date put it at risk. */
export const RISK_DAYS = 7;

const DAY_MS = 24 * 60 * 60_000;

/** One agent working on a feature, from the chats linked to its tasks. */
export interface RoadmapAgent {
  name: string;
  chatId: string;
  state: 'working' | 'waiting';
}

export interface RoadmapFeature {
  item: PlanItem;
  status: FeatureStatus;
  tasksDone: number;
  /** All acceptance criteria on its tasks. */
  criteria: number;
  /** The pull requests of its tasks' branches, open ones first. */
  pulls: PullRequest[];
  /** Owners of its unfinished tasks. */
  owners: TaskOwner[];
  agents: RoadmapAgent[];
  /** The first task that is not done, and the stage its next piece of work is in. */
  next: { task: Task; stage: AssignStage } | null;
}

export type MilestoneRisk = 'at-risk' | 'overdue' | null;

export interface RoadmapLane {
  milestone: Milestone;
  features: RoadmapFeature[];
  /** Features whose tasks are all done. */
  done: number;
  blocked: number;
  unverified: number;
  /** Whole days until the target date (0 on the day, negative after); null without one. */
  daysLeft: number | null;
  risk: MilestoneRisk;
}

type RoadmapInput = Pick<SessionState, 'planning' | 'milestones' | 'tasks' | 'github' | 'chats' | 'agents'>;

/** The milestone a feature is in: its own, or the first when that is unset or gone. */
export function laneOf(item: PlanItem, milestones: Milestone[]): string | null {
  if (item.milestoneId && milestones.some((m) => m.id === item.milestoneId)) return item.milestoneId;
  return milestones[0]?.id ?? null;
}

/** Ranked features first, by rank; then the rest in creation order. */
function byPosition(a: PlanItem, b: PlanItem): number {
  if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank - b.rank;
  if (a.rank !== null && b.rank === null) return -1;
  if (a.rank === null && b.rank !== null) return 1;
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

/** The features of each milestone, in order; ideas and notes are not on the roadmap. */
export function laneFeatures(planning: PlanItem[], milestones: Milestone[]): Map<string, PlanItem[]> {
  const lanes = new Map(milestones.map((m) => [m.id, [] as PlanItem[]]));
  for (const item of planning) {
    if (item.kind !== 'feature') continue;
    const lane = laneOf(item, milestones);
    if (lane) lanes.get(lane)!.push(item);
  }
  for (const items of lanes.values()) items.sort(byPosition);
  return lanes;
}

/** The task stage a task's next piece of work is in: a planned task is ready to build. */
export function workStage(stage: TaskStage): AssignStage {
  return stage === 'planning' || stage === 'done' ? 'implementing' : stage;
}

/** Whole days from today to a YYYY-MM-DD date, in local time. */
export function daysUntil(target: string, now = Date.now()): number {
  const [y, m, d] = target.split('-').map(Number) as [number, number, number];
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return Math.round((new Date(y, m - 1, d).getTime() - start) / DAY_MS);
}

export function milestoneRisk(lane: Pick<RoadmapLane, 'daysLeft' | 'done' | 'blocked'> & { total: number }): MilestoneRisk {
  if (lane.daysLeft === null || lane.total === 0 || lane.done === lane.total) return null;
  if (lane.daysLeft < 0) return 'overdue';
  return lane.blocked > 0 && lane.daysLeft <= RISK_DAYS ? 'at-risk' : null;
}

function roadmapFeature(item: PlanItem, input: RoadmapInput): RoadmapFeature {
  const status = featureStatus(item, input.planning, input.tasks);
  const open = status.tasks.filter((t) => t.stage !== 'done');
  const taskIds = new Set(status.tasks.map((t) => t.id));

  const pulls = new Map<number, PullRequest>();
  for (const task of status.tasks) {
    const pull = pullForBranch(input.github, task.branch);
    if (pull) pulls.set(pull.number, pull);
  }

  const owners = new Map<string, TaskOwner>();
  for (const task of open) if (task.owner) owners.set(task.owner.id, task.owner);

  const agents: RoadmapAgent[] = input.chats
    .filter((c) => c.taskId && taskIds.has(c.taskId) && c.state !== 'idle')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => ({
      name: input.agents.find((a) => a.id === c.agentId)?.name ?? 'Agent',
      chatId: c.id,
      state: c.state as RoadmapAgent['state'],
    }));

  const nextTask = [...open].sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
  return {
    item,
    status,
    tasksDone: status.tasks.length - open.length,
    criteria: status.verified + status.failing + status.untested,
    pulls: [...pulls.values()].sort((a, b) => Number(b.state === 'open') - Number(a.state === 'open') || b.updatedAt - a.updatedAt),
    owners: [...owners.values()],
    agents,
    next: nextTask ? { task: nextTask, stage: workStage(nextTask.stage) } : null,
  };
}

/** Every milestone with its features in order and how far it is. */
export function roadmap(input: RoadmapInput, now = Date.now()): RoadmapLane[] {
  const lanes = laneFeatures(input.planning, input.milestones);
  return input.milestones.map((milestone) => {
    const features = (lanes.get(milestone.id) ?? []).map((item) => roadmapFeature(item, input));
    const done = features.filter((f) => f.status.stage === 'done' && f.status.tasks.length > 0).length;
    const blocked = features.filter((f) => f.status.state === 'blocked').length;
    const unverified = features.filter((f) => f.status.state === 'unverified').length;
    const daysLeft = milestone.target ? daysUntil(milestone.target, now) : null;
    return { milestone, features, done, blocked, unverified, daysLeft, risk: milestoneRisk({ daysLeft, done, blocked, total: features.length }) };
  });
}

/** The milestone being worked on: the first with unfinished features, else the first with any. */
export function currentMilestone(lanes: RoadmapLane[]): RoadmapLane | null {
  return lanes.find((l) => l.features.length > 0 && l.done < l.features.length) ?? lanes.find((l) => l.features.length > 0) ?? null;
}

/**
 * The change that moves a feature into a milestone, just before another
 * feature (or at the end). The whole target lane is renumbered.
 */
export function moveFeature(
  planning: PlanItem[],
  milestones: Milestone[],
  featureId: string,
  milestoneId: string,
  beforeId: string | null,
): Extract<PlanOp, { op: 'order' }> {
  const ids = (laneFeatures(planning, milestones).get(milestoneId) ?? []).map((i) => i.id).filter((id) => id !== featureId);
  const at = beforeId ? ids.indexOf(beforeId) : -1;
  ids.splice(at === -1 ? ids.length : at, 0, featureId);
  return { op: 'order', milestoneId, ids };
}

/** "3 days left", "due today", "2 days late". */
export function describeDaysLeft(daysLeft: number): string {
  if (daysLeft === 0) return 'due today';
  if (daysLeft > 0) return `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left`;
  return `${-daysLeft} ${daysLeft === -1 ? 'day' : 'days'} late`;
}

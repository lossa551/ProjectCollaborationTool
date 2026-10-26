import {
  matchesAny,
  normalizePath,
  samePath,
  type AgentProfile,
  type ApprovalPolicy,
  type Lock,
  type LockKind,
  type LockRules,
  type Task,
} from '@pct/shared';

// Decides whether an agent may do something, before it does it. Every agent,
// whatever runs it (our own loop or a CLI tool through its hooks), goes
// through these same checks: locks held by others, the agent's allowed paths,
// the task's scope, and the session's approval rules for that agent.

export interface GuardContext {
  agent: AgentProfile;
  /** The agent's participant id, to tell its own locks from others'. */
  selfId: string;
  task: Task | null;
  /** Scope agreed in a handoff, used when the chat has no task with paths. */
  handoffScope: string[];
  locks: Lock[];
  lockRules: LockRules;
}

export type Verdict = 'allow' | 'ask' | 'deny';

export interface Decision {
  verdict: Verdict;
  /** Why it is not simply allowed; empty when it is. */
  reasons: string[];
}

export interface EditDecision extends Decision {
  /** Normalized repo-relative path, or null when the path leaves the project. */
  path: string | null;
  /** The lock to take before writing. */
  lockKind: LockKind;
}

const RANK: Record<Verdict, number> = { allow: 0, ask: 1, deny: 2 };

function combine(parts: { verdict: Verdict; reason: string | null }[]): Decision {
  let verdict: Verdict = 'allow';
  const reasons: string[] = [];
  for (const part of parts) {
    if (RANK[part.verdict] > RANK[verdict]) verdict = part.verdict;
    if (part.verdict !== 'allow' && part.reason) reasons.push(part.reason);
  }
  return { verdict, reasons };
}

const policy = (p: ApprovalPolicy): Verdict => p;

/** The path lists an edit must fall inside: the agent's own, and the task's (or the handoff's). */
export function scopesFor(ctx: Pick<GuardContext, 'agent' | 'task' | 'handoffScope'>): { label: string; patterns: string[] }[] {
  const scopes: { label: string; patterns: string[] }[] = [];
  if (ctx.agent.allowedPaths.length > 0) scopes.push({ label: `${ctx.agent.name}'s allowed paths`, patterns: ctx.agent.allowedPaths });
  if (ctx.task && ctx.task.scope.length > 0) scopes.push({ label: `the paths of "${ctx.task.title}"`, patterns: ctx.task.scope });
  else if (ctx.handoffScope.length > 0) scopes.push({ label: 'the paths agreed in the handoff', patterns: ctx.handoffScope });
  return scopes;
}

export function checkEdit(ctx: GuardContext, rawPath: string): EditDecision {
  const path = normalizePath(rawPath);
  if (!path) return { verdict: 'deny', reasons: ['the path is outside the project'], path: null, lockKind: 'soft' };
  const lockKind: LockKind = matchesAny(path, ctx.lockRules.exclusivePatterns) ? 'exclusive' : 'soft';
  if (/^\.git(\/|$)/i.test(path)) return { verdict: 'deny', reasons: ['agents do not edit .git'], path, lockKind };

  const parts: { verdict: Verdict; reason: string | null }[] = [];
  for (const lock of ctx.locks) {
    if (lock.holder.id === ctx.selfId || !samePath(lock.path, path)) continue;
    if (lock.kind === 'exclusive' || lockKind === 'exclusive') {
      const why = lock.abandoned ? ' (abandoned; recover it on Locks and GitHub first)' : '';
      parts.push({ verdict: 'deny', reason: `${path} is locked by ${lock.holder.name}${why}` });
    } else {
      parts.push({ verdict: 'ask', reason: `${lock.holder.name} is also editing ${path}` });
    }
  }

  const outside = scopesFor(ctx).filter((scope) => !matchesAny(path, scope.patterns));
  if (outside.length > 0) {
    parts.push({
      verdict: policy(ctx.agent.approvals.editOutsideScope),
      reason: `${path} is outside ${outside.map((s) => s.label).join(' and ')}`,
    });
  } else {
    parts.push({ verdict: policy(ctx.agent.approvals.editInScope), reason: `edits need approval for ${ctx.agent.name}` });
  }
  return { ...combine(parts), path, lockKind };
}

export function checkCommand(ctx: Pick<GuardContext, 'agent'>, command: string): Decision {
  const verdict = policy(ctx.agent.approvals.commands);
  const reason = verdict === 'deny' ? `${ctx.agent.name} may not run commands` : `${ctx.agent.name} asks before running commands`;
  return combine([{ verdict, reason: command.trim() ? reason : 'the command is empty' }]);
}

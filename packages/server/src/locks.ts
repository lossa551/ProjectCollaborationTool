import { randomUUID } from 'node:crypto';
import {
  DEFAULT_LOCK_RULES,
  matchesAny,
  normalizePath,
  samePath,
  type Lock,
  type LockRules,
  type TaskOwner,
} from '@pct/shared';

// File and asset locks. Only the server grants locks, so one is never granted
// twice. Exclusive locks block everyone else; soft locks may overlap and only
// warn. A lock whose holder stops answering becomes abandoned, and anyone can
// then recover it.

export type LockResult =
  | { ok: true; lock: Lock; description: string | null }
  | { ok: false; code: 'locked' | 'not_found' | 'not_allowed' | 'bad_message'; message: string };

export class LockTable {
  private readonly locks = new Map<string, Lock>();
  private rules: LockRules;

  constructor(locks: Lock[] = [], rules: LockRules = DEFAULT_LOCK_RULES) {
    for (const lock of locks) this.locks.set(lock.id, lock);
    this.rules = rules;
  }

  list(): Lock[] {
    return [...this.locks.values()].sort((a, b) => a.acquiredAt - b.acquiredAt);
  }

  getRules(): LockRules {
    return this.rules;
  }

  setRules(rules: LockRules): LockRules {
    const unique = [...new Set(rules.exclusivePatterns.map((p) => p.trim()).filter(Boolean))];
    this.rules = { exclusivePatterns: unique };
    return this.rules;
  }

  /** The kind of lock a path gets under the current rules. */
  kindFor(path: string): Lock['kind'] {
    return matchesAny(path, this.rules.exclusivePatterns) ? 'exclusive' : 'soft';
  }

  acquire(
    rawPath: string,
    holder: TaskOwner,
    options: { taskId?: string | null; exclusive?: boolean } = {},
    now = Date.now(),
  ): LockResult {
    const path = normalizePath(rawPath);
    if (!path) return { ok: false, code: 'bad_message', message: 'Use a path inside the project' };
    const kind = options.exclusive ? 'exclusive' : this.kindFor(path);
    const onPath = this.list().filter((l) => samePath(l.path, path));

    const own = onPath.find((l) => l.holder.id === holder.id);
    const others = onPath.filter((l) => l.holder.id !== holder.id);

    const blocking = others.find((l) => l.kind === 'exclusive') ?? (kind === 'exclusive' ? others[0] : undefined);
    if (blocking) {
      const why = blocking.abandoned ? ' (abandoned, it can be recovered)' : '';
      return {
        ok: false,
        code: 'locked',
        message: `${blocking.path} is locked by ${blocking.holder.name}${why}`,
      };
    }

    if (own) {
      // Taking the same path again can upgrade to exclusive or move it to another task.
      const upgraded: Lock = {
        ...own,
        kind: own.kind === 'exclusive' ? 'exclusive' : kind,
        taskId: options.taskId !== undefined ? options.taskId : own.taskId,
        heartbeatAt: now,
        abandoned: false,
      };
      this.locks.set(own.id, upgraded);
      const description = upgraded.kind !== own.kind ? `locked ${path} (exclusive)` : null;
      return { ok: true, lock: upgraded, description };
    }

    const lock: Lock = {
      id: randomUUID(),
      path,
      kind,
      holder,
      taskId: options.taskId ?? null,
      acquiredAt: now,
      heartbeatAt: now,
      abandoned: false,
    };
    this.locks.set(lock.id, lock);
    const shared = others.length > 0 ? `, also edited by ${others.map((l) => l.holder.name).join(', ')}` : '';
    return { ok: true, lock, description: `locked ${path}${kind === 'exclusive' ? ' (exclusive)' : ''}${shared}` };
  }

  release(lockId: string, holderId: string): LockResult {
    const lock = this.locks.get(lockId);
    if (!lock) return { ok: false, code: 'not_found', message: 'That lock is already gone' };
    if (lock.holder.id !== holderId) {
      return { ok: false, code: 'not_allowed', message: `Only ${lock.holder.name} can release that lock` };
    }
    this.locks.delete(lockId);
    return { ok: true, lock, description: `released ${lock.path}` };
  }

  recover(lockId: string, byId: string): LockResult {
    const lock = this.locks.get(lockId);
    if (!lock) return { ok: false, code: 'not_found', message: 'That lock is already gone' };
    if (lock.holder.id === byId) return this.release(lockId, byId);
    if (!lock.abandoned) {
      return { ok: false, code: 'not_allowed', message: `${lock.holder.name} is still active; ask them to release it` };
    }
    this.locks.delete(lockId);
    return { ok: true, lock, description: `recovered ${lock.path} from ${lock.holder.name}` };
  }

  /** Unlinks locks from a deleted task. Returns the changed locks. */
  detachTask(taskId: string): Lock[] {
    const changed: Lock[] = [];
    for (const lock of this.locks.values()) {
      if (lock.taskId !== taskId) continue;
      const next = { ...lock, taskId: null };
      this.locks.set(lock.id, next);
      changed.push(next);
    }
    return changed;
  }

  /** Heartbeat: every lock the holder has stays fresh while they are connected. */
  refresh(holderId: string, now = Date.now()): Lock[] {
    const revived: Lock[] = [];
    for (const lock of this.locks.values()) {
      if (lock.holder.id !== holderId) continue;
      const next = { ...lock, heartbeatAt: now, abandoned: false };
      this.locks.set(lock.id, next);
      if (lock.abandoned) revived.push(next);
    }
    return revived;
  }

  /** Marks locks whose holder has been silent longer than staleMs. Returns the newly abandoned ones. */
  sweep(staleMs: number, now = Date.now()): Lock[] {
    const abandoned: Lock[] = [];
    for (const lock of this.locks.values()) {
      if (lock.abandoned || now - lock.heartbeatAt < staleMs) continue;
      const next = { ...lock, abandoned: true };
      this.locks.set(lock.id, next);
      abandoned.push(next);
    }
    return abandoned;
  }
}

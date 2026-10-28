import { useEffect, useState, type FormEvent } from 'react';
import { matchesAny, samePath, type Lock, type LockRules, type Participant, type Task } from '@pct/shared';
import { Avatar } from './Avatar';
import { ask } from './Dialog';

/** Locks on the same path held by others: soft locks that overlap. */
export function overlapsFor(lock: Lock, locks: Lock[]): Lock[] {
  return locks.filter((other) => other.id !== lock.id && samePath(other.path, lock.path));
}

/** True when the lock's task limits its paths and this path is not among them. */
export function outsideScope(lock: Lock, tasks: Task[]): boolean {
  const task = tasks.find((t) => t.id === lock.taskId);
  return !!task && task.scope.length > 0 && !matchesAny(lock.path, task.scope);
}

export function LocksScreen({
  locks,
  rules,
  tasks,
  participants,
  youId,
  editable,
  onOpenTask,
  onOpenChat,
}: {
  locks: Lock[];
  rules: LockRules;
  tasks: Task[];
  participants: Participant[];
  youId: string | null;
  editable: boolean;
  onOpenTask: (taskId: string) => void;
  onOpenChat: (chatId: string) => void;
}) {
  const sorted = [...locks].sort((a, b) => Number(b.abandoned) - Number(a.abandoned) || a.path.localeCompare(b.path));
  return (
    <div className="locks-screen">
      <section className="card">
        <h2>Lock a file</h2>
        <LockForm tasks={tasks} rules={rules} editable={editable} />
      </section>

      <section className="card">
        <h2>Locks</h2>
        {sorted.length === 0 ? (
          <p className="muted">Nobody holds a lock right now.</p>
        ) : (
          <LockList
            locks={sorted}
            allLocks={locks}
            tasks={tasks}
            participants={participants}
            youId={youId}
            editable={editable}
            onOpenTask={onOpenTask}
            onOpenChat={onOpenChat}
          />
        )}
      </section>

      <RulesEditor rules={rules} editable={editable} />
    </div>
  );
}

export function LockList({
  locks,
  allLocks,
  tasks,
  participants,
  youId,
  editable,
  onOpenTask,
  onOpenChat,
  compact,
}: {
  locks: Lock[];
  allLocks: Lock[];
  tasks: Task[];
  participants: Participant[];
  youId: string | null;
  editable: boolean;
  onOpenTask?: (taskId: string) => void;
  onOpenChat?: (chatId: string) => void;
  compact?: boolean;
}) {
  return (
    <ul className={`lock-list${compact ? ' compact' : ''}`}>
      {locks.map((lock) => {
        const task = tasks.find((t) => t.id === lock.taskId);
        const online = participants.some((p) => p.id === lock.holder.id);
        const mine = lock.holder.id === youId;
        // People can free a lock an agent holds; the agent takes it again if it edits the file.
        const agents = lock.holder.kind === 'agent' && !lock.abandoned;
        const overlaps = overlapsFor(lock, allLocks);
        return (
          <li key={lock.id} className={lock.abandoned ? 'abandoned' : undefined}>
            <div className="lock-main">
              <code className="lock-path">{lock.path}</code>
              <span className={`badge badge-${lock.kind}`}>{lock.kind === 'exclusive' ? 'Exclusive' : 'Soft'}</span>
              {lock.abandoned && <span className="badge badge-abandoned">Abandoned</span>}
              {outsideScope(lock, tasks) && <span className="badge badge-warn">Outside task scope</span>}
            </div>
            <div className="lock-meta muted">
              <span className="owner">
                <Avatar name={lock.holder.name} kind={lock.holder.kind} status={lock.abandoned || !online ? 'offline' : 'active'} small />
                {mine ? 'You' : lock.holder.name}
              </span>
              {!compact && task && (
                <button className="link" onClick={() => onOpenTask?.(task.id)}>
                  {task.title}
                </button>
              )}
              {lock.reason && lock.reason !== task?.title && <span title="Why it is locked">“{lock.reason}”</span>}
              {lock.chatId && onOpenChat && (
                <button className="link" onClick={() => onOpenChat(lock.chatId!)}>
                  Open chat
                </button>
              )}
              <span>since {new Date(lock.acquiredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              {overlaps.length > 0 && (
                <span className="warning">also {overlaps.map((o) => (o.holder.id === youId ? 'you' : o.holder.name)).join(', ')}</span>
              )}
            </div>
            {editable && mine && (
              <button className="secondary" onClick={() => window.pct.releaseLock(lock.id)}>
                Release
              </button>
            )}
            {editable && !mine && agents && (
              <button
                className="secondary"
                onClick={async () => {
                  if (await ask(`Release ${lock.holder.name}'s lock on ${lock.path}?`, { detail: 'It locks the file again if it edits it.', confirm: 'Release' })) {
                    window.pct.releaseLock(lock.id);
                  }
                }}
              >
                Release
              </button>
            )}
            {editable && !mine && lock.abandoned && (
              <button
                className="danger"
                onClick={async () => {
                  if (await ask(`Recover ${lock.path} from ${lock.holder.name}?`, { detail: 'Their unsaved work on it may be lost.', confirm: 'Recover', danger: true })) {
                    window.pct.recoverLock(lock.id);
                  }
                }}
              >
                Recover
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function LockForm({
  tasks,
  rules,
  editable,
  taskId: fixedTaskId,
}: {
  tasks: Task[];
  rules: LockRules;
  editable: boolean;
  taskId?: string;
}) {
  const [path, setPath] = useState('');
  const [taskId, setTaskId] = useState(fixedTaskId ?? '');
  const [exclusive, setExclusive] = useState(false);
  const [reason, setReason] = useState('');
  const byRule = path.trim() !== '' && matchesAny(path.trim().replace(/\\/g, '/'), rules.exclusivePatterns);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!path.trim()) return;
    window.pct.acquireLock(path.trim(), { taskId: (fixedTaskId ?? taskId) || null, exclusive: exclusive || byRule, reason: reason.trim() || null });
    setPath('');
    setReason('');
    setExclusive(false);
  };

  return (
    <form className="lock-form" onSubmit={submit}>
      <input
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder="Path in the project, e.g. art/hero.png"
        disabled={!editable}
        maxLength={260}
      />
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why (optional)"
        disabled={!editable}
        maxLength={200}
      />
      {fixedTaskId === undefined && (
        <select value={taskId} onChange={(e) => setTaskId(e.target.value)} disabled={!editable}>
          <option value="">No task</option>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      )}
      <label className="check" title={byRule ? 'This file type always needs an exclusive lock' : undefined}>
        <input type="checkbox" checked={exclusive || byRule} disabled={!editable || byRule} onChange={(e) => setExclusive(e.target.checked)} />
        Exclusive
      </label>
      <button type="submit" disabled={!editable || !path.trim()}>
        Lock
      </button>
    </form>
  );
}

function RulesEditor({ rules, editable }: { rules: LockRules; editable: boolean }) {
  const [text, setText] = useState(rules.exclusivePatterns.join('\n'));
  const current = rules.exclusivePatterns.join('\n');
  useEffect(() => setText(current), [current]);

  const patterns = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const changed = patterns.join('\n') !== current;

  return (
    <section className="card">
      <h2>Files that need an exclusive lock</h2>
      <p className="muted">
        One pattern per line. Files that match can only be locked by one person or agent at a time, because they cannot be
        merged. Everything else gets a soft lock, which only warns when someone else is editing the same file.
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} disabled={!editable} spellCheck={false} />
      <div className="row">
        <button disabled={!editable || !changed} onClick={() => window.pct.setLockRules({ exclusivePatterns: patterns })}>
          Save rules
        </button>
        {changed && (
          <button className="secondary" onClick={() => setText(current)}>
            Undo changes
          </button>
        )}
      </div>
    </section>
  );
}

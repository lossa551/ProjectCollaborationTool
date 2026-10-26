import { useEffect, useState, type FormEvent } from 'react';
import {
  STAGE_LABELS,
  TaskStage,
  type Lock,
  type LockRules,
  type Participant,
  type Task,
  type TaskChanges,
} from '@pct/shared';
import { LockForm, LockList } from './Locks';

export function TaskDetail({
  task,
  tasks,
  participants,
  locks,
  lockRules,
  youId,
  editable,
  online,
  onClose,
}: {
  task: Task;
  tasks: Task[];
  participants: Participant[];
  locks: Lock[];
  lockRules: LockRules;
  youId: string | null;
  editable: boolean;
  /** Owners and locks need the server; the rest can change offline. */
  online: boolean;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [scope, setScope] = useState(task.scope.join('\n'));

  // Pick up changes others make while the panel is open.
  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setScope(task.scope.join('\n')), [task.scope]);

  const update = (changes: TaskChanges) => window.pct.updateTask(task.id, changes);

  const saveText = (event?: FormEvent) => {
    event?.preventDefault();
    const scopeList = scope
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const changes: TaskChanges = {};
    if (title.trim() && title.trim() !== task.title) changes.title = title.trim();
    if (scopeList.join('\n') !== task.scope.join('\n')) changes.scope = scopeList;
    if (Object.keys(changes).length > 0) update(changes);
  };

  const taskLocks = locks.filter((l) => l.taskId === task.id);
  const ownerOffline = task.owner && !participants.some((p) => p.id === task.owner!.id);

  return (
    <aside className="side-panel task-detail">
      <header>
        <h2>Task</h2>
        <button className="secondary" onClick={onClose}>
          Close
        </button>
      </header>
      <form onSubmit={saveText}>
        <label className="field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => saveText()} disabled={!editable} maxLength={200} />
        </label>
        <label className="field">
          <span>Stage</span>
          <select value={task.stage} onChange={(e) => update({ stage: e.target.value as TaskStage })} disabled={!editable}>
            {TaskStage.options.map((stage) => (
              <option key={stage} value={stage}>
                {STAGE_LABELS[stage]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Owner</span>
          <select
            value={task.owner?.id ?? ''}
            onChange={(e) => update({ ownerId: e.target.value || null })}
            disabled={!online}
          >
            <option value="">Unassigned</option>
            {ownerOffline && <option value={task.owner!.id}>{task.owner!.name} (offline)</option>}
            {participants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.kind === 'agent' ? ' (agent)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Allowed paths, one per line</span>
          <textarea
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            onBlur={() => saveText()}
            placeholder={'scripts/player/**\nscenes/player.tscn'}
            rows={4}
            disabled={!editable}
          />
        </label>
      </form>
      <section>
        <h3 className="section-title">Locks</h3>
        {taskLocks.length > 0 ? (
          <LockList
            locks={taskLocks}
            allLocks={locks}
            tasks={tasks}
            participants={participants}
            youId={youId}
            editable={online}
            compact
          />
        ) : (
          <p className="muted small">No files locked for this task.</p>
        )}
        <LockForm key={task.id} tasks={tasks} rules={lockRules} editable={online} taskId={task.id} />
      </section>
      <p className="muted small">
        Created {new Date(task.createdAt).toLocaleString()} · changed {task.version - 1} times
      </p>
      {editable && (
        <button
          className="danger"
          onClick={() => {
            if (confirm(`Delete "${task.title}"?`)) {
              window.pct.deleteTask(task.id);
              onClose();
            }
          }}
        >
          Delete task
        </button>
      )}
    </aside>
  );
}

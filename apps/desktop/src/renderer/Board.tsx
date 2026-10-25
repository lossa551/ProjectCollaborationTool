import { useState, type DragEvent, type FormEvent } from 'react';
import { STAGE_LABELS, TaskStage, type Lock, type Participant, type Task } from '@pct/shared';
import { Avatar } from './Avatar';

const STAGES = TaskStage.options;
const DRAG_TYPE = 'application/x-pct-task';

export function Board({
  tasks,
  locks,
  participants,
  editable,
  selectedId,
  onSelect,
}: {
  tasks: Task[];
  locks: Lock[];
  participants: Participant[];
  editable: boolean;
  selectedId: string | null;
  onSelect: (taskId: string) => void;
}) {
  const [dropTarget, setDropTarget] = useState<TaskStage | null>(null);

  const drop = (event: DragEvent, stage: TaskStage) => {
    event.preventDefault();
    setDropTarget(null);
    const taskId = event.dataTransfer.getData(DRAG_TYPE);
    const task = tasks.find((t) => t.id === taskId);
    if (task && task.stage !== stage) window.pct.updateTask(taskId, { stage });
  };

  return (
    <div className="board">
      {STAGES.map((stage) => {
        const column = tasks.filter((t) => t.stage === stage);
        return (
          <section
            key={stage}
            className={`column${dropTarget === stage ? ' drop-target' : ''}`}
            onDragOver={(event) => {
              if (!editable || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
              event.preventDefault();
              setDropTarget(stage);
            }}
            onDragLeave={() => setDropTarget((current) => (current === stage ? null : current))}
            onDrop={(event) => drop(event, stage)}
          >
            <header>
              <h3>{STAGE_LABELS[stage]}</h3>
              <span className="muted">{column.length}</span>
            </header>
            <div className="cards">
              {column.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  locks={locks.filter((l) => l.taskId === task.id)}
                  ownerOnline={!!task.owner && participants.some((p) => p.id === task.owner!.id)}
                  draggable={editable}
                  selected={task.id === selectedId}
                  onSelect={() => onSelect(task.id)}
                />
              ))}
            </div>
            {editable && <AddTask stage={stage} />}
          </section>
        );
      })}
    </div>
  );
}

function TaskCard({
  task,
  locks,
  ownerOnline,
  draggable,
  selected,
  onSelect,
}: {
  task: Task;
  locks: Lock[];
  ownerOnline: boolean;
  draggable: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`task-card${selected ? ' selected' : ''}`}
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, task.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onSelect}
    >
      <span className="task-title">{task.title}</span>
      <span className="task-meta">
        {task.owner ? (
          <span className="owner">
            <Avatar name={task.owner.name} kind={task.owner.kind} status={ownerOnline ? 'active' : 'offline'} small />
            {task.owner.name}
            {!ownerOnline && <span className="muted"> (offline)</span>}
          </span>
        ) : (
          <span className="muted">Unassigned</span>
        )}
        {locks.length > 0 && (
          <span className={locks.some((l) => l.abandoned) ? 'warning' : 'muted'} title={locks.map((l) => l.path).join('\n')}>
            {locks.length} {locks.length === 1 ? 'lock' : 'locks'}
          </span>
        )}
        {task.scope.length > 0 && (
          <span className="muted" title={task.scope.join('\n')}>
            {task.scope.length} {task.scope.length === 1 ? 'path' : 'paths'}
          </span>
        )}
      </span>
    </button>
  );
}

function AddTask({ stage }: { stage: TaskStage }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim()) window.pct.createTask(title.trim(), stage);
    setTitle('');
  };

  if (!open) {
    return (
      <button className="add-task" onClick={() => setOpen(true)}>
        + Add task
      </button>
    );
  }
  return (
    <form className="add-task-form" onSubmit={submit}>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        onBlur={() => !title.trim() && setOpen(false)}
        placeholder="Task title, then Enter"
        maxLength={200}
        autoFocus
      />
    </form>
  );
}

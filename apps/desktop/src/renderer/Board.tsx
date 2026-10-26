import { useState, type DragEvent, type FormEvent } from 'react';
import {
  STAGE_LABELS,
  TaskStage,
  overlapsForTask,
  pullForBranch,
  type ChatInfo,
  type GitHubStatus,
  type Lock,
  type Overlap,
  type Participant,
  type PullRequest,
  type Task,
} from '@pct/shared';
import { Avatar } from './Avatar';
import { PullBadge } from './GitHub';
import { CriteriaSummary } from './Planning';

const STAGES = TaskStage.options;
const DRAG_TYPE = 'application/x-pct-task';

export function Board({
  tasks,
  locks,
  participants,
  github,
  overlaps,
  chats,
  editable,
  selectedId,
  onSelect,
}: {
  tasks: Task[];
  locks: Lock[];
  participants: Participant[];
  github: GitHubStatus;
  overlaps: Overlap[];
  chats: ChatInfo[];
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
                  pull={pullForBranch(github, task.branch)}
                  overlaps={overlapsForTask(overlaps, task)}
                  working={chats.filter((c) => c.taskId === task.id && c.state !== 'idle')}
                  copies={chats.filter((c) => c.taskId === task.id && c.worktree && c.worktree.files.length > 0)}
                  agentName={(chat) => participants.find((p) => p.agent?.profileId === chat.agentId)?.name ?? 'Agent'}
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
  pull,
  overlaps,
  working,
  copies,
  agentName,
  draggable,
  selected,
  onSelect,
}: {
  task: Task;
  locks: Lock[];
  ownerOnline: boolean;
  pull: PullRequest | null;
  overlaps: Overlap[];
  /** Agent chats on this task that are busy right now. */
  working: ChatInfo[];
  /** Agent chats on this task whose own copy has changes. */
  copies: ChatInfo[];
  agentName: (chat: ChatInfo) => string;
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
      {working.map((chat) => (
        <span key={chat.id} className="agent-now small">
          <span className={`dot dot-${chat.state}`} />
          <span>
            {agentName(chat)}: {chat.activity ?? (chat.state === 'waiting' ? 'Waiting' : 'Working')}
          </span>
        </span>
      ))}
      <span className="task-meta">
        <TaskPeople task={task} ownerOnline={ownerOnline} agents={[...new Set(working.map(agentName))]} />
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
        {pull ? <PullBadge pull={pull} link={false} /> : task.branch && <code className="muted small">{task.branch}</code>}
        {copies.map((chat) => (
          <span key={chat.id} className="copy-badge" title={`${chat.worktree!.branch}, not merged yet:\n${chat.worktree!.files.map((f) => f.path).join('\n')}`}>
            {agentName(chat)}: {chat.worktree!.files.length} {chat.worktree!.files.length === 1 ? 'file' : 'files'} to merge
          </span>
        ))}
        <CriteriaSummary task={task} />
        {overlaps.length > 0 && (
          <span className="warning" title={overlaps.map((o) => o.path).join('\n')}>
            {overlaps.length} {overlaps.length === 1 ? 'overlap' : 'overlaps'}
          </span>
        )}
      </span>
    </button>
  );
}

/** Who is accountable and which agent is on it: "Martin · Builder working", not "Unassigned" while an agent works. */
function TaskPeople({ task, ownerOnline, agents }: { task: Task; ownerOnline: boolean; agents: string[] }) {
  const working = agents.length > 0 && <span className="agent-working">{agents.join(', ')} working</span>;
  if (!task.owner) return working ? <span className="owner">{working}</span> : <span className="muted">Unassigned</span>;
  return (
    <span className="owner">
      <Avatar name={task.owner.name} kind={task.owner.kind} status={ownerOnline ? 'active' : 'offline'} small />
      {task.owner.name}
      {!ownerOnline && <span className="muted"> (offline)</span>}
      {working && <span className="muted"> · </span>}
      {working}
    </span>
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

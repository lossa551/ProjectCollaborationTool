import { useEffect, useState, type FormEvent } from 'react';
import {
  STAGE_LABELS,
  TaskStage,
  describeSource,
  filesOutsideScope,
  overlapsForTask,
  pullForBranch,
  type GitHubStatus,
  type Lock,
  type LockRules,
  type Overlap,
  type Participant,
  type Task,
  type TaskChanges,
  type Workspace,
} from '@pct/shared';
import { PullBadge } from './GitHub';
import { LockForm, LockList } from './Locks';

/** A branch name made from the task title, e.g. "task/player-movement-3f2a". */
function suggestedBranch(task: Task): string {
  const slug = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `task/${slug || 'work'}-${task.id.slice(0, 4)}`;
}

export function TaskDetail({
  task,
  tasks,
  participants,
  locks,
  lockRules,
  github,
  overlaps,
  workspaces,
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
  github: GitHubStatus;
  overlaps: Overlap[];
  workspaces: Record<string, Workspace>;
  youId: string | null;
  editable: boolean;
  /** Owners and locks need the server; the rest can change offline. */
  online: boolean;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [scope, setScope] = useState(task.scope.join('\n'));
  const [branch, setBranch] = useState(task.branch ?? '');

  // Pick up changes others make while the panel is open.
  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setScope(task.scope.join('\n')), [task.scope]);
  useEffect(() => setBranch(task.branch ?? ''), [task.branch]);

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
    const branchName = branch.trim() || null;
    if (branchName !== task.branch) changes.branch = branchName;
    if (Object.keys(changes).length > 0) update(changes);
  };

  const taskLocks = locks.filter((l) => l.taskId === task.id);
  const ownerOffline = task.owner && !participants.some((p) => p.id === task.owner!.id);
  const pull = pullForBranch(github, task.branch);
  const taskOverlaps = overlapsForTask(overlaps, task);
  // Files changed for this task outside its paths: in anyone's workspace on its branch, or in its pull request.
  const changedFiles = new Set<string>([
    ...Object.values(workspaces)
      .filter((w) => task.branch && w.branch === task.branch)
      .flatMap((w) => w.files.map((f) => f.path)),
    ...(pull?.state === 'open' ? pull.files : []),
    ...(github.branches.find((b) => b.name === task.branch)?.files ?? []),
  ]);
  const outside = filesOutsideScope([...changedFiles], task.scope);

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
        <label className="field">
          <span>Branch</span>
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            onBlur={() => saveText()}
            placeholder={suggestedBranch(task)}
            list="pct-branches"
            disabled={!editable}
            maxLength={255}
            spellCheck={false}
          />
          <datalist id="pct-branches">
            {github.branches.map((b) => (
              <option key={b.name} value={b.name} />
            ))}
          </datalist>
        </label>
        {editable && !task.branch && (
          <button type="button" className="link small" onClick={() => update({ branch: suggestedBranch(task) })}>
            Use {suggestedBranch(task)}
          </button>
        )}
      </form>
      {task.branch && (
        <section>
          <h3 className="section-title">GitHub</h3>
          {pull ? (
            <div className="gh-detail">
              <PullBadge pull={pull} />
              <span className="small">{pull.title}</span>
              {pull.state === 'open' && pull.checkRuns.length > 0 && (
                <ul className="checks">
                  {pull.checkRuns.map((run) => (
                    <li key={run.name} className={`check-${run.state}`}>
                      {run.url ? (
                        <a href={run.url} target="_blank" rel="noreferrer">
                          {run.name}
                        </a>
                      ) : (
                        run.name
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="muted small">
              {!github.repo
                ? 'Link a GitHub repository under Locks and GitHub to see this branch’s pull request.'
                : github.branches.some((b) => b.name === task.branch)
                  ? 'No pull request for this branch yet.'
                  : 'This branch is not on GitHub yet.'}
            </p>
          )}
          {outside.length > 0 && (
            <p className="warning small" title={outside.join('\n')}>
              {outside.length} changed {outside.length === 1 ? 'file is' : 'files are'} outside the allowed paths: {outside.slice(0, 3).join(', ')}
              {outside.length > 3 ? '…' : ''}
            </p>
          )}
          {taskOverlaps.length > 0 && (
            <ul className="overlap-list small">
              {taskOverlaps.map((o) => (
                <li key={o.path} className="warning">
                  <code>{o.path}</code> is also changed in {o.sources.map((s) => describeSource(s, youId)).join(', ')}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
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

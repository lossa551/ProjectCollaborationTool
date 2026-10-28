import { useEffect, useState, type FormEvent } from 'react';
import {
  STAGE_LABELS,
  TaskStage,
  describeSource,
  filesOutsideScope,
  notesToUpdate,
  overlapsForTask,
  pullForBranch,
  taskChangedFiles,
  type AgentProfile,
  type DuplicateVerdict,
  type ChatInfo,
  type PlanItem,
  type GitHubStatus,
  type Issue,
  type Lock,
  type LockRules,
  type Overlap,
  type Participant,
  type PriceTable,
  type Task,
  type TaskChanges,
  type UsageRow,
  type Workspace,
  totalUsage,
} from '@pct/shared';
import { WorktreeSummary } from './AgentChat';
import { BudgetField, CostShort } from './Cost';
import { CriteriaSection } from './Criteria';
import { PullBadge } from './GitHub';
import { IssueChips } from './Issues';
import { LockForm, LockList } from './Locks';
import { ask } from './Dialog';

/** The folder notes in your project folder, read again when a workspace changes. */
function useNotePaths(workspaces: Record<string, Workspace>): string[] {
  const [paths, setPaths] = useState<string[]>([]);
  const key = JSON.stringify(Object.values(workspaces).map((w) => [w.branch, w.files.length]));
  useEffect(() => {
    let live = true;
    void window.pct.folderNotePaths().then((p) => live && setPaths(p));
    return () => {
      live = false;
    };
  }, [key]);
  return paths;
}

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
  chats,
  agents,
  onOpenChat,
  planning,
  issues,
  youId,
  editable,
  online,
  usage,
  prices,
  duplicateChecking,
  notesAgent,
  onClose,
}: {
  task: Task;
  /** An agent on this PC is answering the duplicate question for this task now. */
  duplicateChecking: boolean;
  /** The folder notes agent, the reviewing agent when the feature names none. */
  notesAgent: string | null;
  /** What agents used, to show the task's cost. */
  usage: UsageRow[];
  prices: PriceTable;
  planning: PlanItem[];
  /** Open GitHub issues linked to the task. */
  issues: Issue[];
  tasks: Task[];
  participants: Participant[];
  locks: Lock[];
  lockRules: LockRules;
  github: GitHubStatus;
  overlaps: Overlap[];
  workspaces: Record<string, Workspace>;
  chats: ChatInfo[];
  agents: AgentProfile[];
  onOpenChat: (chatId: string) => void;
  youId: string | null;
  editable: boolean;
  /** Owners and locks need the server; the rest can change offline. */
  online: boolean;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [scope, setScope] = useState(task.scope.join('\n'));
  const [readFirst, setReadFirst] = useState(task.readFirst.join('\n'));
  const [branch, setBranch] = useState(task.branch ?? '');

  // Pick up changes others make while the panel is open.
  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setScope(task.scope.join('\n')), [task.scope]);
  useEffect(() => setReadFirst(task.readFirst.join('\n')), [task.readFirst]);
  useEffect(() => setBranch(task.branch ?? ''), [task.branch]);

  const update = (changes: TaskChanges) => window.pct.updateTask(task.id, changes);

  const saveText = (event?: FormEvent) => {
    event?.preventDefault();
    const lines = (text: string) =>
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const scopeList = lines(scope);
    const readList = lines(readFirst);
    const changes: TaskChanges = {};
    if (title.trim() && title.trim() !== task.title) changes.title = title.trim();
    if (scopeList.join('\n') !== task.scope.join('\n')) changes.scope = scopeList;
    if (readList.join('\n') !== task.readFirst.join('\n')) changes.readFirst = readList;
    const branchName = branch.trim() || null;
    if (branchName !== task.branch) changes.branch = branchName;
    if (Object.keys(changes).length > 0) update(changes);
  };

  const taskLocks = locks.filter((l) => l.taskId === task.id);
  const ownerOffline = task.owner && !participants.some((p) => p.id === task.owner!.id);
  const pull = pullForBranch(github, task.branch);
  const taskOverlaps = overlapsForTask(overlaps, task);
  const changedFiles = taskChangedFiles(task, workspaces, github, chats);
  const copies = chats.filter((c) => c.taskId === task.id && c.worktree);
  const outside = filesOutsideScope(changedFiles, task.scope);
  const notePaths = useNotePaths(workspaces);
  const staleNotes = notesToUpdate(changedFiles, notePaths);
  const [noteTaskError, setNoteTaskError] = useState<string | null>(null);
  const noteTask = async (note: string) => {
    const result = await window.pct.folderNoteTask(note.includes('/') ? note.slice(0, note.lastIndexOf('/')) : '');
    setNoteTaskError(result.ok ? null : result.error);
  };
  const feature = task.featureId ? planning.find((i) => i.id === task.featureId) : undefined;

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
          <span>Files to read first, one per line</span>
          <textarea
            value={readFirst}
            onChange={(e) => setReadFirst(e.target.value)}
            onBlur={() => saveText()}
            placeholder={'scripts/player/AGENTS.md\nscripts/player/movement.gd'}
            rows={2}
            disabled={!editable}
            spellCheck={false}
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
      {feature && <p className="small">Part of the feature “{feature.title}” in the planning space.</p>}
      {issues.length > 0 && (
        <p className="small">
          GitHub issues: <IssueChips issues={issues} />
        </p>
      )}
      <CriteriaSection task={task} editable={editable} />
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
          {staleNotes.length > 0 && (
            <ul className="overlap-list small">
              {staleNotes.map(({ note, files }) => (
                <li key={note} className="warning" title={files.join('\n')}>
                  Folder note <code>{note}</code> may need updating: {files.length} {files.length === 1 ? 'file' : 'files'} it covers changed and
                  the note did not.{' '}
                  {online && (
                    <button className="link" onClick={() => void noteTask(note)}>
                      Make a task
                    </button>
                  )}
                </li>
              ))}
              {noteTaskError && <li className="error">{noteTaskError}</li>}
            </ul>
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
      {copies.length > 0 && (
        <section>
          <h3 className="section-title">Agents’ copies</h3>
          <ul className="copy-list small">
            {copies.map((chat) => (
              <li key={chat.id}>
                <WorktreeSummary chat={chat} agentName={agents.find((a) => a.id === chat.agentId)?.name ?? 'Agent'} youId={youId} />
                <button className="link" onClick={() => onOpenChat(chat.id)}>
                  Open chat
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <DuplicateFlag task={task} feature={feature} agents={agents} notesAgent={notesAgent} checking={duplicateChecking} online={online} />
      <TaskCost task={task} chats={chats} agents={agents} usage={usage} prices={prices} editable={editable} onOpenChat={onOpenChat} />
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
        Created {new Date(task.createdAt).toLocaleString()}
        {task.version > 1 && ` · changed ${task.version - 1} ${task.version === 2 ? 'time' : 'times'}`}
      </p>
      {editable && (
        <button
          className="danger"
          onClick={async () => {
            if (await ask(`Delete "${task.title}"?`, { confirm: 'Delete task', danger: true })) {
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

const VERDICT_TEXT: Record<DuplicateVerdict, string> = {
  duplicate: 'may add something that already exists',
  clear: 'adds nothing the folder notes say already exists',
  unsure: 'could not tell',
};

/**
 * The review-time duplicate question (issue #93): asked by itself when the
 * task moves to review with a reviewing agent, or from here at any time.
 */
function DuplicateFlag({
  task,
  feature,
  agents,
  notesAgent,
  checking,
  online,
}: {
  task: Task;
  feature: PlanItem | undefined;
  agents: AgentProfile[];
  notesAgent: string | null;
  checking: boolean;
  online: boolean;
}) {
  const pick = feature?.assign.review;
  const reviewer = pick?.kind === 'agent' && agents.some((a) => a.id === pick.id) ? pick.id : agents.some((a) => a.id === notesAgent) ? notesAgent : null;
  const [agentId, setAgentId] = useState<string>(reviewer ?? agents[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!agents.some((a) => a.id === agentId)) setAgentId(reviewer ?? agents[0]?.id ?? '');
  }, [agents, agentId, reviewer]);
  const check = task.duplicateCheck;
  // Before review there is usually nothing to look at yet.
  if (!check && !checking && (task.stage === 'planning' || task.stage === 'implementing')) return null;
  const run = async () => {
    setError(null);
    const result = await window.pct.askDuplicateCheck(task.id, agentId || null);
    if (!result.ok) setError(result.error);
  };
  return (
    <section>
      <h3 className="section-title">Duplicate check</h3>
      {checking ? (
        <p className="muted small">An agent is reading the change and the folder notes…</p>
      ) : check ? (
        <div className={check.verdict === 'duplicate' ? 'warning small' : 'small'}>
          <p>
            {check.by} says this change {VERDICT_TEXT[check.verdict]}
            <span className="muted">
              {' '}
              · {check.files} {check.files === 1 ? 'file' : 'files'} ·{' '}
              {new Date(check.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
            </span>
          </p>
          {check.answer && <p className="duplicate-answer">{check.answer}</p>}
        </div>
      ) : (
        <p className="muted small">
          {reviewer
            ? 'Not asked yet. The reviewing agent is asked by itself when the task moves to review on this PC.'
            : 'Ask an agent whether this change adds a system, helper or asset the folder notes say already exists.'}
        </p>
      )}
      {online && agents.length > 0 && !checking && (
        <div className="row small">
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Agent to ask">
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button className="secondary" onClick={() => void run()} disabled={!agentId}>
            {check ? 'Ask again' : 'Ask'}
          </button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

/** What the task's agent chats used and cost, per chat, and the task's budget. */
function TaskCost({
  task,
  chats,
  agents,
  usage,
  prices,
  editable,
  onOpenChat,
}: {
  task: Task;
  chats: ChatInfo[];
  agents: AgentProfile[];
  usage: UsageRow[];
  prices: PriceTable;
  editable: boolean;
  onOpenChat: (chatId: string) => void;
}) {
  const rows = usage.filter((r) => r.taskId === task.id);
  const total = totalUsage(rows, prices);
  // Chats that used something for the task, even if they moved on to another task or were deleted since.
  const chatIds = [...new Set(rows.map((r) => r.chatId))];
  return (
    <section>
      <h3 className="section-title">Agent cost</h3>
      {total.calls === 0 ? (
        <p className="muted small">No agent has worked on this task yet.</p>
      ) : (
        <ul className="cost-list small">
          {chatIds.map((id) => {
            const chat = chats.find((c) => c.id === id);
            const agent = agents.find((a) => a.id === (chat?.agentId ?? rows.find((r) => r.chatId === id)?.agentId));
            return (
              <li key={id}>
                <span className="grow">
                  {chat ? (
                    <button className="link" onClick={() => onOpenChat(chat.id)}>
                      {chat.title}
                    </button>
                  ) : (
                    <span className="muted">Deleted chat</span>
                  )}
                  {agent && <span className="muted"> · {agent.name}</span>}
                </span>
                <CostShort total={totalUsage(rows.filter((r) => r.chatId === id), prices)} />
              </li>
            );
          })}
          <li className="cost-total">
            <span className="grow">All chats</span>
            <CostShort total={total} />
          </li>
        </ul>
      )}
      <BudgetField budget={task.budget} spent={total.cost} disabled={!editable} onChange={(budget) => window.pct.updateTask(task.id, { budget })} />
    </section>
  );
}

import { useState, type FormEvent } from 'react';
import {
  describeSource,
  filesOutsideScope,
  pullForBranch,
  type GitHubStatus,
  type Overlap,
  type Participant,
  type PullRequest,
  type Task,
  type Workspace,
} from '@pct/shared';
import type { AppState, LocalWorkspace } from '../common/api';

export const taskForBranch = (tasks: Task[], branch: string | null) => (branch ? tasks.find((t) => t.branch === branch) : undefined);

/** Short state of a pull request, e.g. "checks failing" or "merged". */
export function PullBadge({ pull, link = true }: { pull: PullRequest; link?: boolean }) {
  const problems: string[] = [];
  if (pull.state === 'open') {
    if (pull.mergeable === 'conflicting') problems.push('conflicts');
    if (pull.checks === 'failure') problems.push('checks failing');
    if (pull.review === 'changes_requested') problems.push('changes requested');
  }
  const label =
    pull.state === 'merged'
      ? 'merged'
      : pull.state === 'closed'
        ? 'closed'
        : problems.length > 0
          ? problems.join(', ')
          : pull.checks === 'pending'
            ? 'checks running'
            : pull.review === 'approved'
              ? 'approved'
              : pull.draft
                ? 'draft'
                : 'open';
  const tone = pull.state !== 'open' ? pull.state : problems.length > 0 ? 'bad' : pull.checks === 'pending' ? 'pending' : 'good';
  if (!link) {
    return (
      <span className={`pull-badge pull-${tone}`} title={pull.title}>
        #{pull.number} {label}
      </span>
    );
  }
  return (
    <a className={`pull-badge pull-${tone}`} href={pull.url} target="_blank" rel="noreferrer" title={pull.title} onClick={(e) => e.stopPropagation()}>
      #{pull.number} {label}
    </a>
  );
}

export function GitHubScreen({
  state,
  participants,
  overlaps,
  onOpenTask,
}: {
  state: AppState;
  participants: Participant[];
  overlaps: Overlap[];
  onOpenTask: (taskId: string) => void;
}) {
  const { session } = state;
  const github = session.github;
  const online = session.status === 'connected';
  const youId = session.you?.id ?? null;
  const open = github.pulls.filter((p) => p.state === 'open');
  const recent = github.pulls.filter((p) => p.state !== 'open').slice(0, 5);
  const linkedBranches = github.branches.filter((b) => taskForBranch(session.tasks, b.name));

  return (
    <div className="locks-screen">
      <RepoCard state={state} />

      {github.repo && (
        <section className="card">
          <h2>Pull requests</h2>
          {open.length === 0 ? (
            <p className="muted">No open pull requests.</p>
          ) : (
            <ul className="gh-list">
              {open.map((pull) => (
                <PullRow key={pull.number} pull={pull} task={taskForBranch(session.tasks, pull.branch)} onOpenTask={onOpenTask} />
              ))}
            </ul>
          )}
          {recent.length > 0 && (
            <>
              <h3 className="section-title gh-subtitle">Recently closed</h3>
              <ul className="gh-list">
                {recent.map((pull) => (
                  <PullRow key={pull.number} pull={pull} task={taskForBranch(session.tasks, pull.branch)} onOpenTask={onOpenTask} />
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section className="card">
        <h2>Who is changing what</h2>
        <p className="muted small">Each person's local branch and changed files, from the project folder they picked in the app.</p>
        <ul className="gh-list">
          {participants.map((p) => (
            <WorkspaceRow key={p.id} participant={p} workspace={session.workspaces[p.id]} tasks={session.tasks} you={p.id === youId} onOpenTask={onOpenTask} />
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Overlaps</h2>
        {overlaps.length === 0 ? (
          <p className="muted">Nobody else is changing the same files.</p>
        ) : (
          <ul className="gh-list">
            {overlaps.map((overlap) => (
              <li key={overlap.path}>
                <code className="lock-path">{overlap.path}</code>
                <span className="warning small">{overlap.sources.map((s) => describeSource(s, youId)).join(', ')}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">Overlaps between different files that depend on each other (say, a scene and its script) come with the engine integrations.</p>
      </section>

      {linkedBranches.length > 0 && (
        <section className="card">
          <h2>Branches of tasks</h2>
          <ul className="gh-list">
            {linkedBranches.map((branch) => {
              const task = taskForBranch(session.tasks, branch.name)!;
              return (
                <li key={branch.name}>
                  <code>{branch.name}</code>
                  <button className="link" onClick={() => onOpenTask(task.id)}>
                    {task.title}
                  </button>
                  <span className="muted small">
                    {branch.ahead === null ? '' : `${branch.ahead} ahead, ${branch.behind} behind ${github.defaultBranch ?? 'main'}`}
                  </span>
                  {pullForBranch(github, branch.name) && <PullBadge pull={pullForBranch(github, branch.name)!} />}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {!online && <p className="muted small">Offline: this is what GitHub looked like when you were last connected.</p>}
    </div>
  );
}

function RepoCard({ state }: { state: AppState }) {
  const github = state.session.github;
  const online = state.session.status === 'connected';
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const suggestion = state.workspace?.remote;

  const link = async (repo: string | null) => {
    const result = await window.pct.linkRepo(repo);
    setError(result.ok ? null : result.error);
    if (result.ok) setInput('');
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (input.trim()) void link(input.trim());
  };

  return (
    <section className="card">
      <h2>GitHub</h2>
      {github.repo ? (
        <>
          <p>
            Linked to{' '}
            <a href={`https://github.com/${github.repo.owner}/${github.repo.name}`} target="_blank" rel="noreferrer">
              {github.repo.owner}/{github.repo.name}
            </a>
            <GitHubStatusLine github={github} />
          </p>
          {github.error && <p className="warning">{github.error}</p>}
          <button className="secondary" disabled={!online} onClick={() => confirm('Unlink the GitHub repository for everyone?') && void link(null)}>
            Unlink
          </button>
        </>
      ) : (
        <>
          <p className="muted">Link the project's repository to see branches, pull requests, checks and conflicts here and on the task cards.</p>
          <form className="lock-form" onSubmit={submit}>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="owner/name or the GitHub address" disabled={!online} />
            <button type="submit" disabled={!online || !input.trim()}>
              Link
            </button>
            {suggestion && (
              <button type="button" className="secondary" disabled={!online} onClick={() => void link(`${suggestion.owner}/${suggestion.name}`)}>
                Link {suggestion.owner}/{suggestion.name}
              </button>
            )}
          </form>
        </>
      )}
      {error && <p className="error">{error}</p>}
      {state.githubToken !== null && <TokenForm source={state.githubToken} />}
      {state.githubToken === null && github.repo && !github.authenticated && (
        <p className="muted small">The host has no GitHub token, so this updates every 10 minutes and only works for public repositories.</p>
      )}
    </section>
  );
}

function GitHubStatusLine({ github }: { github: GitHubStatus }) {
  if (!github.fetchedAt) return <span className="muted"> · loading…</span>;
  const time = new Date(github.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return <span className="muted"> · last change seen {time}{github.authenticated ? '' : ' · no token, updates every 10 minutes'}</span>;
}

/** Host only: the token the session server uses. It stays on this PC. */
function TokenForm({ source }: { source: 'saved' | 'cli' | 'none' }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async (value: string | null) => {
    const result = await window.pct.setGitHubToken(value);
    setError(result.ok ? null : result.error);
    if (result.ok) setToken('');
  };
  return (
    <div className="token-form">
      <h3 className="section-title">GitHub token (host)</h3>
      <p className="muted small">
        {source === 'saved'
          ? 'Using the token saved in this app.'
          : source === 'cli'
            ? 'Using the token of the GitHub CLI you are signed in to.'
            : 'No token yet. Without one, status updates every 10 minutes and private repositories are not visible.'}{' '}
        Make a fine-grained token with read access to contents, pull requests and commit statuses. It is stored encrypted on this PC and never
        sent to anyone else.
      </p>
      <form
        className="lock-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) void save(token.trim());
        }}
      >
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" autoComplete="off" />
        <button type="submit" disabled={!token.trim()}>
          Save token
        </button>
        {source === 'saved' && (
          <button type="button" className="secondary" onClick={() => void save(null)}>
            Remove
          </button>
        )}
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function PullRow({ pull, task, onOpenTask }: { pull: PullRequest; task: Task | undefined; onOpenTask: (taskId: string) => void }) {
  const failing = pull.checkRuns.filter((r) => r.state === 'failure');
  return (
    <li>
      <PullBadge pull={pull} />
      <span className="grow">
        {pull.title} <span className="muted small">· {pull.author} · {pull.branch}</span>
      </span>
      {task ? (
        <button className="link" onClick={() => onOpenTask(task.id)}>
          {task.title}
        </button>
      ) : (
        pull.state === 'open' && <span className="muted small">no task</span>
      )}
      {failing.length > 0 && (
        <span className="warning small gh-wide">
          Failing:{' '}
          {failing.map((run, i) => (
            <span key={run.name}>
              {i > 0 && ', '}
              {run.url ? (
                <a href={run.url} target="_blank" rel="noreferrer">
                  {run.name}
                </a>
              ) : (
                run.name
              )}
            </span>
          ))}
        </span>
      )}
    </li>
  );
}

function WorkspaceRow({
  participant,
  workspace,
  tasks,
  you,
  onOpenTask,
}: {
  participant: Participant;
  workspace: Workspace | undefined;
  tasks: Task[];
  you: boolean;
  onOpenTask: (taskId: string) => void;
}) {
  const name = you ? 'You' : participant.name;
  if (!workspace) {
    return (
      <li>
        <strong>{name}</strong>
        <span className="muted small grow">{you ? 'Pick your project folder in the sidebar to share your changes.' : 'Not sharing a workspace.'}</span>
      </li>
    );
  }
  const task = taskForBranch(tasks, workspace.branch);
  const outside = task ? filesOutsideScope(workspace.files.map((f) => f.path), task.scope) : [];
  return (
    <li>
      <strong>{name}</strong>
      <code>{workspace.branch ?? 'detached'}</code>
      <span className="muted small grow" title={workspace.files.map((f) => `${f.change}: ${f.path}`).join('\n')}>
        {workspace.files.length}
        {workspace.truncated ? '+' : ''} {workspace.files.length === 1 ? 'file' : 'files'} changed
      </span>
      {task && (
        <button className="link" onClick={() => onOpenTask(task.id)}>
          {task.title}
        </button>
      )}
      {outside.length > 0 && (
        <span className="badge badge-warn" title={outside.join('\n')}>
          {outside.length} outside scope
        </span>
      )}
    </li>
  );
}

/** Bottom of the sidebar: your own workspace at a glance. */
export function WorkspaceCard({ local, tasks, onOpenTask }: { local: LocalWorkspace | null; tasks: Task[]; onOpenTask: (taskId: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const choose = async () => {
    const result = await window.pct.chooseWorkspace();
    setError(result.ok ? null : result.error);
  };

  if (!local) {
    return (
      <div className="workspace-card">
        <span className="muted small">Your workspace</span>
        <button className="secondary" onClick={() => void choose()}>
          Choose project folder
        </button>
        {error && <span className="error small">{error}</span>}
      </div>
    );
  }
  const workspace = local.workspace;
  const task = taskForBranch(tasks, workspace?.branch ?? null);
  const outside = task && workspace ? filesOutsideScope(workspace.files.map((f) => f.path), task.scope) : [];
  return (
    <div className="workspace-card" title={local.folder}>
      <span className="muted small">Your workspace</span>
      {local.error ? (
        <span className="warning small">{local.error}</span>
      ) : workspace ? (
        <>
          <code className="small">{workspace.branch ?? 'detached HEAD'}</code>
          <span className="small">
            {workspace.files.length}
            {workspace.truncated ? '+' : ''} {workspace.files.length === 1 ? 'file' : 'files'} changed
          </span>
          {task ? (
            <>
              <button className="link small" onClick={() => onOpenTask(task.id)}>
                {task.title}
              </button>
              <span className={`small ${outside.length > 0 ? 'warning' : 'good'}`} title={outside.join('\n')}>
                {task.scope.length === 0
                  ? 'Task has no path limits'
                  : outside.length > 0
                    ? `${outside.length} outside the task's paths`
                    : "All inside the task's paths"}
              </span>
            </>
          ) : (
            <span className="muted small">No task on this branch</span>
          )}
        </>
      ) : (
        <span className="muted small">Reading…</span>
      )}
      <button className="link small" onClick={() => void choose()}>
        Change folder
      </button>
      <button className="link small" onClick={() => window.pct.stopWorkspace()}>
        Stop sharing
      </button>
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

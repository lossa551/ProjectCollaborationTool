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
import type { AppState, GitAction, LocalWorkspace } from '../common/api';

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
      <GitCard state={state} />

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

/** Your own checkout: clone, pull, commit, push and branches, using the git on this PC. */
function GitCard({ state }: { state: AppState }) {
  const local = state.workspace;
  const repo = state.session.github.repo;
  const defaultBranch = state.session.github.defaultBranch ?? 'main';
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [message, setMessage] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [fromLatest, setFromLatest] = useState(true);

  const act = async (label: string, run: () => Promise<{ ok: true; value?: string } | { ok: false; error: string }>) => {
    setBusy(label);
    setResult(null);
    try {
      const outcome = await run();
      setResult(outcome.ok ? (outcome.value ? { ok: true, text: outcome.value } : null) : { ok: false, text: outcome.error });
      return outcome.ok;
    } finally {
      setBusy(null);
    }
  };
  const git = (label: string, action: GitAction) => act(label, () => window.pct.gitAction(action));
  const cloneLabel = repo ? `Clone ${repo.owner}/${repo.name}` : null;
  const folderButtons = (
    <div className="lock-form">
      {cloneLabel && (
        <button disabled={busy !== null} onClick={() => void act('Cloning', () => window.pct.cloneRepo())}>
          {cloneLabel}…
        </button>
      )}
      <button className="secondary" disabled={busy !== null} onClick={() => void act('Opening', () => window.pct.chooseWorkspace())}>
        {local ? 'Choose another folder' : 'Use a folder I already cloned'}
      </button>
    </div>
  );
  const footer = (
    <>
      {busy && <p className="muted small">{busy === 'Cloning' ? 'Cloning… big projects can take a while.' : `${busy}…`}</p>}
      {result && <p className={result.ok ? 'good small' : 'error small'}>{result.text}</p>}
    </>
  );

  if (!local || local.error || !local.git || !local.workspace) {
    return (
      <section className="card">
        <h2>Your copy</h2>
        {!local ? (
          <p className="muted">
            Pick the folder where your copy of the project lives
            {repo ? `, or let the app clone ${repo.owner}/${repo.name} from GitHub for you` : '. Link the repository above and the app can clone it for you'}.
          </p>
        ) : local.error ? (
          <p className="warning">
            {local.error} <span className="muted small">({local.folder})</span>
          </p>
        ) : (
          <p className="muted">Reading {local.folder}…</p>
        )}
        {folderButtons}
        {footer}
      </section>
    );
  }

  const info = local.git;
  const branch = local.workspace.branch;
  const mismatch = repo && local.remote && (local.remote.owner !== repo.owner || local.remote.name !== repo.name);
  const changed = info.uncommitted;
  const disabled = busy !== null;

  return (
    <section className="card">
      <h2>Your copy</h2>
      <p className="small">
        <code>{local.folder}</code>
        {' · '}
        {branch ? <code>{branch}</code> : <span className="warning">no branch checked out</span>}
        {' · '}
        <span className="muted">
          {info.upstream
            ? info.ahead === 0 && info.behind === 0
              ? `up to date with ${info.upstream}`
              : [info.ahead > 0 && `${info.ahead} to push`, info.behind > 0 && `${info.behind} to pull`].filter(Boolean).join(', ')
            : 'not on GitHub yet'}
        </span>
      </p>
      {mismatch && (
        <p className="warning small">
          This folder is a clone of {local.remote!.owner}/{local.remote!.name}, not the linked {repo.owner}/{repo.name}.
        </p>
      )}
      {info.conflicted.length > 0 || info.merging ? (
        <div className="git-merge">
          <p className="warning small">
            {info.conflicted.length > 0
              ? `Merge in progress with conflicts in ${info.conflicted.length} ${info.conflicted.length === 1 ? 'file' : 'files'}. Fix them in your editor, then commit. Or abort to undo the pull.`
              : 'Merge in progress: conflicts are fixed. Commit to finish it.'}
          </p>
          {info.conflicted.length > 0 && (
            <ul className="git-files">
              {info.conflicted.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          )}
          <button className="secondary" disabled={disabled} onClick={() => confirm('Abort the merge and undo the pull?') && void git('Aborting', { type: 'abort-merge' })}>
            Abort merge
          </button>
        </div>
      ) : null}

      <div className="lock-form">
        <button disabled={disabled || !branch} onClick={() => void git('Pulling', { type: 'pull' })}>
          Pull{info.behind > 0 ? ` (${info.behind})` : ''}
        </button>
        <button disabled={disabled || !branch} onClick={() => void git('Pushing', { type: 'push' })}>
          Push{info.ahead > 0 ? ` (${info.ahead})` : !info.upstream ? ' branch' : ''}
        </button>
        <button className="secondary" disabled={disabled} onClick={() => void git('Checking GitHub', { type: 'fetch' })}>
          Check for changes
        </button>
      </div>

      <h3 className="section-title gh-subtitle">Commit</h3>
      {changed.length === 0 ? (
        <p className="muted small">No uncommitted changes.</p>
      ) : (
        <details className="git-changes">
          <summary className="small">
            {changed.length} uncommitted {changed.length === 1 ? 'change' : 'changes'}
          </summary>
          <ul className="git-files">
            {changed.slice(0, 200).map((file) => (
              <li key={file.path}>
                <span className="muted small">{file.change}</span> <code>{file.path}</code>
              </li>
            ))}
            {changed.length > 200 && <li className="muted small">and {changed.length - 200} more</li>}
          </ul>
        </details>
      )}
      <form
        className="lock-form"
        onSubmit={(e) => {
          e.preventDefault();
          void git('Committing', { type: 'commit', message }).then((ok) => ok && setMessage(''));
        }}
      >
        <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What did you change?" disabled={disabled} />
        <button type="submit" disabled={disabled || !message.trim() || (changed.length === 0 && !info.merging)}>
          Commit all
        </button>
      </form>

      <h3 className="section-title gh-subtitle">Branch</h3>
      <div className="lock-form">
        <select
          value={branch ?? ''}
          disabled={disabled}
          onChange={(e) => e.target.value && e.target.value !== branch && void git('Switching', { type: 'switch', branch: e.target.value })}
        >
          {!branch && <option value="">(no branch)</option>}
          <optgroup label="On this PC">
            {info.branches.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </optgroup>
          {info.remoteBranches.length > 0 && (
            <optgroup label="Only on GitHub">
              {info.remoteBranches.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      <form
        className="lock-form"
        onSubmit={(e) => {
          e.preventDefault();
          void git('Creating branch', { type: 'create-branch', branch: newBranch.trim(), from: fromLatest ? defaultBranch : null }).then(
            (ok) => ok && setNewBranch(''),
          );
        }}
      >
        <input value={newBranch} onChange={(e) => setNewBranch(e.target.value)} placeholder="New branch, e.g. task/double-jump" disabled={disabled} />
        <select value={fromLatest ? 'latest' : 'current'} onChange={(e) => setFromLatest(e.target.value === 'latest')} disabled={disabled}>
          <option value="latest">from the latest {defaultBranch}</option>
          <option value="current">from {branch ?? 'here'}</option>
        </select>
        <button type="submit" disabled={disabled || !newBranch.trim()}>
          Create and switch
        </button>
      </form>
      {footer}
      <details className="git-more">
        <summary className="muted small">Folder</summary>
        {folderButtons}
      </details>
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
        Make a fine-grained token with read access to pull requests and commit statuses, and read and write access to contents if you want to
        push from the app. It is stored encrypted on this PC and never sent to anyone else.
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
        <span className="muted small">No copy yet? Clone it from the GitHub page.</span>
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

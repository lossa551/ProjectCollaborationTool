import { useEffect, useState, type FormEvent } from 'react';
import {
  describeConnection,
  describeSource,
  filesOutsideScope,
  locksAfterCommit,
  pullForBranch,
  type AgentProfile,
  type GitHubStatus,
  type Overlap,
  type Participant,
  type PullRequest,
  type Task,
  type Workspace,
} from '@pct/shared';
import type { AppState, GitAction, LocalWorkspace } from '../common/api';
import { keyProblem, runnerOf } from './Agents';
import { useKept } from './kept';
import { recall, remember } from './storage';
import { ask } from './Dialog';

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
  onOpenTask,
}: {
  state: AppState;
  participants: Participant[];
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

/** Files that more than one person, branch, pull request or lock is changing. */
export function OverlapsScreen({ overlaps, youId }: { overlaps: Overlap[]; youId: string | null }) {
  return (
    <div className="locks-screen">
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
          <button className="secondary" disabled={!online} onClick={async () => (await ask('Unlink the GitHub repository for everyone?', { confirm: 'Unlink' })) && void link(null)}>
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

/** The agent picked to draft commit messages, remembered on this PC; else one meant for it, else the first that can run here. */
function draftAgentFor(usable: AgentProfile[]): AgentProfile | undefined {
  const saved = recall('commitAgent');
  return (
    usable.find((a) => a.id === saved) ??
    usable.find((a) => /commit/i.test(a.name) || /commit message/i.test(a.responsibilities)) ??
    usable[0]
  );
}

/** Why this agent cannot draft from this PC, if it cannot. */
export function draftProblem(agent: AgentProfile, state: AppState): string | null {
  const runner = runnerOf(agent, state.session.participants);
  if (runner && !state.localAgents[agent.id]) return `runs on ${runner.agent?.startedBy ?? 'another'} PC`;
  return keyProblem(agent.connection, state) ? 'cannot run on this PC' : null;
}

/**
 * "Draft it": an agent reads your uncommitted changes and the branch's task
 * and fills in the message box. You edit it and commit it yourself.
 */
function DraftButton({
  state,
  disabled,
  drafting,
  hasMessage,
  onStart,
}: {
  state: AppState;
  disabled: boolean;
  drafting: string | null;
  hasMessage: boolean;
  onStart: () => void;
}) {
  const agents = state.session.agents;
  const usable = agents.filter((a) => draftProblem(a, state) === null);
  const [picked, setPicked] = useState<string | null>(null);
  const agent = usable.find((a) => a.id === picked) ?? draftAgentFor(usable);
  if (drafting) {
    return (
      <button type="button" className="secondary" onClick={() => window.pct.cancelCommitDraft()}>
        Stop drafting
      </button>
    );
  }
  if (!agent) {
    return (
      <span className="muted small" title="Add an agent in Settings, Agents, that can run on this PC">
        {agents.length === 0 ? 'Add an agent to draft messages for you.' : 'None of the agents can run on this PC to draft a message.'}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className="secondary"
        disabled={disabled}
        title="An agent reads your uncommitted changes and the branch's task and writes a message for you to edit"
        onClick={async () => {
          if (hasMessage && !(await ask('Replace your message with a draft?', { confirm: 'Replace' }))) return;
          onStart();
          // The outcome arrives in the app state (commitDraft), also when you left this page meanwhile.
          void window.pct.draftCommitMessage(agent.id);
        }}
      >
        Draft it
      </button>
      <label className="small muted">
        with{' '}
        <select
          value={agent.id}
          disabled={disabled}
          onChange={(e) => {
            setPicked(e.target.value);
            remember('commitAgent', e.target.value);
          }}
        >
          {agents.map((a) => {
            const problem = draftProblem(a, state);
            return (
              <option key={a.id} value={a.id} disabled={problem !== null}>
                {a.name} ({problem ?? describeConnection(a.connection)})
              </option>
            );
          })}
        </select>
      </label>
    </>
  );
}

/** Your own checkout: clone, pull, commit, push and branches, using the git on this PC. */
function GitCard({ state }: { state: AppState }) {
  const local = state.workspace;
  const repo = state.session.github.repo;
  const defaultBranch = state.session.github.defaultBranch ?? 'main';
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  // Kept while you visit other screens (issue #62), as is the last draft's outcome.
  const [message, setMessage] = useKept('commit.message', '');
  const [drafted, setDrafted] = useKept<{ ok: boolean; text: string } | null>('commit.drafted', null);
  // The last draft already put in the message box, so it is put there once.
  const [seenDraft, setSeenDraft] = useKept('commit.seenDraft', 0);
  const draft = state.commitDraft;
  // Name of the agent drafting the message now.
  const drafting = draft?.status === 'drafting' ? draft.agent : null;
  useEffect(() => {
    if (!draft || draft.status === 'drafting' || draft.id === seenDraft) return;
    setSeenDraft(draft.id);
    if (draft.status === 'done') {
      setMessage(draft.message);
      setDrafted({ ok: true, text: `Drafted by ${draft.agent}. Read it and change what is wrong; nothing is committed until you press Commit all.` });
    } else setDrafted({ ok: false, text: draft.error });
  }, [draft, seenDraft, setSeenDraft, setMessage, setDrafted]);
  const [newBranch, setNewBranch] = useState('');
  const [fromLatest, setFromLatest] = useState(true);
  // After a commit: offer to free the locks you held then on files with nothing left to commit.
  const [committedAt, setCommittedAt] = useState<number | null>(null);

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
  const youId = state.session.you?.id ?? null;
  const heldLocks = youId ? state.session.locks.filter((l) => l.holder.id === youId) : [];
  const freeable =
    committedAt === null
      ? []
      : locksAfterCommit(state.session, youId, [], changed.map((f) => f.path)).yours.filter((l) => l.acquiredAt <= committedAt);

  return (
    <section className="card">
      <h2>Your copy</h2>
      <p className="small">
        <code>{local.folder}</code>
        {' · '}
        {branch ? <code>{branch}</code> : <span className="warning">no branch checked out</span>}
        {' · '}
        <span className="muted">
          {!info.hasCommits
            ? 'no commits yet'
            : info.upstream
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
          <button className="secondary" disabled={disabled} onClick={async () => (await ask('Abort the merge and undo the pull?', { confirm: 'Abort merge', danger: true })) && void git('Aborting', { type: 'abort-merge' })}>
            Abort merge
          </button>
        </div>
      ) : null}

      <div className="lock-form">
        <button disabled={disabled || !branch || !info.hasCommits} onClick={() => void git('Pulling', { type: 'pull' })}>
          Pull{info.behind > 0 ? ` (${info.behind})` : ''}
        </button>
        <button disabled={disabled || !branch || !info.hasCommits} title={info.hasCommits ? undefined : 'Commit first: there is nothing to push yet'} onClick={() => void git('Pushing', { type: 'push' })}>
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
        className="commit-form"
        onSubmit={(e) => {
          e.preventDefault();
          setCommittedAt(null);
          setDrafted(null);
          void git('Committing', { type: 'commit', message }).then((ok) => {
            if (!ok) return;
            setMessage('');
            setCommittedAt(Date.now());
          });
        }}
      >
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What did you change?"
          rows={message.includes('\n') ? 6 : 2}
          disabled={disabled || drafting !== null}
          onKeyDown={(e) => {
            // Ctrl+Enter commits, as in most git tools; Enter alone starts a new line.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="lock-form">
          <DraftButton
            state={state}
            disabled={disabled || changed.length === 0}
            drafting={drafting}
            onStart={() => {
              setDrafted(null);
              setResult(null);
            }}
            hasMessage={message.trim() !== ''}
          />
          <span className="spacer" />
          <button type="submit" disabled={disabled || drafting !== null || !message.trim() || (changed.length === 0 && !info.merging)}>
            Commit all
          </button>
        </div>
        {drafting && <p className="muted small">{drafting} is reading your changes and writing a draft…</p>}
        {drafted && <p className={drafted.ok ? 'muted small' : 'error small'}>{drafted.text}</p>}
      </form>
      {freeable.length > 0 && (
        <div className="commit-locks">
          <p className="small">
            You still hold {freeable.length === 1 ? 'a lock' : `${freeable.length} locks`} on {freeable.length === 1 ? 'a file' : 'files'} with no uncommitted changes now.
            Release {freeable.length === 1 ? 'it' : 'them'} so others can work on {freeable.length === 1 ? 'it' : 'them'}?
          </p>
          <ul className="git-files">
            {freeable.map((lock) => (
              <li key={lock.id}>
                <code>{lock.path}</code> <span className="muted small">{lock.kind === 'exclusive' ? 'exclusive' : 'soft'}</span>
              </li>
            ))}
          </ul>
          <div className="lock-form">
            <button
              onClick={() => {
                for (const lock of freeable) window.pct.releaseLock(lock.id);
                setCommittedAt(null);
              }}
            >
              Release {freeable.length === 1 ? 'it' : `all ${freeable.length}`}
            </button>
            <button className="secondary" onClick={() => setCommittedAt(null)}>
              Keep {freeable.length === 1 ? 'it' : 'them'}
            </button>
          </div>
        </div>
      )}

      <h3 className="section-title gh-subtitle">Branch</h3>
      <div className="lock-form">
        <select
          value={branch ?? ''}
          disabled={disabled}
          onChange={async (e) => {
            const to = e.target.value;
            if (!to || to === branch) return;
            const warning = switchWarning(changed.length, heldLocks.length);
            if (warning && !(await ask(`Switch to ${to}?`, { detail: warning, confirm: 'Switch' }))) return;
            void git('Switching', { type: 'switch', branch: to });
          }}
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
      {info.inUse.length > 0 && (
        <p className="muted small">
          Not listed: {info.inUse.map((name, i) => (
            <span key={name}>
              {i > 0 && ', '}
              <code>{name}</code>
            </span>
          ))}{' '}
          ({info.inUse.length === 1 ? 'it is' : 'they are'} checked out in an agent chat's own copy; merge or discard that work from the chat).
        </p>
      )}
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

/** What to warn about before switching branches, or null when nothing is at stake. */
function switchWarning(uncommitted: number, locks: number): string | null {
  const parts: string[] = [];
  if (uncommitted > 0) {
    parts.push(
      `You have ${uncommitted} uncommitted ${uncommitted === 1 ? 'change' : 'changes'}. Git brings ${uncommitted === 1 ? 'it' : 'them'} along to the other branch, ` +
        'or refuses to switch if that branch changes the same files. Commit first to keep them on this branch.',
    );
  }
  if (locks > 0) {
    parts.push(
      `You hold ${locks} ${locks === 1 ? 'lock' : 'locks'}. ${locks === 1 ? 'It stays' : 'They stay'} held after the switch, ` +
        'but the files on the other branch may be different from the ones you locked.',
    );
  }
  return parts.length ? parts.join('\n\n') : null;
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
export function WorkspaceCard({
  local,
  tasks,
  onOpenTask,
  onSetup,
}: {
  local: LocalWorkspace | null;
  tasks: Task[];
  onOpenTask: (taskId: string) => void;
  onSetup: () => void;
}) {
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
        <span className="muted small">No copy yet? Clone it from Code.</span>
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
              <span className={`small ${outside.length > 0 ? 'warning' : task.scope.length === 0 ? 'muted' : 'good'}`} title={outside.join('\n')}>
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
      <button className="link small" onClick={onSetup} title="Engine presets, agent rules and folder notes for this project">
        Set up project
      </button>
      <button className="link small" onClick={() => void choose()}>
        Change folder
      </button>
      <button
        className="link small"
        title="Forget this folder in the app: the files stay where they are"
        onClick={async () => {
          const ok = await ask('Stop using this folder?', {
            detail: `${local.folder}\n\nThe app forgets it: your changes and branch stop showing to the others, and agents can no longer start here. The files on disk stay as they are; choose the folder again any time.`,
            confirm: 'Stop using it',
          });
          if (ok) window.pct.stopWorkspace();
        }}
      >
        Stop using this folder
      </button>
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

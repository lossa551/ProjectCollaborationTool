import { useMemo, useState } from 'react';
import {
  featureFromIssue,
  issueFromPlan,
  issueLinks,
  issuesOfFeature,
  issuesToClose,
  type Issue,
  type IssueLink,
  type IssueLinkKind,
  type PlanItem,
} from '@pct/shared';
import type { AppState } from '../common/api';

// GitHub issues in the app (issue #43): the Issues tab of the Code screen, and
// the pieces the roadmap, the feature editor and Home use. Links, triage and
// "keep open" are shared through the planning space; opening and closing an
// issue goes through the host's GitHub token. GitHub stays the place to
// discuss an issue: its title and text are not edited here.

const NOBODY = '\u0000nobody';

export function IssuesScreen({
  state,
  onOpenFeature,
  onOpenTask,
}: {
  state: AppState;
  onOpenFeature: (id: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const { session } = state;
  const { github } = session;
  const links = useMemo(() => issueLinks(session), [session.planning, session.tasks, session.issueMarks]);
  const [label, setLabel] = useState('');
  const [assignee, setAssignee] = useState('');
  const [onlyOpenWork, setOnlyOpenWork] = useState(false);
  const labels = [...new Set(github.issues.flatMap((i) => i.labels.map((l) => l.name)))].sort((a, b) => a.localeCompare(b));
  const assignees = [...new Set(github.issues.flatMap((i) => i.assignees))].sort((a, b) => a.localeCompare(b));
  const untriaged = (issue: Issue) => !session.issueMarks[issue.number]?.triaged && !links.get(issue.number)?.length;
  const shown = github.issues.filter(
    (issue) =>
      (!label || issue.labels.some((l) => l.name === label)) &&
      (!assignee || (assignee === NOBODY ? issue.assignees.length === 0 : issue.assignees.includes(assignee))) &&
      (!onlyOpenWork || untriaged(issue)),
  );
  const toTriage = github.issues.filter(untriaged).length;

  if (!github.repo) {
    return (
      <section className="card">
        <h2>Issues</h2>
        <p className="muted">Link the session to a GitHub repository on the GitHub tab to see its issues here.</p>
      </section>
    );
  }

  return (
    <div className="locks-screen">
      <section className="card">
        <div className="row issue-head">
          <h2>
            Open issues <span className="muted">{github.issues.length}</span>
          </h2>
          <span className="grow" />
          <select value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Filter by label">
            <option value="">All labels</option>
            {labels.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Filter by assignee">
            <option value="">Anyone assigned</option>
            <option value={NOBODY}>Nobody assigned</option>
            {assignees.map((login) => (
              <option key={login} value={login}>
                {login}
              </option>
            ))}
          </select>
          <label className="row tight small">
            <input type="checkbox" checked={onlyOpenWork} onChange={(e) => setOnlyOpenWork(e.target.checked)} />
            Not linked or triaged{toTriage > 0 && ` (${toTriage})`}
          </label>
        </div>
        <p className="muted small">
          Link an issue to a feature or task here, or write <code>#123</code> in a feature or task title. A feature made from an issue keeps the link, and
          when the feature is done the app offers to close the issue.
        </p>
        {github.issues.length === 0 ? (
          <p className="muted">{github.fetchedAt ? 'No open issues.' : 'Waiting for GitHub…'}</p>
        ) : shown.length === 0 ? (
          <p className="muted">No issues match these filters.</p>
        ) : (
          <ul className="gh-list">
            {shown.map((issue) => (
              <IssueRow key={issue.number} issue={issue} links={links.get(issue.number) ?? []} state={state} onOpenFeature={onOpenFeature} onOpenTask={onOpenTask} />
            ))}
          </ul>
        )}
        {github.error && <p className="error small">{github.error}</p>}
      </section>
    </div>
  );
}

function IssueRow({
  issue,
  links,
  state,
  onOpenFeature,
  onOpenTask,
}: {
  issue: Issue;
  links: IssueLink[];
  state: AppState;
  onOpenFeature: (id: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const { session } = state;
  const editable = state.canEditTasks;
  const triaged = session.issueMarks[issue.number]?.triaged ?? null;
  const [picking, setPicking] = useState(false);

  const makeFeature = () => {
    const id = crypto.randomUUID();
    for (const op of featureFromIssue(issue, id)) window.pct.editPlanning(op);
    onOpenFeature(id);
  };

  return (
    <li className="issue-row">
      <div className="issue-line">
        <a href={issue.url} target="_blank" rel="noreferrer" className="issue-title">
          <span className="muted">#{issue.number}</span> {issue.title}
        </a>
        {issue.labels.map((l) => (
          <IssueLabel key={l.name} name={l.name} color={l.color} />
        ))}
        <span className="grow" />
        <span className="muted small">
          {issue.assignees.length > 0 ? issue.assignees.join(', ') : 'nobody assigned'} · {ago(issue.updatedAt)}
        </span>
      </div>
      <div className="issue-line small">
        {links.length > 0 ? (
          <>
            <span className="muted">Linked to</span>
            {links.map((link) => (
              <LinkChip
                key={`${link.kind}:${link.id}`}
                link={link}
                editable={editable}
                onOpen={() => (link.kind === 'feature' ? onOpenFeature(link.id) : onOpenTask(link.id))}
                onUnlink={() => window.pct.editPlanning({ op: 'issue', number: issue.number, link: { kind: link.kind, id: link.id, linked: false } })}
              />
            ))}
          </>
        ) : triaged ? (
          <span className="muted">
            Triaged by {triaged.by}, not linked{' '}
            <button className="link small" disabled={!editable} onClick={() => window.pct.editPlanning({ op: 'issue', number: issue.number, triaged: false })}>
              Undo
            </button>
          </span>
        ) : (
          <span className="warning">Not linked or triaged</span>
        )}
        <span className="grow" />
        {picking ? (
          <LinkPicker
            state={state}
            exclude={links}
            onPick={(kind, id) => {
              window.pct.editPlanning({ op: 'issue', number: issue.number, link: { kind, id, linked: true } });
              setPicking(false);
            }}
            onCancel={() => setPicking(false)}
          />
        ) : (
          <>
            <button className="secondary small" disabled={!editable} onClick={() => setPicking(true)}>
              Link…
            </button>
            <button className="secondary small" disabled={!editable} onClick={makeFeature} title="Start a feature in planning from this issue">
              Make feature
            </button>
            {links.length === 0 && !triaged && (
              <button
                className="secondary small"
                disabled={!editable}
                onClick={() => window.pct.editPlanning({ op: 'issue', number: issue.number, triaged: true })}
                title="Seen, nothing to plan for it now"
              >
                Mark triaged
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

/** A label as GitHub colours it, with text that stays readable on it. */
function IssueLabel({ name, color }: { name: string; color: string }) {
  const hex = /^[0-9a-f]{6}$/i.test(color) ? color : '888888';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const light = 0.299 * r! + 0.587 * g! + 0.114 * b! > 150;
  return (
    <span className="issue-label" style={{ background: `#${hex}`, color: light ? '#16181d' : '#fff' }}>
      {name}
    </span>
  );
}

function LinkChip({ link, editable, onOpen, onUnlink }: { link: IssueLink; editable: boolean; onOpen: () => void; onUnlink: () => void }) {
  return (
    <span className="issue-link" title={link.by === 'mention' ? 'Linked because its text mentions the issue' : 'Linked by hand'}>
      <span className="muted">{link.kind === 'feature' ? 'Feature' : 'Task'}</span>
      <button className="link small" onClick={onOpen}>
        {link.title}
      </button>
      <button className="link small" disabled={!editable} onClick={onUnlink} aria-label={`Unlink ${link.title}`} title="Unlink">
        ✕
      </button>
    </span>
  );
}

/** Picks a feature, idea or task to link an issue to. */
function LinkPicker({
  state,
  exclude,
  onPick,
  onCancel,
}: {
  state: AppState;
  exclude: IssueLink[];
  onPick: (kind: IssueLinkKind, id: string) => void;
  onCancel: () => void;
}) {
  const { session } = state;
  const taken = new Set(exclude.map((l) => l.id));
  const plans = session.planning.filter((i) => i.kind !== 'note' && !taken.has(i.id));
  const tasks = session.tasks.filter((t) => t.stage !== 'done' && !taken.has(t.id));
  return (
    <span className="row tight">
      <select
        autoFocus
        defaultValue=""
        onChange={(e) => {
          const [kind, id] = e.target.value.split('|') as [IssueLinkKind, string];
          if (id) onPick(kind, id);
        }}
      >
        <option value="" disabled>
          Link to…
        </option>
        {plans.length > 0 && (
          <optgroup label="Features and ideas">
            {plans.map((i) => (
              <option key={i.id} value={`feature|${i.id}`}>
                {i.title}
              </option>
            ))}
          </optgroup>
        )}
        {tasks.length > 0 && (
          <optgroup label="Tasks">
            {tasks.map((t) => (
              <option key={t.id} value={`task|${t.id}`}>
                {t.title}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <button className="link small" onClick={onCancel}>
        Cancel
      </button>
    </span>
  );
}

/** "#12" chips for the issues of a feature, e.g. on its roadmap row. */
export function IssueChips({ issues }: { issues: Issue[] }) {
  return (
    <>
      {issues.map((issue) => (
        <a key={issue.number} className="pull-badge issue-chip" href={issue.url} target="_blank" rel="noreferrer" title={issue.title} onClick={(e) => e.stopPropagation()}>
          #{issue.number}
        </a>
      ))}
    </>
  );
}

/**
 * Asks before closing an issue on GitHub, showing the comment it will get;
 * nothing is closed without this. Returns the error, if any.
 */
export async function confirmCloseIssue(issue: Pick<Issue, 'number' | 'title'>, comment: string): Promise<string | null> {
  if (!confirm(`Close issue #${issue.number} "${issue.title}" on GitHub?\n\nIt gets this comment:\n\n${comment}`)) return null;
  const result = await window.pct.closeIssue(issue.number, comment);
  return result.ok ? null : result.error;
}

/**
 * The GitHub issues of a feature or idea in its editor: linked ones, linking
 * another, opening a new one from the plan, and closing them once the feature
 * is done.
 */
export function PlanIssues({ item, state }: { item: PlanItem; state: AppState }) {
  const { session } = state;
  const { github } = session;
  const editable = state.canEditTasks;
  const online = session.status === 'connected';
  const links = useMemo(() => issueLinks(session), [session.planning, session.tasks, session.issueMarks]);
  const issues = issuesOfFeature(session, item, links);
  const closable = new Map(issuesToClose(session).filter((c) => c.feature.id === item.id).map((c) => [c.issue.number, c]));
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!github.repo) return null;

  const linkedHere = (issue: Issue) => links.get(issue.number)?.find((l) => l.kind === 'feature' && l.id === item.id) ?? null;
  const unlinked = github.issues.filter((i) => !issues.includes(i));

  const create = async () => {
    setBusy(true);
    setError(null);
    const result = await window.pct.createIssue({ ...issueFromPlan(item), link: { kind: 'feature', id: item.id } });
    setBusy(false);
    if (!result.ok) setError(result.error);
  };
  const close = async (issue: Issue, comment: string) => {
    setBusy(true);
    setError(await confirmCloseIssue(issue, comment));
    setBusy(false);
  };

  return (
    <div className="field plan-issues">
      <span>
        GitHub issues <span className="muted">· linked here, through a task, or by writing #123 in the plan</span>
      </span>
      {issues.length > 0 && (
        <ul className="gh-list">
          {issues.map((issue) => {
            const own = linkedHere(issue);
            const offer = closable.get(issue.number);
            return (
              <li key={issue.number}>
                <a href={issue.url} target="_blank" rel="noreferrer">
                  <span className="muted">#{issue.number}</span> {issue.title}
                </a>
                {!own && <span className="muted small">through a task</span>}
                <span className="grow" />
                {offer && (
                  <>
                    <span className="small good">Feature done</span>
                    <button className="small" disabled={!online || busy} onClick={() => void close(issue, offer.comment)}>
                      Close on GitHub…
                    </button>
                    <button
                      className="link small"
                      disabled={!editable}
                      onClick={() => window.pct.editPlanning({ op: 'issue', number: issue.number, keepOpen: true })}
                      title="Stop offering to close it"
                    >
                      Keep open
                    </button>
                  </>
                )}
                {own && (
                  <button
                    className="link small"
                    disabled={!editable}
                    onClick={() => window.pct.editPlanning({ op: 'issue', number: issue.number, link: { kind: 'feature', id: item.id, linked: false } })}
                  >
                    Unlink
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="row tight">
        {picking ? (
          <>
            <select
              autoFocus
              defaultValue=""
              onChange={(e) => {
                const number = Number(e.target.value);
                if (number) window.pct.editPlanning({ op: 'issue', number, link: { kind: 'feature', id: item.id, linked: true } });
                setPicking(false);
              }}
            >
              <option value="" disabled>
                Pick an open issue…
              </option>
              {unlinked.map((i) => (
                <option key={i.number} value={i.number}>
                  #{i.number} {i.title}
                </option>
              ))}
            </select>
            <button className="link small" onClick={() => setPicking(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button className="secondary small" disabled={!editable || unlinked.length === 0} onClick={() => setPicking(true)}>
            Link an issue
          </button>
        )}
        <button
          className="secondary small"
          disabled={!online || busy || !github.authenticated}
          onClick={() => void create()}
          title={github.authenticated ? 'Open an issue on GitHub with this plan as its text, linked to it' : 'Needs a GitHub token on the host'}
        >
          {busy ? 'Working…' : 'Open an issue on GitHub'}
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

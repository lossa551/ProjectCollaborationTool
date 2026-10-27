import { useEffect, useMemo, useState } from 'react';
import {
  FEATURE_STATE_LABELS,
  currentMilestone,
  describeDaysLeft,
  featureCounts,
  groupActivity,
  newIssues,
  parseLockWait,
  pullProblems,
  roadmap,
  samePath,
  sinceLastHere,
  untriagedIssues,
  whoIsDoing,
  type FeatureState,
  type Lock,
  type NeedItem,
  type NeedTarget,
  type RoadmapLane,
} from '@pct/shared';
import type { AppState } from '../common/api';
import { Avatar } from './Avatar';
import { PullBadge } from './GitHub';
import { confirmCloseIssue } from './Issues';
import { RiskBadge } from './Roadmap';
import { recall, remember } from './storage';

// Home (issue #34): the screen a session opens on. What needs you, who is doing
// what, how far the features are, and what changed while you were away. It
// does not repeat the other screens: each line leads to where you act on it.

const NEED_BUTTON: Record<NeedItem['kind'], string> = {
  approval: 'Review',
  'lock-wait': 'Release',
  pull: 'Open',
  'outside-scope': 'Show',
  overlap: 'Show',
  'abandoned-lock': 'Recover',
  plan: 'Review plan',
  'close-issue': 'Close…',
};

/** Feature states in the order they matter, with how each reads on Home. */
const FEATURE_TILES: { state: FeatureState; label: string; tone: string }[] = [
  { state: 'blocked', label: 'Blocked', tone: 'bad' },
  { state: 'unverified', label: 'Built, not tested', tone: 'warn' },
  { state: 'ready', label: 'Ready', tone: 'good' },
  { state: 'in-progress', label: 'In progress', tone: '' },
  { state: 'planning', label: 'In planning', tone: '' },
];

/** Lines per digest group, so Home stays one window high. */
const DIGEST_LINES = 4;

/** A lock is worth a line on Home once it has been held this long. */
const LONG_LOCK_MS = 2 * 60 * 60_000;

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function when(at: number): string {
  const sameDay = new Date(at).toDateString() === new Date().toDateString();
  return sameDay ? `today at ${time(at)}` : new Date(at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function heldFor(since: number): string {
  const minutes = Math.round((Date.now() - since) / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

export function HomeScreen({
  state,
  needs,
  since,
  onMarkSeen,
  go,
  onFeatures,
  onInvite,
  onSettings,
  onCode,
}: {
  state: AppState;
  needs: NeedItem[];
  /** When you were last here; null on your first visit to this session. */
  since: number | null;
  onMarkSeen: () => void;
  go: (target: NeedTarget) => void;
  onFeatures: (filter: FeatureState | null) => void;
  onInvite: () => void;
  onSettings: () => void;
  onCode: (tab: 'github' | 'issues' | 'locks') => void;
}) {
  const { session } = state;
  return (
    <div className="home">
      <SetupChecklist state={state} onInvite={onInvite} onSettings={onSettings} onCode={onCode} />
      <div className="home-col">
        <NeedsYou needs={needs} online={session.status === 'connected'} go={go} />
        <WhoIsDoing state={state} go={go} />
        <Digest state={state} since={since} onMarkSeen={onMarkSeen} go={go} />
      </div>
      <div className="home-col">
        <Features state={state} onFeatures={onFeatures} />
        <div className="home-pair">
          <Pulls state={state} onCode={onCode} />
          <Locks state={state} go={go} onCode={onCode} />
        </div>
        <Issues state={state} since={since} onCode={onCode} />
        <ActivityFeed state={state} go={go} />
      </div>
    </div>
  );
}

function NeedsYou({ needs, online, go }: { needs: NeedItem[]; online: boolean; go: (target: NeedTarget) => void }) {
  const act = (item: NeedItem) => {
    if (!item.act) return go(item.target);
    if (item.act.type === 'close-issue') {
      const { number, comment } = item.act;
      void confirmCloseIssue({ number, title: item.detail ?? '' }, comment).then((error) => error && alert(error));
      return;
    }
    if (item.act.type === 'release-lock') return window.pct.releaseLock(item.act.lockId);
    if (confirm(`${item.text}. Recover the lock? Their unsaved work on it may be lost.`)) window.pct.recoverLock(item.act.lockId);
  };
  return (
    <section className="home-panel needs">
      <h2>
        Needs you <span className="muted">{needs.length}</span>
      </h2>
      {needs.length === 0 ? (
        <p className="muted">Nothing needs you right now.</p>
      ) : (
        <ul className="home-rows">
          {needs.map((item) => (
            <li key={item.id}>
              <span className={`tone tone-${item.tone}`} />
              <span className="grow">
                {item.text}
                {item.detail && <span className="muted small"> · {item.detail}</span>}
              </span>
              {item.act && (
                <button className="link small" onClick={() => go(item.target)}>
                  {item.kind === 'lock-wait' ? 'Open chat' : 'Open'}
                </button>
              )}
              <button className={item.act ? 'small' : 'secondary small'} disabled={!!item.act && !online} onClick={() => act(item)}>
                {NEED_BUTTON[item.kind]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Features({ state, onFeatures }: { state: AppState; onFeatures: (filter: FeatureState | null) => void }) {
  const { session } = state;
  const { planning, tasks } = session;
  const counts = useMemo(() => featureCounts({ planning, tasks }), [planning, tasks]);
  const current = useMemo(() => currentMilestone(roadmap(session)), [session.planning, session.milestones, session.tasks, session.github, session.chats, session.agents]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <section className="home-panel">
      <h2>
        Features
        {total > 0 && (
          <button className="link small" onClick={() => onFeatures(null)}>
            Open roadmap
          </button>
        )}
      </h2>
      {total === 0 ? (
        <p className="muted">
          No features planned yet.{' '}
          <button className="link" onClick={() => onFeatures(null)}>
            Plan the first one
          </button>
        </p>
      ) : (
        <>
          {current && <MilestoneSummary lane={current} onOpen={() => onFeatures(null)} />}
          <div className="feature-tiles">
            {FEATURE_TILES.map((tile) => (
              <button
                key={tile.state}
                className={`feature-tile ${counts[tile.state] > 0 ? tile.tone : ''}`}
                disabled={counts[tile.state] === 0}
                onClick={() => onFeatures(tile.state)}
                title={`Show ${FEATURE_STATE_LABELS[tile.state].toLowerCase()} features on the roadmap`}
              >
                <b>{counts[tile.state]}</b>
                <span>{tile.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** The milestone being worked on: how far it is, what blocks it, and when it is due. */
function MilestoneSummary({ lane, onOpen }: { lane: RoadmapLane; onOpen: () => void }) {
  const { milestone, done, blocked } = lane;
  const total = lane.features.length;
  return (
    <div className="milestone-summary">
      <p className="small">
        <button className="link" onClick={onOpen} title="Open the roadmap">
          {milestone.title}
        </button>
        {milestone.goal && <span className="muted"> · {milestone.goal}</span>}
        {milestone.target && (
          <span className="muted">
            {' '}
            · target {new Date(`${milestone.target}T00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' })}, {describeDaysLeft(lane.daysLeft!)}
          </span>
        )}{' '}
        <RiskBadge lane={lane} />
      </p>
      <div className="progress" title={`${done} of ${total} features done`}>
        <span style={{ width: `${(done / total) * 100}%` }} />
      </div>
      <p className="muted small">
        {done} of {total} features done{blocked > 0 && <span className="bad"> · {blocked} blocked</span>}
      </p>
    </div>
  );
}

function WhoIsDoing({ state, go }: { state: AppState; go: (target: NeedTarget) => void }) {
  const { session } = state;
  const youId = session.you?.id ?? null;
  const rows = useMemo(
    () =>
      whoIsDoing(session).sort(
        (a, b) => Number(b.participant.id === youId) - Number(a.participant.id === youId) || a.participant.connectedAt - b.participant.connectedAt,
      ),
    [session, youId],
  );
  return (
    <section className="home-panel">
      <h2>Who is doing what</h2>
      {rows.length === 0 && <p className="muted">Waiting for the server…</p>}
      <ul className="home-rows">
        {rows.map((row) => {
          const p = row.participant;
          return (
            <li key={p.id}>
              <Avatar name={p.name} kind={p.kind} status={p.status} small />
              <span className="grow">
                <strong>{p.name}</strong>
                {p.id === youId && <span className="muted"> (you)</span>}
                {row.task ? (
                  <>
                    {' · '}
                    <button className="link" onClick={() => go({ screen: 'task', taskId: row.task!.id })}>
                      {row.task.title}
                    </button>
                  </>
                ) : (
                  p.kind === 'human' && <span className="muted"> · no task</span>
                )}
                {row.branch && <code className="muted small"> {row.branch}</code>}
                {row.files !== null && row.files > 0 && <span className="muted small"> · {row.files} changed</span>}
                {row.activity ? (
                  <>
                    {' · '}
                    <button className="link small" onClick={() => go({ screen: 'chat', chatId: row.chatId! })}>
                      <span className={`dot dot-${row.state}`} />
                      {row.activity}
                    </button>
                  </>
                ) : (
                  p.kind === 'agent' && <span className="muted small"> · idle</span>
                )}
                {row.locks.length > 0 && (
                  <span className="muted small" title={row.locks.map((l) => l.path).join('\n')}>
                    {' '}
                    · {row.locks.length} {row.locks.length === 1 ? 'lock' : 'locks'}
                  </span>
                )}
              </span>
              <span className={`presence presence-${p.status} small`}>{p.status}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Digest({ state, since, onMarkSeen, go }: { state: AppState; since: number | null; onMarkSeen: () => void; go: (target: NeedTarget) => void }) {
  const { session } = state;
  const groups = useMemo(
    () => (since === null ? [] : sinceLastHere(session, since, session.you?.name ?? null)),
    [session, since],
  );
  return (
    <section className="home-panel digest">
      <h2>
        Since you were last here
        {since !== null && groups.length > 0 && (
          <button className="link small" onClick={onMarkSeen}>
            Mark as seen
          </button>
        )}
      </h2>
      {since === null ? (
        <p className="muted">First time in this session here. From your next visit, this lists what changed while you were away.</p>
      ) : groups.length === 0 ? (
        <p className="muted">Nothing changed since {when(since)}.</p>
      ) : (
        <>
          <p className="muted small">Since {when(since)}, by the others and their agents.</p>
          {groups.map((group) => (
            <div key={group.key} className="digest-group">
              <h3 className="section-title">{group.title}</h3>
              <ul>
                {group.lines.slice(0, DIGEST_LINES).map((line, i) => (
                  <li key={i}>
                    {line.target ? (
                      <button className="link" onClick={() => go(line.target!)}>
                        {line.text}
                      </button>
                    ) : (
                      line.text
                    )}
                  </li>
                ))}
                {group.lines.length > DIGEST_LINES && <li className="muted">and {group.lines.length - DIGEST_LINES} more</li>}
              </ul>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function Pulls({ state, onCode }: { state: AppState; onCode: (tab: 'github') => void }) {
  const { github } = state.session;
  const open = github.pulls.filter((p) => p.state === 'open');
  const unusual = open.filter((p) => pullProblems(p).length > 0);
  return (
    <section className="home-panel">
      <h2>
        Pull requests
        <button className="link small" onClick={() => onCode('github')}>
          All
        </button>
      </h2>
      {!github.repo ? (
        <p className="muted small">No GitHub repository linked yet.</p>
      ) : (
        <>
          <ul className="home-rows">
            {unusual.map((pull) => (
              <li key={pull.number}>
                <span className="grow ellipsis" title={pull.title}>
                  {pull.title}
                </span>
                <PullBadge pull={pull} />
              </li>
            ))}
          </ul>
          <p className="muted small">
            {open.length === 0
              ? 'No open pull requests.'
              : unusual.length === 0
                ? `${open.length} open, all fine.`
                : open.length > unusual.length && `${open.length - unusual.length} more open, all fine.`}
          </p>
        </>
      )}
    </section>
  );
}

/** Rows of issues to triage on Home; the Issues tab has the rest. */
const ISSUE_LINES = 4;

/** Issues nobody has linked or triaged yet, the new ones marked. */
function Issues({ state, since, onCode }: { state: AppState; since: number | null; onCode: (tab: 'issues') => void }) {
  const { session } = state;
  const { github } = session;
  const open = useMemo(
    () => untriagedIssues(session).sort((a, b) => b.createdAt - a.createdAt),
    [session.github, session.planning, session.tasks, session.issueMarks],
  );
  if (!github.repo || github.issues.length === 0) return null;
  const fresh = since === null ? [] : newIssues(session, since);
  return (
    <section className="home-panel">
      <h2>
        Issues to triage <span className="muted">{open.length}</span>
        <button className="link small" onClick={() => onCode('issues')}>
          All
        </button>
      </h2>
      {open.length === 0 ? (
        <p className="muted small">Every open issue is linked to a feature or task, or triaged.</p>
      ) : (
        <ul className="home-rows">
          {open.slice(0, ISSUE_LINES).map((issue) => (
            <li key={issue.number}>
              <span className="grow ellipsis" title={issue.title}>
                <span className="muted">#{issue.number}</span> {issue.title}
              </span>
              {fresh.includes(issue) && <span className="feature-badge feature-unverified">New</span>}
              <button className="secondary small" onClick={() => onCode('issues')}>
                Link
              </button>
            </li>
          ))}
        </ul>
      )}
      {open.length > ISSUE_LINES && <p className="muted small">{open.length - ISSUE_LINES} more to triage.</p>}
    </section>
  );
}

function Locks({ state, go, onCode }: { state: AppState; go: (target: NeedTarget) => void; onCode: (tab: 'locks') => void }) {
  const { session } = state;
  const online = session.status === 'connected';
  const youId = session.you?.id ?? null;
  const waitedOn = (lock: Lock) =>
    session.chats.some((c) => c.state === 'waiting' && samePath(parseLockWait(c.activity) ?? '', lock.path));
  const unusual = session.locks.filter((l) => l.abandoned || waitedOn(l) || Date.now() - l.acquiredAt > LONG_LOCK_MS);
  return (
    <section className="home-panel">
      <h2>
        Locks <span className="muted">{session.locks.length} held</span>
        <button className="link small" onClick={() => onCode('locks')}>
          All
        </button>
      </h2>
      <ul className="home-rows">
        {unusual.map((lock) => (
          <li key={lock.id}>
            <span className={`tone tone-${lock.abandoned ? 'idle' : 'warn'}`} />
            <span className="grow" title={lock.path}>
              {lock.taskId ? (
                <button className="link" onClick={() => go({ screen: 'task', taskId: lock.taskId! })}>
                  {lock.path}
                </button>
              ) : (
                lock.path
              )}
              <span className="muted small">
                {' '}
                · {lock.holder.id === youId ? 'you' : lock.holder.name} ·{' '}
                {lock.abandoned ? 'abandoned' : waitedOn(lock) ? 'an agent is waiting' : heldFor(lock.acquiredAt)}
              </span>
            </span>
            {lock.abandoned && lock.holder.id !== youId && (
              <button
                className="secondary small"
                disabled={!online}
                onClick={() => confirm(`Recover ${lock.path} from ${lock.holder.name}? Their unsaved work on it may be lost.`) && window.pct.recoverLock(lock.id)}
              >
                Recover
              </button>
            )}
          </li>
        ))}
      </ul>
      {session.locks.length > unusual.length && (
        <p className="muted small">
          {unusual.length === 0 ? 'All' : `${session.locks.length - unusual.length} more,`} active and recent.
        </p>
      )}
      {session.locks.length === 0 && <p className="muted small">Nobody holds a lock.</p>}
    </section>
  );
}

function ActivityFeed({ state, go }: { state: AppState; go: (target: NeedTarget) => void }) {
  const { session } = state;
  const entries = useMemo(() => groupActivity(session.activity).reverse(), [session.activity]);
  const taskIds = new Set(session.tasks.map((t) => t.id));
  return (
    <section className="home-panel activity">
      <h2>Activity</h2>
      <ol>
        {entries.map((entry) => {
          const clickable = entry.taskId !== null && taskIds.has(entry.taskId);
          return (
            <li key={entry.id} className={clickable ? 'clickable' : undefined} onClick={() => clickable && go({ screen: 'task', taskId: entry.taskId! })}>
              <span>
                {entry.actorName && <strong>{entry.actorName} </strong>}
                {entry.text}
              </span>
              <time className="muted">{time(entry.at)}</time>
            </li>
          );
        })}
      </ol>
      {entries.length === 0 && <p className="muted">Nothing yet.</p>}
    </section>
  );
}

interface SetupStep {
  key: string;
  label: string;
  hint: string;
  done: boolean;
  action?: { label: string; run: () => void };
}

/** Steps for a new session, for the host and for whoever joins; gone once done or hidden. */
function SetupChecklist({
  state,
  onInvite,
  onSettings,
  onCode,
}: {
  state: AppState;
  onInvite: () => void;
  onSettings: () => void;
  onCode: (tab: 'github') => void;
}) {
  const { session, hosting, workspace } = state;
  const sessionId = session.session?.id ?? 'none';
  const [hidden, setHidden] = useState(() => recall(`setupHidden.${sessionId}`) === '1');
  const [error, setError] = useState<string | null>(null);
  const youId = session.you?.id ?? null;

  // Someone else has joined at some point: remembered, since they may be offline now.
  const othersHere = session.participants.some((p) => p.kind === 'human' && p.id !== youId);
  useEffect(() => {
    if (othersHere) remember(`friendJoined.${sessionId}`, '1');
  }, [othersHere, sessionId]);
  const friendJoined = othersHere || recall(`friendJoined.${sessionId}`) === '1';

  const run = (action: () => Promise<{ ok: boolean; error?: string }>) => async () => {
    setError(null);
    const result = await action();
    if (!result.ok) setError(result.error ?? 'That did not work.');
  };
  const hasFolder = !!workspace?.folder && !workspace.error;

  const steps: SetupStep[] = [];
  if (hosting) {
    steps.push({
      key: 'tailscale',
      label: 'Start Tailscale',
      hint: 'Your friend reaches this PC through Tailscale. Install it and sign in, then stop hosting and host again.',
      done: hosting.addressSource === 'tailscale',
      action: { label: 'Get Tailscale', run: () => window.open('https://tailscale.com/download/windows') },
    });
    steps.push({ key: 'invite', label: 'Invite your friend', hint: 'Send them the invite code privately.', done: friendJoined, action: { label: 'Invite', run: onInvite } });
    steps.push({
      key: 'repo',
      label: 'Link the GitHub repository',
      hint: 'Shows branches, pull requests and checks to everyone.',
      done: !!session.github.repo,
      action: { label: 'Open Code', run: () => onCode('github') },
    });
  }
  steps.push({
    key: 'folder',
    label: 'Choose your project folder',
    hint: session.github.repo ? 'Pick your copy of the repository, or let the app clone it.' : 'Pick the folder you work in.',
    done: hasFolder,
    action: session.github.repo && !hasFolder ? { label: 'Clone', run: run(() => window.pct.cloneRepo()) } : { label: 'Choose folder', run: run(() => window.pct.chooseWorkspace()) },
  });
  if (hosting) {
    steps.push({
      key: 'token',
      label: 'Give the session a GitHub token',
      hint: 'Without one, GitHub status refreshes every 10 minutes and only for public repositories.',
      done: state.githubToken !== 'none',
      action: { label: 'Open Code', run: () => onCode('github') },
    });
  }
  steps.push({
    key: 'agent',
    label: 'Add your first agent',
    hint: 'A model API, a local model or a command-line agent like Claude Code.',
    done: session.agents.length > 0,
    action: { label: 'Add agent', run: onSettings },
  });

  const left = steps.filter((s) => !s.done).length;
  if (hidden || left === 0) return null;
  return (
    <section className="home-panel setup">
      <h2>
        Set up this session <span className="muted">{steps.length - left} of {steps.length} done</span>
        <button
          className="link small"
          onClick={() => {
            remember(`setupHidden.${sessionId}`, '1');
            setHidden(true);
          }}
        >
          Hide
        </button>
      </h2>
      <ol className="setup-steps">
        {steps.map((step) => (
          <li key={step.key} className={step.done ? 'done' : undefined}>
            <span className="check-mark">{step.done ? '✓' : ''}</span>
            <span className="grow">
              {step.label}
              {!step.done && <span className="muted small"> · {step.hint}</span>}
            </span>
            {!step.done && step.action && (
              <button className="secondary small" onClick={step.action.run}>
                {step.action.label}
              </button>
            )}
          </li>
        ))}
      </ol>
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

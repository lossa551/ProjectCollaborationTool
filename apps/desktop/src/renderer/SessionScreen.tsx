import { useEffect, useState } from 'react';
import type { Activity, Participant } from '@pct/shared';
import type { AppState, HostingInfo } from '../common/api';
import { Avatar } from './Avatar';
import { Board } from './Board';
import { TaskDetail } from './TaskDetail';
import { UpdateButton } from './UpdateButton';

// Nav items from docs/design/interface.md. Only the session board exists so far.
const NAV = ['Session board', 'Planning space', 'Locks and GitHub', 'Agents', 'Agent chat', 'Project memory'];

const STATUS_LABEL = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Live',
  reconnecting: 'Offline, reconnecting…',
  closed: 'Disconnected',
} as const;

export function SessionScreen({ state }: { state: AppState }) {
  const { session, hosting } = state;
  const participants = [...session.participants].sort((a, b) => a.connectedAt - b.connectedAt);
  const editable = session.status === 'connected';
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const selected = session.tasks.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="shell">
      <header className="titlebar">
        <strong>{session.session?.name ?? 'Session'}</strong>
        <span className={`status status-${session.status}`}>{STATUS_LABEL[session.status]}</span>
        <UpdateButton hosting={!!hosting} />
        <div className="avatars">
          {participants.map((p) => (
            <Avatar key={p.id} name={p.name} kind={p.kind} status={p.status} />
          ))}
        </div>
        {hosting && (
          <button className="secondary" onClick={() => setInviteOpen((open) => !open)}>
            Invite
          </button>
        )}
        <button className="secondary" onClick={() => void window.pct.leave()}>
          {hosting ? 'Stop hosting' : 'Leave'}
        </button>
        {hosting && inviteOpen && <InvitePopover hosting={hosting} onClose={() => setInviteOpen(false)} />}
      </header>

      <nav className="sidebar">
        {NAV.map((item, i) => (
          <button key={item} className={i === 0 ? 'nav active' : 'nav'} disabled={i !== 0} title={i === 0 ? undefined : 'Coming soon'}>
            {item}
          </button>
        ))}
      </nav>

      <main className="content">
        <Banner state={state} />
        <Board
          tasks={session.tasks}
          participants={participants}
          editable={editable}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </main>

      {selected ? (
        <TaskDetail task={selected} participants={participants} editable={editable} onClose={() => setSelectedId(null)} />
      ) : (
        <aside className="side-panel">
          <People participants={participants} youId={session.you?.id ?? null} />
          <ActivityFeed activity={session.activity} onSelect={setSelectedId} taskIds={new Set(session.tasks.map((t) => t.id))} />
        </aside>
      )}
    </div>
  );
}

/** Offline notice, or the last thing the server refused. */
function Banner({ state }: { state: AppState }) {
  const { status, error } = state.session;
  const [dismissed, setDismissed] = useState<typeof error>(null);
  useEffect(() => {
    if (!error || error === dismissed) return;
    const timer = setTimeout(() => setDismissed(error), 5000);
    return () => clearTimeout(timer);
  }, [error, dismissed]);

  if (status === 'reconnecting') {
    return <p className="banner warning">The session server is unreachable. The board is read-only until it is back.</p>;
  }
  if (status === 'connected' && error && error !== dismissed) {
    return (
      <p className="banner error" onClick={() => setDismissed(error)}>
        {error.message}
      </p>
    );
  }
  return null;
}

function People({ participants, youId }: { participants: Participant[]; youId: string | null }) {
  return (
    <section>
      <h2>Who is here</h2>
      <ul className="people">
        {participants.map((p) => (
          <li key={p.id}>
            <Avatar name={p.name} kind={p.kind} status={p.status} />
            <span className="grow">
              {p.name}
              {p.id === youId && <span className="muted"> (you)</span>}
              {p.kind === 'agent' && <span className="muted"> · agent</span>}
            </span>
            <span className={`presence presence-${p.status}`}>{p.status}</span>
          </li>
        ))}
      </ul>
      {participants.length === 0 && <p className="muted">Waiting for the server…</p>}
    </section>
  );
}

function ActivityFeed({
  activity,
  taskIds,
  onSelect,
}: {
  activity: Activity[];
  taskIds: Set<string>;
  onSelect: (taskId: string) => void;
}) {
  return (
    <section className="activity">
      <h2>Activity</h2>
      <ol>
        {[...activity].reverse().map((entry) => {
          const clickable = entry.taskId !== null && taskIds.has(entry.taskId);
          return (
            <li key={entry.id} className={clickable ? 'clickable' : undefined} onClick={() => clickable && onSelect(entry.taskId!)}>
              <span>
                {entry.actorName && <strong>{entry.actorName} </strong>}
                {entry.text}
              </span>
              <time className="muted">{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
            </li>
          );
        })}
      </ol>
      {activity.length === 0 && <p className="muted">Nothing yet.</p>}
    </section>
  );
}

function InvitePopover({ hosting, onClose }: { hosting: HostingInfo; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    window.pct.copyText(hosting.invite);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="popover card">
      <h2>Invite</h2>
      <p className="muted">Send this code to your friend. Anyone with it can join, so share it privately.</p>
      <div className="invite">
        <code>{hosting.invite}</code>
        <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <p className="muted">
        Address {hosting.address}:{hosting.port}
        {hosting.addressSource === 'tailscale' && ' (Tailscale)'}
      </p>
      {hosting.addressSource !== 'tailscale' && (
        <p className="warning">
          No Tailscale address found on this PC, so the invite uses{' '}
          {hosting.addressSource === 'lan' ? 'your local network address' : 'this PC only'}. Start Tailscale and host
          again so your friend can reach you.
        </p>
      )}
      <button className="secondary" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

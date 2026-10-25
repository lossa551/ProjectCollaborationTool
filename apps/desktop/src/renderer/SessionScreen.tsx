import { useState } from 'react';
import type { Participant } from '@pct/shared';
import type { AppState } from '../common/api';
import { UpdateButton } from './UpdateButton';

// Nav items from docs/design/interface.md. Only the session view exists so far.
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

  return (
    <div className="shell">
      <header className="titlebar">
        <strong>{session.session?.name ?? 'Session'}</strong>
        <span className={`status status-${session.status}`}>{STATUS_LABEL[session.status]}</span>
        <UpdateButton hosting={!!hosting} />
        <div className="avatars">
          {participants.map((p) => (
            <Avatar key={p.id} participant={p} />
          ))}
        </div>
        <button className="secondary" onClick={() => void window.pct.leave()}>
          {hosting ? 'Stop hosting' : 'Leave'}
        </button>
      </header>

      <nav className="sidebar">
        {NAV.map((item, i) => (
          <button key={item} className={i === 0 ? 'nav active' : 'nav'} disabled={i !== 0} title={i === 0 ? undefined : 'Coming soon'}>
            {item}
          </button>
        ))}
      </nav>

      <main className="content">
        {hosting && <InvitePanel invite={hosting.invite} address={hosting.address} source={hosting.addressSource} port={hosting.port} />}

        <section className="card">
          <h2>Who is here</h2>
          <ul className="people">
            {participants.map((p) => (
              <li key={p.id}>
                <Avatar participant={p} />
                <span>
                  {p.name}
                  {p.id === session.you?.id && <span className="muted"> (you)</span>}
                </span>
                <span className="muted">{p.kind === 'agent' ? 'Agent' : 'Person'}</span>
                <span className={`presence presence-${p.status}`}>{p.status}</span>
                {p.focus && <span className="muted">on {p.focus}</span>}
              </li>
            ))}
          </ul>
          {participants.length === 0 && <p className="muted">Waiting for the server…</p>}
        </section>

        <section className="card muted">
          The task board, locks and agents arrive in the next steps. This build covers connecting, presence and hosting.
        </section>
      </main>
    </div>
  );
}

function Avatar({ participant }: { participant: Participant }) {
  const initials = participant.name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className={`avatar avatar-${participant.kind} presence-${participant.status}`} title={`${participant.name} (${participant.status})`}>
      {initials}
    </span>
  );
}

function InvitePanel({ invite, address, source, port }: { invite: string; address: string; source: string; port: number }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    window.pct.copyText(invite);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <section className="card">
      <h2>Invite</h2>
      <p className="muted">
        Send this code to your friend. Anyone with it can join, so share it privately.
      </p>
      <div className="invite">
        <code>{invite}</code>
        <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <p className="muted">
        Address {address}:{port}
        {source === 'tailscale' && ' (Tailscale)'}
      </p>
      {source !== 'tailscale' && (
        <p className="warning">
          No Tailscale address found on this PC, so the invite uses {source === 'lan' ? 'your local network address' : 'this PC only'}.
          Start Tailscale and host again so your friend can reach you.
        </p>
      )}
    </section>
  );
}

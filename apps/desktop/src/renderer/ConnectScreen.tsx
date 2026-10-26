import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Result, SavedSessionInfo } from '../common/api';
import { recall, remember } from './storage';
import { UpdateButton } from './UpdateButton';

export function ConnectScreen({ error }: { error: string | null }) {
  const [name, setName] = useState(() => recall('name'));
  const [sessionName, setSessionName] = useState(() => recall('sessionName'));
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedSessionInfo[]>([]);

  const refresh = useCallback(() => void window.pct.listSessions().then(setSaved), []);
  useEffect(refresh, [refresh]);

  const run = async (event: FormEvent | null, action: () => Promise<Result>) => {
    event?.preventDefault();
    if (!name.trim()) return setLocalError('Enter your name first.');
    remember('name', name.trim());
    setBusy(true);
    setLocalError(null);
    const result = await action();
    setBusy(false);
    if (!result.ok) setLocalError(result.error);
  };

  const host = (event: FormEvent) => {
    remember('sessionName', sessionName.trim());
    return run(event, () => window.pct.host({ name: name.trim(), sessionName: sessionName.trim() }));
  };
  const join = (event: FormEvent) => run(event, () => window.pct.join({ name: name.trim(), invite }));
  const resume = (key: string) => run(null, () => window.pct.resume({ name: name.trim(), key }));
  const forget = async (key: string) => {
    const result = await window.pct.forgetSession(key);
    if (!result.ok) setLocalError(result.error);
    refresh();
  };

  const shownError = localError ?? error;

  return (
    <main className="connect">
      <header>
        <h1>Project Collaboration Tool</h1>
        <p className="muted">Start a live session on this PC, or join one with an invite code.</p>
        <UpdateButton hosting={false} />
      </header>

      <label className="field">
        <span>Your name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Martin" maxLength={64} autoFocus />
      </label>

      {shownError && <p className="error">{shownError}</p>}

      {saved.length > 0 && (
        <section className="card resume">
          <h2>Resume a session</h2>
          <ul className="resume-list">
            {saved.map((session) => (
              <SavedSessionRow key={session.key} session={session} busy={busy} onResume={resume} onForget={forget} />
            ))}
          </ul>
        </section>
      )}

      <div className="connect-options">
        <form className="card" onSubmit={host}>
          <h2>Host a new session</h2>
          <p className="muted">Runs the session server here. Your friend connects to it over Tailscale.</p>
          <label className="field">
            <span>Session name</span>
            <input value={sessionName} onChange={(e) => setSessionName(e.target.value)} placeholder="e.g. My game" />
          </label>
          <button type="submit" disabled={busy}>
            Host session
          </button>
        </form>

        <form className="card" onSubmit={join}>
          <h2>Join a session</h2>
          <p className="muted">Paste the invite code the host sent you.</p>
          <label className="field">
            <span>Invite code</span>
            <textarea value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="pct1.…" rows={3} />
          </label>
          <button type="submit" disabled={busy || !invite.trim()}>
            Join session
          </button>
        </form>
      </div>
    </main>
  );
}

function SavedSessionRow({
  session,
  busy,
  onResume,
  onForget,
}: {
  session: SavedSessionInfo;
  busy: boolean;
  onResume: (key: string) => void;
  onForget: (key: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const hosted = session.role === 'host';
  const copy = () => {
    if (!session.invite) return;
    window.pct.copyText(session.invite);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const details = [session.repo, session.folder, lastUsed(session.lastUsedAt)].filter(Boolean);

  return (
    <li className="resume-row">
      <div className="resume-info">
        <div className="resume-title">
          <strong>{session.name}</strong>
          <span className={hosted ? 'badge badge-exclusive' : 'badge'}>{hosted ? 'You host' : 'Joined'}</span>
        </div>
        {details.length > 0 && <div className="muted resume-details">{details.join(' · ')}</div>}
      </div>
      <div className="resume-actions">
        {session.invite && (
          <button type="button" className="secondary" onClick={copy} title="Copy the invite code">
            {copied ? 'Copied' : 'Copy invite'}
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => onResume(session.key)}>
          {hosted ? 'Resume' : 'Rejoin'}
        </button>
        <button type="button" className="link" onClick={() => onForget(session.key)} title={hosted ? 'Delete this session from this PC' : 'Remove from this list'}>
          {hosted ? 'Delete' : 'Forget'}
        </button>
      </div>
    </li>
  );
}

function lastUsed(at: number): string | null {
  if (!at) return null;
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days < 1) return 'used today';
  if (days === 1) return 'used yesterday';
  if (days < 30) return `used ${days} days ago`;
  return `used ${new Date(at).toLocaleDateString()}`;
}

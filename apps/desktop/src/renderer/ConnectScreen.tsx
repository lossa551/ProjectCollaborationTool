import { useState, type FormEvent } from 'react';
import type { Result } from '../common/api';
import { recall, remember } from './storage';
import { UpdateButton } from './UpdateButton';

export function ConnectScreen({ error }: { error: string | null }) {
  const [name, setName] = useState(() => recall('name'));
  const [sessionName, setSessionName] = useState(() => recall('sessionName'));
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const run = async (event: FormEvent, action: () => Promise<Result>) => {
    event.preventDefault();
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

      <div className="connect-options">
        <form className="card" onSubmit={host}>
          <h2>Host on this PC</h2>
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

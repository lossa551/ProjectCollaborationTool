import { useEffect, useState } from 'react';
import type { UpdateInfo } from '../common/api';
import './update.css';

// New versions download in the background, so most of the time this is a
// quiet version label. Once an update is ready it turns into a restart button.
export function UpdateButton({ hosting }: { hosting: boolean }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    void window.pct.getUpdate().then(setInfo);
    return window.pct.onUpdate(setInfo);
  }, []);

  if (!info) return null;
  const { state, version } = info;

  const update = () => {
    const restarting = state.status === 'ready';
    if (restarting && hosting && !window.confirm('Restarting ends the session for everyone until you host again. Update now?')) return;
    void window.pct.update();
  };

  switch (state.status) {
    case 'ready':
      return (
        <button className="update update-ready" onClick={update} title={`You have v${version}`}>
          Restart to update to v{state.version}
        </button>
      );
    case 'downloading':
      return (
        <button className="secondary update" disabled title={`Downloading v${state.version}`}>
          Downloading update {state.percent}%
        </button>
      );
    case 'checking':
      return (
        <button className="secondary update" disabled>
          Checking for updates…
        </button>
      );
    case 'error':
      return (
        <button className="secondary update" onClick={update} title={state.message}>
          Update check failed, retry
        </button>
      );
    case 'unavailable':
      return (
        <button className="secondary update" disabled title={state.message}>
          v{version} (dev build)
        </button>
      );
    default:
      return (
        <button className="secondary update" onClick={update} title={state.status === 'up-to-date' ? 'You have the latest version' : undefined}>
          v{version} · Check for updates
        </button>
      );
  }
}

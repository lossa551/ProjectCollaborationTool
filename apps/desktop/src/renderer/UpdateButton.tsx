import { useEffect, useState } from 'react';
import type { UpdateChannel, UpdateInfo } from '../common/api';
import './update.css';
import { ask } from './Dialog';

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

  const update = async () => {
    const restarting = state.status === 'ready';
    if (restarting && hosting && !(await ask('Restarting ends the session for everyone until you host again. Update now?', { confirm: 'Restart and update' }))) return;
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

const CHANNELS: { id: UpdateChannel; label: string; detail: string }[] = [
  { id: 'stable', label: 'Stable', detail: 'Releases from main. Tested work only.' },
  { id: 'beta', label: 'Beta', detail: 'Also previews from the beta branch, like Unreal support, as soon as they are pushed.' },
];

async function chooseChannel(info: UpdateInfo, channel: UpdateChannel) {
  if (channel === info.channel) return;
  const sure =
    channel === 'beta'
      ? await ask('Get beta updates on this PC?', {
          detail:
            'Betas have work that is not tested yet. To share a session, both PCs need the same protocol (shown below), so your friend may need beta too. You can switch back to Stable at any time.',
          confirm: 'Switch to Beta',
        })
      : await ask('Go back to stable updates?', {
          detail: /-beta\./.test(info.version)
            ? `You are on beta v${info.version}. The app downloads the latest stable release and installs it when you restart. Sessions hosted on beta may not open on stable until stable catches up.`
            : 'Beta previews stop arriving. Your current version stays until the next stable release.',
          confirm: 'Switch to Stable',
        });
  if (sure) await window.pct.setUpdateChannel(channel);
}

// Settings: the numbers to give when something does not work, and which
// releases this PC follows. Both PCs need the same protocol to join a session;
// see docs/releasing.md.
export function VersionSettings() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    void window.pct.getUpdate().then(setInfo);
    return window.pct.onUpdate(setInfo);
  }, []);

  if (!info) return null;
  return (
    <section className="card version-settings">
      <h2>Versions</h2>
      <dl>
        <dt>App</dt>
        <dd>v{info.version}</dd>
        <dt>Update channel</dt>
        <dd className="update-channels">
          {CHANNELS.map((channel) => (
            <label key={channel.id}>
              <input type="radio" name="update-channel" checked={info.channel === channel.id} onChange={() => void chooseChannel(info, channel.id)} />
              <strong>{channel.label}</strong> <span className="muted small">{channel.detail}</span>
            </label>
          ))}
        </dd>
        <dt>Protocol</dt>
        <dd>
          {info.protocol} <span className="muted small">Both PCs need the same one to join a session.</span>
        </dd>
        <dt>Database</dt>
        <dd>
          {info.database} <span className="muted small">Older session files are upgraded when the host opens them.</span>
        </dd>
      </dl>
    </section>
  );
}

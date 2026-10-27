import { NOTICE_KINDS } from '@pct/shared';
import type { AppState } from '../common/api';

// Settings: which Windows notifications this PC shows (issue #35). They only
// pop up while the app is in the background; with the window in front, the
// Home count shows what needs you instead.

export function NotificationSettings({ state }: { state: AppState }) {
  const muted = new Set(state.mutedNotices);
  return (
    <section className="card notice-settings">
      <header className="row">
        <div className="grow">
          <h2>Notifications</h2>
          <p className="muted small">
            Windows notifications show only while the app is minimised or in the background. Click one to open what it is
            about. These choices are kept on this PC.
          </p>
        </div>
        <button className="secondary" onClick={() => window.pct.testNotice()}>
          Send a test
        </button>
      </header>
      <ul className="notice-kinds">
        {NOTICE_KINDS.map(({ kind, label, detail }) => (
          <li key={kind}>
            <label className="check">
              <input type="checkbox" checked={!muted.has(kind)} onChange={(e) => window.pct.setNoticeMuted(kind, !e.target.checked)} />
              <span>
                <strong>{label}</strong>
                <span className="muted small"> {detail}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

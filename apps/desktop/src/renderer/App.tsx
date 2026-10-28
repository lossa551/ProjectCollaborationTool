import { useEffect, useState } from 'react';
import type { AppState } from '../common/api';
import { ConnectScreen } from './ConnectScreen';
import { DialogHost } from './Dialog';
import { SessionScreen } from './SessionScreen';

export function App() {
  const [state, setState] = useState<AppState | null>(null);

  useEffect(() => {
    void window.pct.getState().then(setState);
    return window.pct.onState(setState);
  }, []);

  useIdlePresence(state?.session.status === 'connected');

  if (!state) return null;
  const { status } = state.session;
  const inSession = status === 'connected' || status === 'reconnecting' || status === 'connecting';
  return (
    <>
      {inSession ? <SessionScreen state={state} /> : <ConnectScreen error={state.session.error?.message ?? null} />}
      <DialogHost />
    </>
  );
}

/** Marks you idle when the window is in the background. */
function useIdlePresence(connected: boolean) {
  useEffect(() => {
    if (!connected) return;
    const update = () => window.pct.setPresence(document.hasFocus() ? 'active' : 'idle', null);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    update();
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, [connected]);
}

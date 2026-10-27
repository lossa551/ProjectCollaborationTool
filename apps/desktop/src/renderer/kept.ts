import { useCallback, useState } from 'react';

// Work in progress that should survive switching screens within a session
// (issue #62): a commit message being written, board and issue filters.
// Screens unmount when you leave them, so their state lives here instead.
// It is kept for the life of the window and starts over in another session.

const values = new Map<string, unknown>();
let scope: string | null = null;

/** Starts a fresh set of kept values when the session changes. */
export function keepFor(sessionId: string | null) {
  if (sessionId === scope) return;
  scope = sessionId;
  values.clear();
}

/** Like useState, but the value is still there when the screen comes back. */
export function useKept<T>(key: string, initial: T): [T, (next: T | ((previous: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => (values.has(key) ? (values.get(key) as T) : initial));
  const set = useCallback(
    (next: T | ((previous: T) => T)) =>
      setValue((previous) => {
        const value = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next;
        values.set(key, value);
        return value;
      }),
    [key],
  );
  return [value, set];
}

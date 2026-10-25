import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newIdentity } from '@pct/shared';

// The secret that makes you the same participant every time you join, so your
// tasks and locks stay yours across reconnects and restarts. It never leaves
// this PC except in the hello to the session server.

let cached: string | null = null;

export function loadIdentity(): string {
  if (cached) return cached;
  const file = join(app.getPath('userData'), 'identity.json');
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { identity?: unknown };
    if (typeof stored.identity === 'string' && stored.identity.length >= 16) cached = stored.identity;
  } catch {
    // First run, or an unreadable file: make a new identity below.
  }
  if (!cached) {
    cached = newIdentity();
    writeFileSync(file, JSON.stringify({ identity: cached }), { mode: 0o600 });
  }
  return cached;
}

/** Where the session you host on this PC is saved, so it survives restarts. */
export function hostedSessionPath(): string {
  return join(app.getPath('userData'), 'hosted-session.sqlite');
}

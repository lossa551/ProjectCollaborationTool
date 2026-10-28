import { app } from 'electron';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionSnapshot } from '@pct/shared';

// The last known state of each joined session, plus changes not yet sent,
// so the board is there (and editable) when the host PC is off, and offline
// changes survive closing the app. One file per session, so two projects
// hosted on the same PC keep their own copy.

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const cacheDir = () => join(app.getPath('userData'), 'cache');
const fileFor = (sessionId: string) => join(cacheDir(), `session-${hash(sessionId)}.json`);
/** Before sessions had their own file, the cache was saved per server address. */
const legacyFileFor = (url: string) => join(cacheDir(), `${hash(url)}.json`);

function read(file: string): SessionSnapshot | undefined {
  try {
    const parsed = SessionSnapshot.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The saved copy of a session. A copy saved by address before is used when
 * it belongs to this session; the next save moves it to the session's file.
 */
export function loadSnapshot(sessionId: string, url?: string): SessionSnapshot | undefined {
  const saved = read(fileFor(sessionId));
  if (saved || !url) return saved;
  const legacy = read(legacyFileFor(url));
  return legacy?.session.id === sessionId ? legacy : undefined;
}

export function saveSnapshot(snapshot: SessionSnapshot): void {
  const file = fileFor(snapshot.session.id);
  mkdirSync(cacheDir(), { recursive: true });
  // Write then rename, so a crash never leaves half a file.
  writeFileSync(`${file}.tmp`, JSON.stringify(snapshot));
  renameSync(`${file}.tmp`, file);
}

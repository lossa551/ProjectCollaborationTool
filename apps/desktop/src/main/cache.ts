import { app } from 'electron';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionSnapshot } from '@pct/shared';

// The last known state of each joined session, plus changes not yet sent,
// so the board is there (and editable) when the host PC is off, and offline
// changes survive closing the app. One file per server address.

function fileFor(url: string): string {
  const key = createHash('sha256').update(url).digest('hex').slice(0, 16);
  return join(app.getPath('userData'), 'cache', `${key}.json`);
}

export function loadSnapshot(url: string): SessionSnapshot | undefined {
  try {
    const parsed = SessionSnapshot.safeParse(JSON.parse(readFileSync(fileFor(url), 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function saveSnapshot(url: string, snapshot: SessionSnapshot): void {
  const file = fileFor(url);
  mkdirSync(join(app.getPath('userData'), 'cache'), { recursive: true });
  // Write then rename, so a crash never leaves half a file.
  writeFileSync(`${file}.tmp`, JSON.stringify(snapshot));
  renameSync(`${file}.tmp`, file);
}

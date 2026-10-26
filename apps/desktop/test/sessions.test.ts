import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEGACY_HOST_KEY, SessionHistory } from '../src/main/sessions';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'pct-sessions-'));
  dirs.push(dir);
  return dir;
}

const joined = (history: SessionHistory, url: string, extra: { sessionId?: string; lastUsedAt?: number } = {}) =>
  history.save({
    key: history.joinKey(url),
    role: 'join',
    sessionId: extra.sessionId ?? null,
    name: 'Game',
    invite: `pct1.${url}`,
    repo: null,
    ...(extra.lastUsedAt !== undefined && { lastUsedAt: extra.lastUsedAt }),
  });

describe('SessionHistory', () => {
  it('keeps hosted and joined sessions across restarts, most recent first', () => {
    const dir = folder();
    const history = new SessionHistory(dir);
    const hostKey = history.newHostKey();
    history.save({ key: hostKey, role: 'host', sessionId: 's1', name: 'My game', invite: 'pct1.host', repo: 'martin/game', lastUsedAt: 1 });
    joined(history, 'ws://friend:7420/ws', { lastUsedAt: 2 });

    const reopened = new SessionHistory(dir);
    expect(reopened.list().map((s) => s.role)).toEqual(['join', 'host']);
    expect(reopened.get(hostKey)).toMatchObject({ name: 'My game', invite: 'pct1.host', repo: 'martin/game' });
    if (process.platform !== 'win32') expect(statSync(join(dir, 'sessions.json')).mode & 0o077).toBe(0);
  });

  it('gives each hosted session its own file and keeps the old single file', () => {
    const history = new SessionHistory(folder());
    const a = history.hostFile(history.newHostKey());
    const b = history.hostFile(history.newHostKey());
    expect(a).not.toBe(b);
    expect(history.hostFile(LEGACY_HOST_KEY).endsWith('hosted-session.sqlite')).toBe(true);
  });

  it('updates details without moving the entry to the top', () => {
    const history = new SessionHistory(folder());
    joined(history, 'ws://a/ws', { lastUsedAt: 1 });
    joined(history, 'ws://b/ws', { lastUsedAt: 2 });
    history.update(history.joinKey('ws://a/ws'), { sessionId: 'sa', name: 'Renamed', repo: 'o/r' });
    expect(history.list()[1]).toMatchObject({ sessionId: 'sa', name: 'Renamed', repo: 'o/r', lastUsedAt: 1 });
  });

  it('replaces the older entry when the same session is joined through a new invite', () => {
    const history = new SessionHistory(folder());
    joined(history, 'ws://old/ws', { sessionId: 'same' });
    joined(history, 'ws://new/ws');
    history.update(history.joinKey('ws://new/ws'), { sessionId: 'same' });
    expect(history.list().map((s) => s.key)).toEqual([history.joinKey('ws://new/ws')]);
  });

  it('never drops hosted sessions when trimming old joined ones', () => {
    const history = new SessionHistory(folder());
    history.save({ key: 'host-1', role: 'host', sessionId: 'h', name: 'Mine', invite: null, repo: null, lastUsedAt: 0 });
    for (let i = 0; i < 25; i++) joined(history, `ws://s${i}/ws`, { lastUsedAt: i + 1 });
    const list = history.list();
    expect(list.filter((s) => s.role === 'join')).toHaveLength(20);
    expect(list.some((s) => s.key === 'host-1')).toBe(true);
  });

  it('deletes a hosted session file when it is forgotten', () => {
    const history = new SessionHistory(folder());
    const key = history.newHostKey();
    const file = history.hostFile(key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'db');
    writeFileSync(`${file}-wal`, 'wal');
    history.save({ key, role: 'host', sessionId: 's', name: 'Gone', invite: null, repo: null });
    history.forget(key);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}-wal`)).toBe(false);
    expect(history.get(key)).toBeNull();
  });

  it('lists the session hosted before the list existed', async () => {
    const dir = folder();
    writeFileSync(join(dir, 'hosted-session.sqlite'), 'db');
    const history = new SessionHistory(dir);
    expect(await history.adoptLegacyHost(async () => ({ id: 'old', name: 'Old game' }))).toBe(true);
    expect(history.get(LEGACY_HOST_KEY)).toMatchObject({ role: 'host', sessionId: 'old', name: 'Old game' });
    expect(await history.adoptLegacyHost(async () => ({ id: 'old', name: 'Old game' }))).toBe(false);
  });

  it('ignores a damaged file', () => {
    const dir = folder();
    writeFileSync(join(dir, 'sessions.json'), '{not json');
    expect(new SessionHistory(dir).list()).toEqual([]);
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify([{ key: '../x', role: 'host' }]));
    expect(new SessionHistory(dir).list()).toEqual([]);
  });
});

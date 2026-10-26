import { afterEach, describe, expect, it } from 'vitest';
import { SessionClient, newIdentity, type SessionState, type Workspace } from '@pct/shared';
import { MemoryStorage, startServer, type RunningServer } from '@pct/server';

let server: RunningServer | null = null;
const clients: SessionClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await server?.close();
  server = null;
});

function waitFor(client: SessionClient, check: (state: SessionState) => boolean, timeoutMs = 3000) {
  return new Promise<SessionState>((resolve, reject) => {
    if (check(client.getState())) return resolve(client.getState());
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`timed out; last state: ${JSON.stringify(client.getState())}`));
    }, timeoutMs);
    const stop = client.subscribe((state) => {
      if (!check(state)) return;
      clearTimeout(timer);
      stop();
      resolve(state);
    });
  });
}

async function join(name: string) {
  const client = new SessionClient({ backoff: [50] });
  clients.push(client);
  client.connect({ url: server!.localUrl, secret: server!.secret, name, identity: newIdentity() });
  await waitFor(client, (s) => s.status === 'connected');
  return client;
}

const feed = (state: SessionState) => state.activity.map((a) => `${a.actorName} ${a.text}`);

/** Just enough of GitHub for one repository with one open pull request. */
const fakeFetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input)).pathname;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const pull = {
    number: 3,
    title: 'Jump',
    html_url: 'https://github.com/martin/game/pull/3',
    state: 'open',
    merged_at: null,
    user: { login: 'friend' },
    head: { ref: 'jump', sha: 'j1' },
    base: { ref: 'main' },
    updated_at: '2026-10-26T10:00:00Z',
    mergeable: true,
  };
  if (path === '/repos/martin/game') return json({ default_branch: 'main' });
  if (path.endsWith('/branches')) return json([{ name: 'main', commit: { sha: 'm1' } }, { name: 'jump', commit: { sha: 'j1' } }]);
  if (path.endsWith('/pulls') && String(input).includes('state=open')) return json([pull]);
  if (path.endsWith('/pulls')) return json([]);
  if (path.endsWith('/pulls/3')) return json(pull);
  if (path.endsWith('/reviews')) return json([]);
  if (path.endsWith('/files')) return json([{ filename: 'scripts/jump.gd' }]);
  if (path.endsWith('/check-runs')) return json({ check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success', html_url: null }] });
  if (path.endsWith('/status')) return json({ statuses: [] });
  if (path.includes('/compare/')) return json({ ahead_by: 1, behind_by: 0, files: [{ filename: 'scripts/jump.gd' }] });
  return new Response('{}', { status: 404 });
}) as typeof fetch;

const workspace = (branch: string, paths: string[]): Workspace => ({
  branch,
  base: 'origin/main',
  files: paths.map((path) => ({ path, change: 'modified' as const })),
  truncated: false,
  updatedAt: Date.now(),
});

describe('GitHub status in a session', () => {
  it('links a repository, sends everyone its pull requests, and remembers the link', async () => {
    const storage = new MemoryStorage();
    storage.close = async () => {};
    const github = { token: 'tok', fetch: fakeFetch, apiUrl: 'https://api.test' };
    server = await startServer({ port: 0, host: '127.0.0.1', storage, github });
    const martin = await join('Martin');
    const friend = await join('Friend');

    martin.linkRepo({ owner: 'martin', name: 'game' });
    const seen = await waitFor(friend, (s) => s.github.pulls.length === 1);
    expect(seen.github).toMatchObject({ repo: { owner: 'martin', name: 'game' }, defaultBranch: 'main', authenticated: true });
    expect(seen.github.pulls[0]).toMatchObject({ number: 3, checks: 'success', mergeable: 'mergeable', files: ['scripts/jump.gd'] });
    await waitFor(friend, (s) => feed(s).includes('Martin linked the session to martin/game on GitHub'));

    // Linking a task to a branch works out how far that branch is from main.
    martin.createTask('Jumping');
    const task = (await waitFor(martin, (s) => s.tasks.length === 1)).tasks[0]!;
    martin.updateTask(task.id, { branch: 'jump' });
    const linked = await waitFor(friend, (s) => s.github.branches.find((b) => b.name === 'jump')?.ahead === 1);
    expect(linked.tasks[0]!.branch).toBe('jump');
    expect(feed(linked)).toContain('Martin linked "Jumping" to branch jump');

    await server.close();
    server = await startServer({ port: 0, host: '127.0.0.1', storage, github });
    const again = await join('Martin');
    await waitFor(again, (s) => s.github.repo?.name === 'game' && s.github.pulls.length === 1);
  });

  it('shares workspaces with everyone and forgets them when their owner leaves', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const martin = await join('Martin');
    const friend = await join('Friend');
    const martinId = martin.getState().you!.id;

    martin.setWorkspace(workspace('jump', ['scripts/jump.gd']));
    let seen = await waitFor(friend, (s) => !!s.workspaces[martinId]);
    expect(seen.workspaces[martinId]!.files).toEqual([{ path: 'scripts/jump.gd', change: 'modified' }]);

    // Someone joining later gets it in their welcome.
    const late = await join('Late');
    expect(late.getState().workspaces[martinId]?.branch).toBe('jump');

    martin.disconnect();
    seen = await waitFor(friend, (s) => !s.workspaces[martinId]);
    const third = await join('Third');
    expect(third.getState().workspaces).toEqual({});
  });

  it('sends your workspace again after a reconnect', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const martin = await join('Martin');
    const friend = await join('Friend');
    const martinId = martin.getState().you!.id;
    martin.setWorkspace(workspace('jump', ['a.gd']));
    await waitFor(friend, (s) => !!s.workspaces[martinId]);

    // Drop Martin's connection as a network hiccup would; his client reconnects by itself.
    (martin as unknown as { socket: WebSocket }).socket.close(4999, 'test drop');
    await waitFor(friend, (s) => !s.workspaces[martinId]);
    await waitFor(friend, (s) => s.workspaces[martinId]?.branch === 'jump');
  });
});

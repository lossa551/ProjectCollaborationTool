import { afterEach, describe, expect, it } from 'vitest';
import { SessionClient, newIdentity, type SessionState } from '@pct/shared';
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
      reject(new Error(`timed out; last state: ${JSON.stringify({ planning: client.getState().planning, memory: client.getState().memory })}`));
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

const ID = 'feature-000001';

describe('shared documents', () => {
  it('merges two people typing in the same feature at once', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const martin = await join('Martin');
    const friend = await join('Friend');

    expect(martin.editPlanning({ op: 'create', id: ID, kind: 'feature', title: 'Double jump' })).toBe(true);
    await waitFor(friend, (s) => s.planning.length === 1);
    martin.editPlanning({ op: 'text', id: ID, field: 'body', value: 'Jump again in the air.' });
    friend.editPlanning({ op: 'text', id: ID, field: 'requirements', value: 'Works with a controller' });
    await waitFor(friend, (s) => s.planning[0]?.body === 'Jump again in the air.');

    // Both change the same text before seeing each other's edit.
    martin.editPlanning({ op: 'text', id: ID, field: 'body', value: 'Jump again in the air. Once.' });
    friend.editPlanning({ op: 'text', id: ID, field: 'body', value: 'Players: jump again in the air.' });
    const merged = (s: SessionState) => s.planning[0]?.body === 'Players: jump again in the air. Once.';
    await waitFor(martin, merged);
    const state = await waitFor(friend, merged);
    expect(state.planning[0]).toMatchObject({ title: 'Double jump', kind: 'feature', requirements: 'Works with a controller', createdBy: 'Martin' });
    expect(martin.getState().activity.some((a) => a.text === 'added feature "Double jump" to the planning space')).toBe(true);
  });

  it('keeps memory edited offline and merges it on reconnect', async () => {
    const storage = new MemoryStorage();
    server = await startServer({ port: 0, host: '127.0.0.1', storage });
    const { port, secret } = server;
    const friend = await join('Friend');
    friend.editMemory({ op: 'create', id: 'memory-000001', kind: 'convention', title: 'Tabs in GDScript', body: 'Godot default.' });
    await waitFor(friend, (s) => s.activity.some((a) => a.text.includes('Tabs in GDScript')));

    await server.close();
    await waitFor(friend, (s) => s.status === 'reconnecting');
    expect(friend.editMemory({ op: 'create', id: 'memory-000002', kind: 'issue', title: 'Menu flickers on resize' })).toBe(true);
    friend.editMemory({ op: 'text', id: 'memory-000001', value: 'Godot default. Spaces only in JSON.' });
    expect(friend.getState().memory.map((e) => e.title)).toEqual(['Tabs in GDScript', 'Menu flickers on resize']);

    // The cache keeps offline edits across a restart of the app too.
    const snapshot = friend.getSnapshot()!;
    friend.disconnect();
    server = await startServer({ port, host: '127.0.0.1', secret, storage });
    const restarted = new SessionClient({ backoff: [50] });
    clients.push(restarted);
    restarted.connect({ url: server.localUrl, secret, name: 'Friend', identity: newIdentity() }, snapshot);
    expect(restarted.getState().memory).toHaveLength(2);
    await waitFor(restarted, (s) => s.status === 'connected');

    const martin = await join('Martin');
    const seen = await waitFor(martin, (s) => s.memory.length === 2 && s.memory[0]!.body.includes('Spaces'));
    expect(seen.memory.map((e) => e.kind)).toEqual(['convention', 'issue']);
  });

  it('records acceptance criteria results on tasks', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const martin = await join('Martin');
    const friend = await join('Friend');
    const taskId = martin.createTask('Double jump', {
      featureId: ID,
      criteria: [
        { id: 'c1', text: 'Second jump works in the air' },
        { id: 'c2', text: 'No third jump' },
      ],
    });
    await waitFor(friend, (s) => s.tasks.length === 1);
    expect(friend.getState().tasks[0]).toMatchObject({ featureId: ID, criteria: [{ state: 'untested' }, { state: 'untested' }] });

    friend.verifyCriterion(taskId, 'c1', 'verified', 'Tested with keyboard and pad');
    friend.verifyCriterion(taskId, 'c2', 'failing', 'Third jump still possible');
    const state = await waitFor(martin, (s) => s.tasks[0]?.criteria[1]?.state === 'failing');
    expect(state.tasks[0]!.criteria[0]).toMatchObject({ state: 'verified', evidence: 'Tested with keyboard and pad', by: 'Friend' });

    // Rewording a criterion means it needs testing again; the others keep their result.
    martin.updateTask(taskId, {
      criteria: [
        { id: 'c1', text: 'Second jump works in the air' },
        { id: 'c2', text: 'No third jump, even after a wall jump' },
      ],
    });
    const after = await waitFor(friend, (s) => s.tasks[0]?.criteria[1]?.text.includes('wall') === true);
    expect(after.tasks[0]!.criteria.map((c) => c.state)).toEqual(['verified', 'untested']);
  });

  it('shares the bloat check with everyone', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const martin = await join('Martin');
    const friend = await join('Friend');
    martin.shareBloat({
      ranBy: 'Martin',
      ranAt: 1,
      branch: 'main',
      scanned: 10,
      truncated: false,
      commit: null,
      trigger: 'manual',
      unusedPlugins: [],
      notPulled: [],
      notPulledCount: 0,
      skipped: [],
      previousAt: null,
      newKeys: [],
      duplicates: [{ reason: 'identical', paths: ['a.png', 'b.png'] }],
      unusedAssets: [],
      unusedGameFiles: [],
      epicLayout: [],
      unusedDependencies: [],
      folderNotes: [],
    });
    await waitFor(friend, (s) => s.bloat?.scanned === 10);
    const late = await join('Late');
    expect(late.getState().bloat?.duplicates).toHaveLength(1);
  });
});

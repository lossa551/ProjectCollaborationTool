import { describe, expect, it } from 'vitest';
import { GitHubWatcher, describeGitHubChanges } from '../src/github.js';
import type { GitHubStatus } from '@pct/shared';

const API = 'https://api.test';
const REPO = { owner: 'martin', name: 'game' };

/** A tiny fake of the GitHub REST API: routes by path, with ETags. */
function fakeGitHub(routes: Record<string, unknown>) {
  const calls: { path: string; auth: string | null; etag: string | null }[] = [];
  let status: { code: number; headers?: Record<string, string> } | null = null;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    const headers = new Headers(init?.headers);
    calls.push({ path, auth: headers.get('authorization'), etag: headers.get('if-none-match') });
    if (status) return new Response('{}', { status: status.code, headers: status.headers });
    const key = Object.keys(routes).find((route) => path === route || path.startsWith(`${route}?`));
    if (!key) return new Response('{"message":"Not Found"}', { status: 404 });
    const body = JSON.stringify(routes[key]);
    const etag = `"${body.length}-${hash(body)}"`;
    if (headers.get('if-none-match') === etag) return new Response(null, { status: 304 });
    return new Response(body, { status: 200, headers: { etag, 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return {
    fetch: fakeFetch,
    calls,
    routes,
    fail(code: number, headers?: Record<string, string>) {
      status = { code, headers };
    },
    recover() {
      status = null;
    },
  };
}

function hash(text: string) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

const base = `/repos/${REPO.owner}/${REPO.name}`;

function apiPull(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `Pull ${number}`,
    html_url: `https://github.com/martin/game/pull/${number}`,
    state: 'open',
    draft: false,
    merged_at: null,
    user: { login: 'lina' },
    head: { ref: `feature-${number}`, sha: `sha${number}` },
    base: { ref: 'main' },
    updated_at: '2026-10-26T10:00:00Z',
    requested_reviewers: [],
    requested_teams: [],
    ...extra,
  };
}

function standardRoutes() {
  return {
    [base]: { default_branch: 'main' },
    [`${base}/branches`]: [
      { name: 'main', commit: { sha: 'main1' } },
      { name: 'feature-7', commit: { sha: 'sha7' } },
      { name: 'player-jump', commit: { sha: 'jump1' } },
    ],
    [`${base}/pulls?state=open&sort=updated&direction=desc&per_page=30`]: [apiPull(7, { mergeable: null })],
    [`${base}/pulls?state=closed&sort=updated&direction=desc&per_page=20`]: [
      apiPull(5, { state: 'closed', merged_at: '2026-10-25T10:00:00Z', head: { ref: 'old', sha: 'old1' } }),
      apiPull(4, { state: 'closed', head: { ref: 'abandoned', sha: 'ab1' } }),
    ],
    [`${base}/pulls/7`]: apiPull(7, { mergeable: false }),
    [`${base}/pulls/7/reviews`]: [
      { user: { login: 'martin' }, state: 'CHANGES_REQUESTED' },
      { user: { login: 'martin' }, state: 'COMMENTED' },
      { user: { login: 'martin' }, state: 'APPROVED' },
    ],
    [`${base}/pulls/7/files`]: [{ filename: 'scripts/player.gd' }, { filename: 'scenes/player.tscn' }],
    [`${base}/commits/sha7/check-runs`]: {
      check_runs: [
        { name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://ci/test' },
        { name: 'lint', status: 'completed', conclusion: 'failure', html_url: 'https://ci/lint' },
      ],
    },
    [`${base}/commits/sha7/status`]: { statuses: [{ context: 'deploy', state: 'pending', target_url: null }] },
    [`${base}/compare/main...player-jump`]: { ahead_by: 2, behind_by: 5, files: [{ filename: 'scripts/jump.gd' }] },
  };
}

function watcher(gh: ReturnType<typeof fakeGitHub>, token: string | null = 'tok', linked: string[] = []) {
  const changes: GitHubStatus[] = [];
  const w = new GitHubWatcher({ token, fetch: gh.fetch, apiUrl: API }, (status) => changes.push(status), () => linked);
  return { w, changes };
}

describe('GitHub watcher', () => {
  it('collects branches, pull requests, reviews, checks and conflicts', async () => {
    const gh = fakeGitHub(standardRoutes());
    const { w, changes } = watcher(gh, 'tok', ['player-jump']);
    w.setRepo(REPO);
    await w.refresh();
    const status = w.getStatus();

    expect(status.error).toBeNull();
    expect(status.defaultBranch).toBe('main');
    expect(status.authenticated).toBe(true);
    expect(status.branches.find((b) => b.name === 'player-jump')).toMatchObject({ ahead: 2, behind: 5, files: ['scripts/jump.gd'] });
    expect(status.branches.find((b) => b.name === 'feature-7')).toMatchObject({ ahead: null, files: null });

    const [open, merged, closed] = status.pulls;
    expect(open).toMatchObject({
      number: 7,
      state: 'open',
      branch: 'feature-7',
      mergeable: 'conflicting',
      // Martin's latest decision was an approval; the comment after it does not count.
      review: 'approved',
      checks: 'failure',
      files: ['scripts/player.gd', 'scenes/player.tscn'],
    });
    expect(open!.checkRuns.map((r) => [r.name, r.state])).toEqual([
      ['test', 'success'],
      ['lint', 'failure'],
      ['deploy', 'pending'],
    ]);
    expect(merged).toMatchObject({ number: 5, state: 'merged' });
    expect(closed).toMatchObject({ number: 4, state: 'closed' });
    expect(gh.calls.every((c) => c.auth === 'Bearer tok')).toBe(true);
    expect(changes.at(-1)).toEqual(status);
    w.stop();
  });

  it('asks again with ETags and only fetches pull request details that changed', async () => {
    const gh = fakeGitHub(standardRoutes());
    const { w, changes } = watcher(gh);
    w.setRepo(REPO);
    await w.refresh();
    const published = changes.length;
    gh.calls.length = 0;

    await w.refresh();
    const paths = gh.calls.map((c) => c.path.split('?')[0]);
    // Reviews and files are only fetched again when the pull request changes.
    expect(paths).not.toContain(`${base}/pulls/7/reviews`);
    expect(paths).not.toContain(`${base}/pulls/7/files`);
    // Checks are still running (one is pending), so they are looked at again.
    expect(paths).toContain(`${base}/commits/sha7/check-runs`);
    expect(gh.calls.filter((c) => c.path === base)[0]?.etag).toBeTruthy();
    // Nothing changed, so nothing new is published.
    expect(changes.length).toBe(published);
    w.stop();
  });

  it('keeps the last good data and explains errors', async () => {
    const gh = fakeGitHub(standardRoutes());
    const { w } = watcher(gh, null);
    w.setRepo(REPO);
    await w.refresh();
    expect(w.getStatus().authenticated).toBe(false);

    gh.fail(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) });
    await w.refresh();
    expect(w.getStatus().error).toMatch(/rate limit.*token/i);
    expect(w.getStatus().pulls).toHaveLength(3);

    // While rate limited it does not ask again.
    gh.calls.length = 0;
    await w.refresh();
    expect(gh.calls).toHaveLength(0);
    w.stop();
  });

  it('says when the repository cannot be found or the token is refused', async () => {
    const gh = fakeGitHub({});
    const { w } = watcher(gh, null);
    w.setRepo({ owner: 'martin', name: 'secret' });
    await w.refresh();
    expect(w.getStatus().error).toMatch(/Can't find martin\/secret.*private.*token/);

    gh.fail(401);
    w.setToken('bad');
    await w.refresh();
    expect(w.getStatus().error).toMatch(/refused the token/);
    w.stop();
  });

  it('starts over when the repository changes', async () => {
    const gh = fakeGitHub(standardRoutes());
    const { w } = watcher(gh);
    w.setRepo(REPO);
    await w.refresh();
    w.setRepo(null);
    expect(w.getStatus()).toMatchObject({ repo: null, pulls: [], branches: [] });
    w.stop();
  });
});

describe('describeGitHubChanges', () => {
  const pull = (patch: Partial<GitHubStatus['pulls'][number]>) => ({
    number: 7,
    title: 'Jump',
    url: '',
    state: 'open' as const,
    draft: false,
    author: 'lina',
    branch: 'jump',
    base: 'main',
    mergeable: 'mergeable' as const,
    review: 'none' as const,
    checks: 'pending' as const,
    checkRuns: [],
    files: [],
    updatedAt: 1,
    ...patch,
  });
  const status = (pulls: GitHubStatus['pulls']): GitHubStatus => ({
    repo: REPO,
    defaultBranch: 'main',
    authenticated: true,
    error: null,
    fetchedAt: 1,
    branches: [],
    pulls,
  });

  it('describes opened, failed, conflicting, approved and merged pull requests', () => {
    expect(describeGitHubChanges(status([]), status([pull({})]))).toEqual([{ text: 'lina opened PR #7 "Jump"', branch: 'jump' }]);
    expect(
      describeGitHubChanges(status([pull({})]), status([pull({ checks: 'failure', mergeable: 'conflicting', review: 'approved' })])).map((c) => c.text),
    ).toEqual(['checks failed on PR #7 "Jump"', 'PR #7 "Jump" has merge conflicts', 'PR #7 "Jump" was approved']);
    expect(describeGitHubChanges(status([pull({})]), status([pull({ state: 'merged' })])).map((c) => c.text)).toEqual(['PR #7 "Jump" was merged']);
  });

  it('says nothing about the first poll', () => {
    expect(describeGitHubChanges({ ...status([]), fetchedAt: null }, status([pull({})]))).toEqual([]);
  });
});

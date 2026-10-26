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

function apiIssue(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    html_url: `https://github.com/martin/game/issues/${number}`,
    body: 'Steps to reproduce',
    user: { login: 'lina' },
    labels: [{ name: 'bug', color: 'd73a4a' }],
    assignees: [{ login: 'martin' }],
    comments: 2,
    created_at: '2026-10-26T09:00:00Z',
    updated_at: '2026-10-26T10:00:00Z',
    ...extra,
  };
}

describe('GitHub issues', () => {
  it('reads open issues and leaves pull requests out', async () => {
    const routes = {
      ...standardRoutes(),
      [`${base}/issues`]: [apiIssue(12), apiIssue(7, { pull_request: { url: 'x' } }), apiIssue(3, { labels: ['old'], assignees: [], body: null })],
    };
    const gh = fakeGitHub(routes);
    const { w } = watcher(gh);
    w.setRepo(REPO);
    await w.refresh();
    const { issues } = w.getStatus();
    expect(issues.map((i) => i.number)).toEqual([12, 3]);
    expect(issues[0]).toMatchObject({
      title: 'Issue 12',
      author: 'lina',
      labels: [{ name: 'bug', color: 'd73a4a' }],
      assignees: ['martin'],
      body: 'Steps to reproduce',
      comments: 2,
      createdAt: Date.parse('2026-10-26T09:00:00Z'),
    });
    expect(issues[1]).toMatchObject({ labels: [{ name: 'old' }], assignees: [], body: '' });
    w.stop();
  });

  it('reads further pages while they are full', async () => {
    const first = Array.from({ length: 100 }, (_, i) => apiIssue(1000 - i));
    const gh = fakeGitHub({ ...standardRoutes(), [`${base}/issues`]: first });
    const fetchPage = gh.fetch;
    // The fake routes ignore the query, so answer the second page by hand.
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/issues?') && String(input).endsWith('page=2')) return Response.json([apiIssue(5)]);
      return fetchPage(input, init);
    }) as typeof globalThis.fetch;
    const w = new GitHubWatcher({ token: 'tok', fetch, apiUrl: API }, () => {});
    w.setRepo(REPO);
    await w.refresh();
    expect(w.getStatus().issues).toHaveLength(101);
    expect(w.getStatus().issues.at(-1)!.number).toBe(5);
    w.stop();
  });

  it('shows no issues when the repository has them turned off', async () => {
    const gh = fakeGitHub(standardRoutes());
    const { w } = watcher(gh);
    w.setRepo(REPO);
    await w.refresh();
    expect(w.getStatus().error).toBeNull();
    expect(w.getStatus().issues).toEqual([]);
    w.stop();
  });

  it('opens and closes issues with the token, commenting before it closes', async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const gh = fakeGitHub(standardRoutes());
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return gh.fetch(input, init);
      const path = new URL(String(input)).pathname;
      calls.push({ method, path, body: JSON.parse(String(init!.body)) });
      if (path.endsWith('/comments')) return Response.json({ id: 1 }, { status: 201 });
      if (method === 'POST') return Response.json(apiIssue(44), { status: 201 });
      return Response.json(apiIssue(12));
    }) as typeof globalThis.fetch;
    const w = new GitHubWatcher({ token: 'tok', fetch, apiUrl: API }, () => {});
    w.setRepo(REPO);

    expect(await w.createIssue('Wall jump', 'Plan')).toEqual({ number: 44, url: 'https://github.com/martin/game/issues/44' });
    expect(await w.closeIssue(12, 'Done in #9')).toMatchObject({ number: 12 });
    expect(calls).toEqual([
      { method: 'POST', path: `${base}/issues`, body: { title: 'Wall jump', body: 'Plan' } },
      { method: 'POST', path: `${base}/issues/12/comments`, body: { body: 'Done in #9' } },
      { method: 'PATCH', path: `${base}/issues/12`, body: { state: 'closed', state_reason: 'completed' } },
    ]);
    w.stop();
  });

  it('explains why an issue could not be changed', async () => {
    const gh = fakeGitHub(standardRoutes());
    const anonymous = watcher(gh, null).w;
    anonymous.setRepo(REPO);
    await expect(anonymous.createIssue('x', '')).rejects.toThrow(/needs a GitHub token/);

    const fetch = (async () => Response.json({ message: 'Resource not accessible' }, { status: 403 })) as typeof globalThis.fetch;
    const readOnly = new GitHubWatcher({ token: 'tok', fetch, apiUrl: API }, () => {});
    readOnly.setRepo(REPO);
    await expect(readOnly.closeIssue(3, 'done')).rejects.toThrow(/Issues: read and write/);
    anonymous.stop();
    readOnly.stop();
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
    issues: [],
  });

  it('describes opened, failed, conflicting, approved and merged pull requests', () => {
    expect(describeGitHubChanges(status([]), status([pull({})]))).toEqual([{ text: 'lina opened PR #7 "Jump"', branch: 'jump' }]);
    expect(
      describeGitHubChanges(status([pull({})]), status([pull({ checks: 'failure', mergeable: 'conflicting', review: 'approved' })])).map((c) => c.text),
    ).toEqual(['checks failed on PR #7 "Jump"', 'PR #7 "Jump" has merge conflicts', 'PR #7 "Jump" was approved']);
    expect(describeGitHubChanges(status([pull({})]), status([pull({ state: 'merged' })])).map((c) => c.text)).toEqual(['PR #7 "Jump" was merged']);
  });

  it('mentions issues opened since the last poll', () => {
    const issue = (number: number, createdAt: number) => ({
      number,
      title: `Bug ${number}`,
      url: '',
      author: 'lina',
      labels: [],
      assignees: [],
      body: '',
      comments: 0,
      createdAt,
      updatedAt: createdAt,
    });
    const before = { ...status([]), fetchedAt: 100, issues: [issue(1, 50)] };
    const after = { ...status([]), fetchedAt: 200, issues: [issue(1, 50), issue(2, 150), issue(3, 20)] };
    expect(describeGitHubChanges(before, after)).toEqual([{ text: 'lina opened issue #2 "Bug 2"', branch: null }]);
  });

  it('says nothing about the first poll', () => {
    expect(describeGitHubChanges({ ...status([]), fetchedAt: null }, status([pull({})]))).toEqual([]);
  });
});

import {
  EMPTY_GITHUB_STATUS,
  type Branch,
  type CheckRun,
  type CheckState,
  type GitHubStatus,
  type PullRequest,
  type RepoRef,
} from '@pct/shared';

// Polls the GitHub REST API for the session's repository: branches, pull
// requests with their reviews, checks and merge conflicts. Responses are
// cached by ETag, so an unchanged answer costs nothing against the rate limit
// when a token is set. Without a token (public repositories only) GitHub
// allows 60 requests an hour, so it polls rarely and only fetches pull
// request details that changed.

export interface GitHubOptions {
  /** Personal access token with read access to contents, pull requests and checks. */
  token?: string | null;
  fetch?: typeof fetch;
  apiUrl?: string;
  /** Poll interval with a token. Default 60 s. */
  pollMs?: number;
  /** Poll interval without a token. Default 10 min. */
  anonymousPollMs?: number;
}

/** Most open pull requests looked at in detail. */
const MAX_OPEN_PULLS = 30;
const CLOSED_PULLS = 20;

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly retryAt: number | null = null,
  ) {
    super(message);
  }
}

interface PullDetail {
  key: string;
  baseSha: string;
  mergeable: PullRequest['mergeable'];
  review: PullRequest['review'];
  files: string[];
}

interface ChecksDetail {
  sha: string;
  checks: CheckState;
  checkRuns: CheckRun[];
}

interface CompareDetail {
  key: string;
  ahead: number;
  behind: number;
  files: string[];
}

// Just the fields we read from GitHub's answers.
interface ApiRepo {
  default_branch: string;
}
interface ApiBranch {
  name: string;
  commit: { sha: string };
}
interface ApiPull {
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  draft?: boolean;
  merged_at: string | null;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  updated_at: string;
  mergeable?: boolean | null;
  requested_reviewers?: unknown[];
  requested_teams?: unknown[];
}
interface ApiReview {
  user: { login: string } | null;
  state: string;
}
interface ApiCheckRuns {
  check_runs: { name: string; status: string; conclusion: string | null; html_url: string | null }[];
}
interface ApiStatus {
  statuses: { context: string; state: string; target_url: string | null }[];
}
interface ApiCompare {
  ahead_by: number;
  behind_by: number;
  files?: { filename: string }[];
}

export class GitHubWatcher {
  private repo: RepoRef | null = null;
  private token: string | null;
  private status: GitHubStatus;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private stopped = true;
  private readonly fetch: typeof fetch;
  private readonly apiUrl: string;
  private readonly pollMs: number;
  private readonly anonymousPollMs: number;
  private readonly etags = new Map<string, { etag: string; body: unknown }>();
  private readonly pullDetails = new Map<number, PullDetail>();
  private readonly checks = new Map<number, ChecksDetail>();
  private readonly compares = new Map<string, CompareDetail>();
  private retryAt = 0;

  constructor(
    options: GitHubOptions,
    private readonly onStatus: (status: GitHubStatus, previous: GitHubStatus) => void,
    /** Branches linked to tasks; ahead/behind and changed files are worked out for these. */
    private readonly linkedBranches: () => string[] = () => [],
  ) {
    this.token = options.token || null;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.pollMs = options.pollMs ?? 60_000;
    this.anonymousPollMs = options.anonymousPollMs ?? 600_000;
    this.status = { ...EMPTY_GITHUB_STATUS, authenticated: !!this.token };
  }

  getStatus(): GitHubStatus {
    return this.status;
  }

  start(): void {
    this.stopped = false;
    void this.refresh();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  setRepo(repo: RepoRef | null): void {
    if (sameRepo(repo, this.repo)) return;
    this.repo = repo;
    this.clearCaches();
    this.publish({ ...EMPTY_GITHUB_STATUS, repo, authenticated: !!this.token });
    if (!this.stopped) void this.refresh();
  }

  setToken(token: string | null): void {
    if ((token || null) === this.token) return;
    this.token = token || null;
    this.clearCaches();
    this.publish({ ...this.status, authenticated: !!this.token, error: null });
    if (!this.stopped) void this.refresh();
  }

  /** Polls now (or right after the poll in progress) and waits for it. */
  async refresh(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.running = (async () => {
      do {
        this.rerun = false;
        await this.pollOnce();
      } while (this.rerun && !this.stopped);
    })();
    try {
      await this.running;
    } finally {
      this.running = null;
      this.schedule();
    }
  }

  private schedule() {
    if (this.stopped || !this.repo) return;
    const interval = this.token ? this.pollMs : this.anonymousPollMs;
    const delay = Math.max(interval, this.retryAt - Date.now());
    this.timer = setTimeout(() => void this.refresh(), delay);
    this.timer.unref?.();
  }

  private clearCaches() {
    this.etags.clear();
    this.pullDetails.clear();
    this.checks.clear();
    this.compares.clear();
    this.retryAt = 0;
  }

  private publish(next: GitHubStatus) {
    const previous = this.status;
    this.status = next;
    if (JSON.stringify(stripTime(previous)) !== JSON.stringify(stripTime(next))) this.onStatus(next, previous);
  }

  private async pollOnce(): Promise<void> {
    const repo = this.repo;
    if (!repo) return;
    if (Date.now() < this.retryAt) return;
    try {
      const next = await this.collect(repo);
      if (sameRepo(repo, this.repo)) this.publish(next);
    } catch (error) {
      if (!sameRepo(repo, this.repo)) return;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof GitHubError && error.retryAt) this.retryAt = error.retryAt;
      this.publish({ ...this.status, error: message });
    }
  }

  private async collect(repo: RepoRef): Promise<GitHubStatus> {
    const base = `/repos/${repo.owner}/${repo.name}`;
    const info = await this.get<ApiRepo>(base);
    const defaultBranch = info.default_branch;
    const apiBranches = await this.get<ApiBranch[]>(`${base}/branches?per_page=100`);
    const openPulls = await this.get<ApiPull[]>(`${base}/pulls?state=open&sort=updated&direction=desc&per_page=${MAX_OPEN_PULLS}`);
    const closedPulls = await this.get<ApiPull[]>(`${base}/pulls?state=closed&sort=updated&direction=desc&per_page=${CLOSED_PULLS}`);
    const defaultSha = apiBranches.find((b) => b.name === defaultBranch)?.commit.sha ?? '';

    const pulls: PullRequest[] = [];
    for (const pull of openPulls) pulls.push(await this.openPull(base, pull, defaultSha));
    for (const pull of closedPulls) pulls.push(summary(pull));

    const linked = new Set(this.linkedBranches());
    const branches: Branch[] = [];
    for (const branch of apiBranches) {
      const compare =
        linked.has(branch.name) && branch.name !== defaultBranch && defaultSha
          ? await this.compare(base, defaultBranch, defaultSha, branch)
          : null;
      branches.push({
        name: branch.name,
        sha: branch.commit.sha,
        ahead: compare?.ahead ?? null,
        behind: compare?.behind ?? null,
        files: compare?.files ?? null,
      });
    }
    // Forget pull requests that are no longer open.
    const open = new Set(openPulls.map((p) => p.number));
    for (const number of [...this.pullDetails.keys()]) if (!open.has(number)) this.pullDetails.delete(number);
    for (const number of [...this.checks.keys()]) if (!open.has(number)) this.checks.delete(number);

    return {
      repo,
      defaultBranch,
      authenticated: !!this.token,
      error: null,
      fetchedAt: Date.now(),
      branches,
      pulls,
    };
  }

  private async openPull(base: string, pull: ApiPull, defaultSha: string): Promise<PullRequest> {
    const key = `${pull.head.sha}|${pull.updated_at}`;
    let detail = this.pullDetails.get(pull.number);
    // Mergeability also changes when the base branch moves, and GitHub
    // answers "unknown" while it is still working it out.
    if (!detail || detail.key !== key || detail.baseSha !== defaultSha || detail.mergeable === 'unknown') {
      const full = await this.get<ApiPull>(`${base}/pulls/${pull.number}`);
      const sameKey = detail?.key === key;
      const reviews = sameKey && detail ? null : await this.get<ApiReview[]>(`${base}/pulls/${pull.number}/reviews?per_page=100`);
      const files =
        sameKey && detail
          ? detail.files
          : (await this.get<{ filename: string }[]>(`${base}/pulls/${pull.number}/files?per_page=100`)).map((f) => f.filename);
      detail = {
        key,
        baseSha: defaultSha,
        mergeable: full.mergeable === true ? 'mergeable' : full.mergeable === false ? 'conflicting' : 'unknown',
        review: reviews ? reviewState(reviews, full) : (detail?.review ?? 'none'),
        files,
      };
      this.pullDetails.set(pull.number, detail);
    }

    let checks = this.checks.get(pull.number);
    // Checks change without the pull request changing, so look again while
    // they run (and, with a token, also before they have started).
    const running = checks?.checkRuns.some((r) => r.state === 'pending');
    if (!checks || checks.sha !== pull.head.sha || running || (checks.checks === 'none' && this.token)) {
      checks = { sha: pull.head.sha, ...(await this.fetchChecks(base, pull.head.sha)) };
      this.checks.set(pull.number, checks);
    }

    return {
      ...summary(pull),
      mergeable: detail.mergeable,
      review: detail.review,
      checks: checks.checks,
      checkRuns: checks.checkRuns,
      files: detail.files,
    };
  }

  private async fetchChecks(base: string, sha: string): Promise<{ checks: CheckState; checkRuns: CheckRun[] }> {
    const runs = await this.get<ApiCheckRuns>(`${base}/commits/${sha}/check-runs?per_page=100`);
    const statuses = await this.get<ApiStatus>(`${base}/commits/${sha}/status`);
    const checkRuns: CheckRun[] = [
      ...runs.check_runs.map((run) => ({
        name: run.name,
        state: run.status !== 'completed' ? ('pending' as const) : FAILED.has(run.conclusion ?? '') ? ('failure' as const) : ('success' as const),
        url: run.html_url,
      })),
      ...statuses.statuses.map((status) => ({
        name: status.context,
        state: status.state === 'pending' ? ('pending' as const) : status.state === 'success' ? ('success' as const) : ('failure' as const),
        url: status.target_url,
      })),
    ];
    return { checks: rollUp(checkRuns), checkRuns };
  }

  private async compare(base: string, defaultBranch: string, defaultSha: string, branch: ApiBranch): Promise<CompareDetail> {
    const key = `${defaultSha}|${branch.commit.sha}`;
    const cached = this.compares.get(branch.name);
    if (cached?.key === key) return cached;
    const result = await this.get<ApiCompare>(`${base}/compare/${refPath(defaultBranch)}...${refPath(branch.name)}?per_page=1`);
    const detail = { key, ahead: result.ahead_by, behind: result.behind_by, files: (result.files ?? []).map((f) => f.filename) };
    this.compares.set(branch.name, detail);
    return detail;
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const cached = this.etags.get(url);
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'ProjectCollaborationTool',
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (cached) headers['if-none-match'] = cached.etag;

    let response: Response;
    try {
      response = await this.fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new GitHubError('Could not reach GitHub.');
    }
    if (response.status === 304 && cached) return cached.body as T;
    if (!response.ok) throw this.failure(response);
    const body = (await response.json()) as T;
    const etag = response.headers.get('etag');
    if (etag) this.etags.set(url, { etag, body });
    return body;
  }

  private failure(response: Response): GitHubError {
    const repo = this.repo ? `${this.repo.owner}/${this.repo.name}` : 'the repository';
    const remaining = response.headers.get('x-ratelimit-remaining');
    if ((response.status === 403 || response.status === 429) && remaining === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000 || Date.now() + 15 * 60_000;
      const time = new Date(reset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const hint = this.token ? '' : ' Adding a GitHub token on the host raises the limit.';
      return new GitHubError(`GitHub's rate limit was reached; updates resume at ${time}.${hint}`, reset);
    }
    if (response.status === 401) return new GitHubError('GitHub refused the token. Check the token on the host.');
    if (response.status === 404 || response.status === 403) {
      return new GitHubError(
        this.token
          ? `Can't see ${repo} on GitHub. Check the name, and that the host's token has access to it.`
          : `Can't find ${repo} on GitHub. If it is private, the host needs to add a GitHub token.`,
      );
    }
    return new GitHubError(`GitHub answered with an error (${response.status}).`);
  }
}

function summary(pull: ApiPull): PullRequest {
  return {
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    state: pull.state === 'open' ? 'open' : pull.merged_at ? 'merged' : 'closed',
    draft: !!pull.draft,
    author: pull.user?.login ?? 'unknown',
    branch: pull.head.ref,
    base: pull.base.ref,
    mergeable: 'unknown',
    review: 'none',
    checks: 'none',
    checkRuns: [],
    files: [],
    updatedAt: Date.parse(pull.updated_at) || 0,
  };
}

/** Like GitHub's review decision: each reviewer's latest approve or change request counts. */
function reviewState(reviews: ApiReview[], pull: ApiPull): PullRequest['review'] {
  const latest = new Map<string, string>();
  for (const review of reviews) {
    if (!review.user || (review.state !== 'APPROVED' && review.state !== 'CHANGES_REQUESTED' && review.state !== 'DISMISSED')) continue;
    latest.set(review.user.login, review.state);
  }
  const states = [...latest.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if ((pull.requested_reviewers?.length ?? 0) + (pull.requested_teams?.length ?? 0) > 0) return 'review_required';
  if (states.includes('APPROVED')) return 'approved';
  return 'none';
}

function rollUp(runs: CheckRun[]): CheckState {
  if (runs.length === 0) return 'none';
  if (runs.some((r) => r.state === 'failure')) return 'failure';
  if (runs.some((r) => r.state === 'pending')) return 'pending';
  return 'success';
}

function refPath(name: string): string {
  return encodeURIComponent(name).replace(/%2F/g, '/');
}

function sameRepo(a: RepoRef | null, b: RepoRef | null): boolean {
  return a?.owner.toLowerCase() === b?.owner.toLowerCase() && a?.name.toLowerCase() === b?.name.toLowerCase();
}

function stripTime(status: GitHubStatus) {
  return { ...status, fetchedAt: null };
}

/** Lines for the activity feed about what changed on GitHub between two polls. */
export function describeGitHubChanges(previous: GitHubStatus, next: GitHubStatus): { text: string; branch: string }[] {
  if (!previous.fetchedAt || !sameRepo(previous.repo, next.repo) || !next.fetchedAt) return [];
  const lines: { text: string; branch: string }[] = [];
  const before = new Map(previous.pulls.map((p) => [p.number, p]));
  for (const pull of next.pulls) {
    const old = before.get(pull.number);
    const name = `PR #${pull.number} "${pull.title}"`;
    if (!old) {
      if (pull.state === 'open') lines.push({ text: `${pull.author} opened ${name}`, branch: pull.branch });
      else if (pull.state === 'merged') lines.push({ text: `${name} was merged`, branch: pull.branch });
      continue;
    }
    if (old.state !== pull.state) {
      const verb = pull.state === 'merged' ? 'was merged' : pull.state === 'closed' ? 'was closed' : 'was reopened';
      lines.push({ text: `${name} ${verb}`, branch: pull.branch });
      continue;
    }
    if (pull.state !== 'open') continue;
    if (old.checks !== pull.checks && (pull.checks === 'failure' || pull.checks === 'success')) {
      lines.push({ text: `checks ${pull.checks === 'failure' ? 'failed' : 'passed'} on ${name}`, branch: pull.branch });
    }
    if (old.mergeable !== 'conflicting' && pull.mergeable === 'conflicting') {
      lines.push({ text: `${name} has merge conflicts`, branch: pull.branch });
    }
    if (old.review !== pull.review && (pull.review === 'approved' || pull.review === 'changes_requested')) {
      lines.push({ text: `${name} ${pull.review === 'approved' ? 'was approved' : 'needs changes'}`, branch: pull.branch });
    }
  }
  return lines;
}

/** The token the GitHub CLI is signed in with, if it is installed; null otherwise. */
export async function tokenFromGitHubCli(): Promise<string | null> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      const token = String(stdout).trim();
      resolve(!error && /^[\w-]{20,}$/.test(token) ? token : null);
    });
  });
}

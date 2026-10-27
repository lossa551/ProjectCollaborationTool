import type { SessionState } from './client.js';
import { pullForBranch, type Issue, type PullRequest, type Task } from './model.js';
import { featureStage, linkKey, PLAN_TEXT_LIMIT, renderPlan, type IssueLinkKind, type PlanItem, type PlanOp } from './planning.js';

// GitHub issues in the app (issue #43). The server's poll brings in the open
// issues; links to features and tasks, triage and "keep open" live in the
// planning document (see IssueMarks). A feature or task is also linked to an
// issue its text mentions as "#123", unless someone unlinked it by hand.

type IssueInput = Pick<SessionState, 'planning' | 'tasks' | 'github' | 'issueMarks'>;

/** Issue numbers a text mentions as "#123" (not "abc#1" or "&#123;"). */
export function mentionedIssues(text: string): number[] {
  const out = new Set<number>();
  for (const match of text.matchAll(/(?<![\w&/#])#(\d{1,8})\b/g)) out.add(Number(match[1]));
  return [...out];
}

/** The text of a feature that can mention issues. */
function featureText(item: PlanItem): string {
  return [item.title, item.body, item.requirements, item.dependencies, item.criteria, item.tasks].join('\n');
}

export interface IssueLink {
  kind: IssueLinkKind;
  id: string;
  title: string;
  /** Linked by hand, or because its text mentions the issue. */
  by: 'hand' | 'mention';
}

type LinkInput = Pick<IssueInput, 'planning' | 'tasks' | 'issueMarks'>;

/**
 * What each issue is linked to, features first, then tasks. Covers every
 * issue someone linked or mentioned, open or not.
 */
export function issueLinks(input: LinkInput): Map<number, IssueLink[]> {
  const links = new Map<number, IssueLink[]>();
  const add = (number: number, link: IssueLink) => links.set(number, [...(links.get(number) ?? []), link]);
  const consider = (kind: IssueLinkKind, id: string, title: string, mentioned: number[]) => {
    const numbers = new Set(mentioned);
    for (const [key, marks] of Object.entries(input.issueMarks)) if (marks.links[linkKey(kind, id)] !== undefined) numbers.add(Number(key));
    for (const number of numbers) {
      const mark = input.issueMarks[number]?.links[linkKey(kind, id)];
      if (mark === true) add(number, { kind, id, title, by: 'hand' });
      else if (mark === undefined) add(number, { kind, id, title, by: 'mention' });
    }
  };
  for (const item of input.planning) if (item.kind !== 'note') consider('feature', item.id, item.title, mentionedIssues(featureText(item)));
  for (const task of input.tasks) consider('task', task.id, task.title, mentionedIssues(task.title));
  return links;
}

/** Open issues linked to a feature, directly or through one of its tasks. */
export function issuesOfFeature(input: IssueInput, item: PlanItem, links = issueLinks(input)): Issue[] {
  const own = new Set([item.id, ...input.tasks.filter((t) => t.featureId === item.id).map((t) => t.id)]);
  return input.github.issues.filter((issue) => (links.get(issue.number) ?? []).some((l) => own.has(l.id)));
}

/** Open issues linked to a task. */
export function issuesOfTask(input: IssueInput, task: Task, links = issueLinks(input)): Issue[] {
  return input.github.issues.filter((issue) => (links.get(issue.number) ?? []).some((l) => l.kind === 'task' && l.id === task.id));
}

/** Open issues nobody has linked to anything or marked as triaged. */
export function untriagedIssues(input: IssueInput, links = issueLinks(input)): Issue[] {
  return input.github.issues.filter((issue) => !input.issueMarks[issue.number]?.triaged && !links.get(issue.number)?.length);
}

/** Issues opened since a time, newest first. */
export function newIssues(input: Pick<IssueInput, 'github'>, since: number): Issue[] {
  return input.github.issues.filter((i) => i.createdAt > since).sort((a, b) => b.createdAt - a.createdAt);
}

export interface IssueToClose {
  issue: Issue;
  feature: PlanItem;
  /** The pull requests of the feature's tasks, merged ones first. */
  pulls: PullRequest[];
  /** The comment it is closed with. */
  comment: string;
}

/**
 * Open issues whose linked feature is done (all its tasks are), so the app can
 * offer to close them. Not offered without a token, since closing needs one,
 * nor for issues someone chose to keep open.
 */
export function issuesToClose(input: IssueInput): IssueToClose[] {
  if (!input.github.authenticated) return [];
  const out: IssueToClose[] = [];
  const seen = new Set<number>();
  const links = issueLinks(input);
  for (const feature of input.planning) {
    if (feature.kind !== 'feature' || featureStage(feature, input.tasks) !== 'done') continue;
    for (const issue of issuesOfFeature(input, feature, links)) {
      if (seen.has(issue.number) || input.issueMarks[issue.number]?.keepOpen) continue;
      seen.add(issue.number);
      const pulls = featurePulls(input, feature);
      out.push({ issue, feature, pulls, comment: closeComment(feature, pulls) });
    }
  }
  return out;
}

function featurePulls(input: Pick<IssueInput, 'tasks' | 'github'>, feature: PlanItem): PullRequest[] {
  const pulls = new Map<number, PullRequest>();
  for (const task of input.tasks) {
    if (task.featureId !== feature.id) continue;
    const pull = pullForBranch(input.github, task.branch);
    if (pull) pulls.set(pull.number, pull);
  }
  const rank = { merged: 0, open: 1, closed: 2 } as const;
  return [...pulls.values()].sort((a, b) => rank[a.state] - rank[b.state] || a.number - b.number);
}

/** The comment an issue is closed with: which feature finished it, and its pull requests. */
export function closeComment(feature: PlanItem, pulls: PullRequest[]): string {
  const lines = [`Done: the feature "${feature.title}" is finished.`];
  if (pulls.length > 0) {
    lines.push('', pulls.length === 1 ? 'Pull request:' : 'Pull requests:');
    for (const pull of pulls) lines.push(`- #${pull.number} ${pull.title}${pull.state === 'merged' ? '' : ` (${pull.state})`}`);
  } else {
    lines.push('', 'No pull request is linked to its tasks.');
  }
  lines.push('', '_Closed from Project Collaboration Tool._');
  return lines.join('\n');
}

/** The planning changes that make a feature from an issue and keep the link. */
export function featureFromIssue(issue: Issue, id: string): PlanOp[] {
  const body = `${issue.body.trim()}\n\nFrom GitHub issue #${issue.number}: ${issue.url}`.trim().slice(0, PLAN_TEXT_LIMIT);
  return [
    { op: 'create', id, kind: 'feature', title: issue.title.trim().slice(0, 200) || `Issue #${issue.number}` },
    { op: 'text', id, field: 'body', value: body },
    { op: 'issue', number: issue.number, link: { kind: 'feature', id, linked: true } },
  ];
}

/** Title and text for a GitHub issue made from a feature or idea. */
export function issueFromPlan(item: PlanItem): { title: string; body: string } {
  const plan = renderPlan(item).split('\n').slice(1).join('\n').trim();
  const body = `${plan || 'No description yet.'}\n\n_Planned in Project Collaboration Tool._`;
  return { title: item.title.slice(0, 256), body: body.slice(0, ISSUE_BODY_LIMIT) };
}

export const ISSUE_TITLE_LIMIT = 256;
export const ISSUE_BODY_LIMIT = 20_000;
export const ISSUE_COMMENT_LIMIT = 5_000;

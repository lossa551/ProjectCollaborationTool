import { describe, expect, it } from 'vitest';
import {
  EMPTY_GITHUB_STATUS,
  PlanOp,
  Y,
  applyPlanOp,
  closeComment,
  featureFromIssue,
  issueFromPlan,
  issueLinks,
  issuesOfFeature,
  issuesToClose,
  mentionedIssues,
  needsYou,
  newIssues,
  readIssueMarks,
  readPlanning,
  sinceLastHere,
  untriagedIssues,
  type Issue,
  type PullRequest,
  type Task,
} from '@pct/shared';

const issue = (number: number, extra: Partial<Issue> = {}): Issue => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/martin/game/issues/${number}`,
  author: 'lina',
  labels: [],
  assignees: [],
  body: 'It breaks',
  comments: 0,
  createdAt: 10,
  updatedAt: 10,
  ...extra,
});

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: id,
  stage: 'implementing',
  owner: null,
  scope: [],
  readFirst: [],
  branch: null,
  featureId: null,
  criteria: [],
  budget: null,
  duplicateCheck: null,
  createdAt: 0,
  updatedAt: 0,
  version: 1,
  ...extra,
});

const pull = (number: number, branch: string, state: PullRequest['state']): PullRequest => ({
  number,
  title: `PR ${number}`,
  url: '',
  state,
  draft: false,
  author: 'lina',
  branch,
  base: 'main',
  mergeable: 'mergeable',
  review: 'none',
  checks: 'success',
  checkRuns: [],
  files: [],
  updatedAt: 1,
});

function setup(ops: PlanOp[], extra: { tasks?: Task[]; issues?: Issue[]; pulls?: PullRequest[]; authenticated?: boolean } = {}) {
  const doc = new Y.Doc();
  for (const op of ops) applyPlanOp(doc, op, 'Martin', 50);
  return {
    planning: readPlanning(doc),
    issueMarks: readIssueMarks(doc),
    tasks: extra.tasks ?? [],
    github: { ...EMPTY_GITHUB_STATUS, authenticated: extra.authenticated ?? true, issues: extra.issues ?? [], pulls: extra.pulls ?? [] },
  };
}

const FEATURE = 'feature-1';
const create = (title: string, id = FEATURE): PlanOp => ({ op: 'create', id, kind: 'feature', title });

describe('issue mentions', () => {
  it('finds "#123" but not anchors, entities or ids inside words', () => {
    expect(mentionedIssues('Fixes #12 and #7, see (#12). Not abc#3, &#38; or x/#4. ##5')).toEqual([12, 7]);
  });
});

describe('issue links', () => {
  it('links features and tasks that mention an issue, and by hand', () => {
    const input = setup(
      [create('Wall jump (#12)'), { op: 'create', id: 'feature-2', kind: 'feature', title: 'Menu' }, { op: 'issue', number: 3, link: { kind: 'feature', id: 'feature-2', linked: true } }],
      { tasks: [task('task-1', { title: 'Fix #3 crash' })] },
    );
    const links = issueLinks(input);
    expect(links.get(12)).toEqual([{ kind: 'feature', id: FEATURE, title: 'Wall jump (#12)', by: 'mention' }]);
    expect(links.get(3)).toEqual([
      { kind: 'feature', id: 'feature-2', title: 'Menu', by: 'hand' },
      { kind: 'task', id: 'task-1', title: 'Fix #3 crash', by: 'mention' },
    ]);
  });

  it('unlinking by hand wins over a mention', () => {
    const input = setup([create('Wall jump #12'), { op: 'issue', number: 12, link: { kind: 'feature', id: FEATURE, linked: false } }]);
    expect(issueLinks(input).get(12)).toBeUndefined();
  });

  it('keeps concurrent links from two people', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    applyPlanOp(a, { op: 'issue', number: 4, link: { kind: 'feature', id: 'feature-a', linked: true } }, 'Martin');
    applyPlanOp(b, { op: 'issue', number: 4, link: { kind: 'task', id: 'task-b', linked: true } }, 'Lina');
    applyPlanOp(b, { op: 'issue', number: 4, triaged: true }, 'Lina', 9);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(readIssueMarks(a)[4]).toEqual({ links: { 'feature:feature-a': true, 'task:task-b': true }, triaged: { by: 'Lina', at: 9 }, keepOpen: false });
    expect(readIssueMarks(b)).toEqual(readIssueMarks(a));
  });

  it('shows a feature the issues of its tasks too', () => {
    const input = setup([create('Wall jump')], {
      tasks: [task('task-1', { title: 'Climb #8', featureId: FEATURE })],
      issues: [issue(8), issue(9)],
    });
    expect(issuesOfFeature(input, input.planning[0]!).map((i) => i.number)).toEqual([8]);
  });

  it('lists open issues nobody linked or triaged', () => {
    const input = setup([create('Wall jump #1'), { op: 'issue', number: 2, triaged: true }], { issues: [issue(1), issue(2), issue(3)] });
    expect(untriagedIssues(input).map((i) => i.number)).toEqual([3]);
    expect(newIssues({ github: { ...EMPTY_GITHUB_STATUS, issues: [issue(1, { createdAt: 5 }), issue(2, { createdAt: 20 })] } }, 10).map((i) => i.number)).toEqual([2]);
  });
});

describe('features and issues', () => {
  it('makes a feature from an issue and keeps the link', () => {
    const input = setup(featureFromIssue(issue(21, { title: 'Save slots', body: 'Three of them' }), 'feature-21'), { issues: [issue(21)] });
    expect(input.planning[0]).toMatchObject({ kind: 'feature', title: 'Save slots', body: 'Three of them\n\nFrom GitHub issue #21: https://github.com/martin/game/issues/21' });
    expect(issueLinks(input).get(21)).toEqual([{ kind: 'feature', id: 'feature-21', title: 'Save slots', by: 'hand' }]);
  });

  it('writes an issue from a plan', () => {
    const [item] = setup([create('Wall jump'), { op: 'text', id: FEATURE, field: 'body', value: 'Jump off walls' }]).planning;
    expect(issueFromPlan(item!)).toEqual({ title: 'Wall jump', body: 'Description:\nJump off walls\n\n_Planned in Foreus._' });
  });

  it('offers to close the issues of a finished feature, with its pull requests', () => {
    const ops = [create('Wall jump #5')];
    const done = [task('t1', { featureId: FEATURE, stage: 'done', branch: 'jump' }), task('t2', { featureId: FEATURE, stage: 'done', branch: 'jump-fx' })];
    const pulls = [pull(31, 'jump-fx', 'open'), pull(30, 'jump', 'merged')];

    const busy = setup(ops, { tasks: [done[0]!, task('t3', { featureId: FEATURE })], issues: [issue(5)], pulls });
    expect(issuesToClose(busy)).toEqual([]);

    const input = setup(ops, { tasks: done, issues: [issue(5)], pulls });
    const [offer] = issuesToClose(input);
    expect(offer).toMatchObject({ issue: { number: 5 }, feature: { id: FEATURE } });
    expect(offer!.pulls.map((p) => p.number)).toEqual([30, 31]);
    expect(offer!.comment).toBe(
      'Done: the feature "Wall jump #5" is finished.\n\nPull requests:\n- #30 PR 30\n- #31 PR 31 (open)\n\n_Closed from Foreus._',
    );
    expect(closeComment(input.planning[0]!, [])).toContain('No pull request is linked');

    // Not without a token, and not once someone chose to keep it open.
    expect(issuesToClose({ ...input, github: { ...input.github, authenticated: false } })).toEqual([]);
    expect(issuesToClose(setup([...ops, { op: 'issue', number: 5, keepOpen: true }], { tasks: done, issues: [issue(5)], pulls }))).toEqual([]);
  });

  it('puts the close offer on Home and new issues in the digest', () => {
    const input = setup([create('Wall jump #5')], { tasks: [task('t1', { featureId: FEATURE, stage: 'done' })], issues: [issue(5, { createdAt: 40 })] });
    const full = { ...input, participants: [], locks: [], workspaces: {}, agents: [], chats: [], messages: {}, memory: [], activity: [] };
    const need = needsYou(full, null, []).find((n) => n.kind === 'close-issue');
    expect(need).toMatchObject({ text: '"Wall jump #5" is done: close issue #5?', act: { type: 'close-issue', number: 5, featureId: FEATURE } });
    const digest = sinceLastHere(full, 30, 'Martin').find((g) => g.key === 'issues');
    expect(digest?.lines.map((l) => l.text)).toEqual(['#5 Issue 5 (lina)']);
  });
});

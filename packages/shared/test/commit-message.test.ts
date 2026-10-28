import { describe, expect, it } from 'vitest';
import { branchTask, cleanDraft, commitDraftPrompt, trimDiff, type Task } from '../src/index.js';

const task = (id: string, branch: string | null, stage: Task['stage'], updatedAt: number): Task => ({
  id,
  title: `Task ${id}`,
  stage,
  owner: null,
  scope: [],
  readFirst: [],
  branch,
  featureId: null,
  criteria: [],
  budget: null,
  duplicateCheck: null,
  createdAt: 0,
  updatedAt,
  version: 1,
});

const section = (path: string, lines: number) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${Array.from({ length: lines }, (_, i) => `+line ${i}`).join('\n')}\n`;

describe('commit message drafts', () => {
  it('finds the task of the branch, open ones first', () => {
    const tasks = [task('a', 'jump', 'done', 5), task('b', 'jump', 'implementing', 1), task('c', 'menu', 'review', 9)];
    expect(branchTask(tasks, 'jump')?.id).toBe('b');
    expect(branchTask(tasks, 'menu')?.id).toBe('c');
    expect(branchTask(tasks, 'other')).toBeNull();
    expect(branchTask(tasks, null)).toBeNull();
    expect(branchTask([task('a', 'jump', 'done', 5)], 'jump')?.id).toBe('a');
  });

  it('keeps small diffs whole, and cuts long files and the rest of a big diff', () => {
    const small = section('a.gd', 3);
    expect(trimDiff(small)).toEqual({ text: small, trimmed: false });

    const long = trimDiff(section('big.gd', 1000), 100_000, 500);
    expect(long.trimmed).toBe(true);
    expect(long.text.length).toBeLessThan(600);
    expect(long.text).toMatch(/more lines of this file left out\n$/);

    const many = trimDiff(['a', 'b', 'c', 'd'].map((p) => section(`${p}.gd`, 50)).join(''), 1000, 800);
    expect(many.text).toContain('diff --git a/a.gd');
    expect(many.text).toMatch(/diff left out for \d more files: .*d\.gd/);
  });

  it('asks for a short message about the changes and the task', () => {
    const prompt = commitDraftPrompt({
      branch: 'jump',
      files: [{ path: 'src/player.gd', change: 'modified' }],
      stat: ' src/player.gd | 3 ++-',
      diff: section('src/player.gd', 2),
      task: { title: 'Double jump', criteria: [{ id: 'c1', text: 'Second jump works', state: 'untested', evidence: '', by: null, at: null }] as Task['criteria'] },
    });
    expect(prompt).toContain('Task: Double jump');
    expect(prompt).toContain('- Second jump works');
    expect(prompt).toContain('- modified: src/player.gd');
    expect(prompt).toContain('+line 1');
    expect(prompt).toContain('commit message only');
  });

  it('tidies the answer', () => {
    expect(cleanDraft('```\nAdd jump\n\nMore\n```')).toBe('Add jump\n\nMore');
    expect(cleanDraft("Here's the commit message:\n\nAdd jump")).toBe('Add jump');
    expect(cleanDraft('"Add jump"')).toBe('Add jump');
    expect(cleanDraft('Add jump\r\n\r\n\r\n\r\nWhy')).toBe('Add jump\n\nWhy');
  });
});

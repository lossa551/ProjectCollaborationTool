import type { FileChange, Task } from './model.js';

// "Draft it" on the GitHub page: an agent writes a commit message from the
// uncommitted changes of your project folder and the task the branch belongs
// to. The draft only fills the message box; you edit it and commit yourself.

/**
 * A draft's model call is counted under this id instead of a chat's, so it
 * shows up in the agent's cost and its task's, like other agent usage.
 */
export const commitDraftUsageId = (profileId: string) => `commit-message:${profileId}`;

/** Most characters of diff an agent gets; past that it gets the file list and stats only. */
export const DRAFT_DIFF_CHARS = 40_000;
/** Most characters of one file's diff. */
export const DRAFT_FILE_CHARS = 6_000;

export interface DraftChanges {
  branch: string | null;
  files: { path: string; change: FileChange }[];
  /** `git diff --stat` of the changes. */
  stat: string;
  /** The changes as a unified diff, one `diff --git` section per file. */
  diff: string;
  task: Pick<Task, 'title' | 'criteria'> | null;
}

/** The task the work on this branch belongs to: the one with this branch, open ones first. */
export function branchTask(tasks: Task[], branch: string | null): Task | null {
  if (!branch) return null;
  const matches = tasks.filter((t) => t.branch === branch).sort((a, b) => b.updatedAt - a.updatedAt);
  return matches.find((t) => t.stage !== 'done') ?? matches[0] ?? null;
}

/**
 * Cuts a diff down to fit: each file's section is kept up to a limit, and once
 * the whole is too long the remaining files are only named.
 */
export function trimDiff(diff: string, total = DRAFT_DIFF_CHARS, perFile = DRAFT_FILE_CHARS): { text: string; trimmed: boolean } {
  const sections = diff.split(/(?=^diff --git )/m).filter((s) => s.trim());
  const out: string[] = [];
  const left: string[] = [];
  let used = 0;
  let trimmed = false;
  for (const section of sections) {
    let text = section;
    if (text.length > perFile) {
      const cut = text.slice(0, perFile);
      const shown = cut.slice(0, cut.lastIndexOf('\n') + 1) || cut;
      const hidden = text.slice(shown.length).split('\n').filter(Boolean).length;
      text = `${shown}… ${hidden} more ${hidden === 1 ? 'line' : 'lines'} of this file left out\n`;
      trimmed = true;
    }
    if (used + text.length > total) {
      left.push(/^diff --git a\/(.*?) b\//.exec(section)?.[1] ?? section.split('\n')[0]!);
      trimmed = true;
      continue;
    }
    out.push(text);
    used += text.length;
  }
  if (left.length > 0) out.push(`… diff left out for ${left.length} more ${left.length === 1 ? 'file' : 'files'}: ${left.join(', ')}\n`);
  return { text: out.join(''), trimmed };
}

/** What the agent is asked. */
export function commitDraftPrompt(changes: DraftChanges): string {
  const { text, trimmed } = trimDiff(changes.diff);
  const lines = [
    'Write a git commit message for the uncommitted changes below.',
    '',
    'Format: one summary line in the imperative mood, at most 72 characters, no trailing period.',
    'Then a blank line and two to five short lines on what changed and why, as plain sentences or "- " bullets.',
    'Describe the changes as they are; do not invent reasons the diff and task do not show.',
    'Answer with the commit message only: no preamble, no quotes, no code fences. Do not use any tools.',
    '',
  ];
  if (changes.branch) lines.push(`Branch: ${changes.branch}`);
  if (changes.task) {
    lines.push(`Task: ${changes.task.title}`);
    if (changes.task.criteria.length > 0) {
      lines.push('Acceptance criteria:');
      for (const c of changes.task.criteria) lines.push(`- ${c.text}`);
    }
  }
  lines.push('', `Changed files (${changes.files.length}):`);
  for (const f of changes.files.slice(0, 300)) lines.push(`- ${f.change}: ${f.path}`);
  if (changes.files.length > 300) lines.push(`- and ${changes.files.length - 300} more`);
  if (changes.stat.trim()) lines.push('', 'Stats:', changes.stat.trimEnd());
  lines.push('', trimmed ? 'Diff (shortened):' : 'Diff:', text.trimEnd() || '(no text diff)');
  return lines.join('\n');
}

/** Tidies what the model answered into a message for the box. */
export function cleanDraft(answer: string): string {
  let text = answer.replace(/\r\n/g, '\n').trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1]!.trim();
  text = text.replace(/^(?:commit message|here(?:'| i)s (?:the|a) commit message)[^\n]*:\s*\n+/i, '');
  if (/^(["'])[\s\S]*\1$/.test(text) && text.length > 1) text = text.slice(1, -1).trim();
  return text.replace(/\n{3,}/g, '\n\n');
}

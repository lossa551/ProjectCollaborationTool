import { trimDiff } from './commit-message.js';
import { isNotePath, notesForPaths, renderFolderNotes, type FolderNote } from './folder-notes.js';
import type { DuplicateCheck, DuplicateVerdict, Task } from './model.js';

// The review-time question (issue #93): when a task goes to review, the
// reviewing agent gets the change and the folder notes and answers one
// question: does this change add a system, helper or asset the notes say
// already exists? The answer shows as a review flag on the task. It is a
// single answer with no tools, so it costs one model call.

/** Most of the prompt the folder notes may take, in tokens. */
export const DUPLICATE_NOTES_BUDGET = 8000;
/** Most characters of diff the agent gets. */
export const DUPLICATE_DIFF_CHARS = 30_000;
/** Most characters of the answer kept on the task. */
export const DUPLICATE_ANSWER_CHARS = 2000;

export interface DuplicateQuestion {
  task: Pick<Task, 'title' | 'scope' | 'criteria'>;
  /** The files the task's change touches. */
  files: string[];
  /** The change as a unified diff; empty when only the file list is known. */
  diff: string;
  /** Every folder note in the project, with its text. */
  notes: FolderNote[];
}

/**
 * The notes in the order the agent should read them: those of the folders
 * the change touches first (with the top folder's), then the rest, shallowest
 * first, so the budget keeps the ones closest to the change.
 */
export function orderNotes(notes: FolderNote[], files: string[]): FolderNote[] {
  const byPath = new Map(notes.filter((n) => isNotePath(n.path)).map((n) => [n.path, n]));
  const near = notesForPaths([...byPath.keys()], files);
  const depth = (path: string) => path.split('/').length;
  const rest = [...byPath.keys()].filter((p) => !near.includes(p)).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  return [...near, ...rest].map((p) => byPath.get(p)!);
}

/** What the agent is asked. */
export function duplicateQuestionPrompt(question: DuplicateQuestion): string {
  const notes = renderFolderNotes(orderNotes(question.notes, question.files), DUPLICATE_NOTES_BUDGET);
  const { text, trimmed } = trimDiff(question.diff, DUPLICATE_DIFF_CHARS);
  const lines = [
    'You are reviewing a change before it is merged. Answer one question:',
    'Does this change add a system, helper or asset that the folder notes below say already exists in the project?',
    'Think of copies made under another name, a second manager or utility doing the same job, and new assets that repeat existing ones.',
    'A change that extends or uses the existing one is fine.',
    '',
    'Answer format: the first line is exactly one of',
    'VERDICT: duplicate',
    'VERDICT: clear',
    'VERDICT: unsure',
    'Then at most five short lines: what the change adds, and for a duplicate, which existing system it repeats and where (folder or file).',
    'Do not use any tools. Base the answer on the notes and the change only.',
    '',
    `Task: ${question.task.title}`,
  ];
  if (question.task.scope.length) lines.push(`Allowed paths: ${question.task.scope.join(', ')}`);
  if (question.task.criteria.length) {
    lines.push('Acceptance criteria:');
    for (const c of question.task.criteria) lines.push(`- ${c.text}`);
  }
  lines.push('', `Changed files (${question.files.length}):`);
  for (const f of question.files.slice(0, 300)) lines.push(`- ${f}`);
  if (question.files.length > 300) lines.push(`- and ${question.files.length - 300} more`);
  lines.push('', notes.text || 'The project has no folder notes yet: answer "VERDICT: unsure" unless the change itself shows a duplicate.');
  lines.push('', trimmed ? 'The change (shortened):' : 'The change:', text.trimEnd() || '(no diff available; judge from the file names)');
  return lines.join('\n');
}

/** Reads the agent's answer: the verdict line and the explanation after it. */
export function parseDuplicateAnswer(answer: string): Pick<DuplicateCheck, 'verdict' | 'answer'> {
  let text = answer.replace(/\r\n/g, '\n').trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1]!.trim();
  const match = /^\W*verdict\W*\s*(duplicate|clear|unsure)\b\W*$/im.exec(text);
  const verdict: DuplicateVerdict = (match?.[1]?.toLowerCase() as DuplicateVerdict | undefined) ?? 'unsure';
  const rest = (match ? text.replace(match[0], '') : text).trim().replace(/\n{3,}/g, '\n\n');
  return { verdict, answer: rest.slice(0, DUPLICATE_ANSWER_CHARS) };
}

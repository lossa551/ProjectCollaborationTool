import { createHash } from 'node:crypto';
import { DEFAULT_READ_LINES, numberLines } from './files.js';

// Keeps an agent from filling its context with copies of the same file
// (issue #91). For each file a chat read, it remembers what the read
// returned; reading the same part again answers "unchanged" while that copy
// is still in the conversation, and after an edit only the changed lines are
// sent. Whether the copy is still there is asked each time, because old
// results get cleared (see trim.ts) and a rebuilt history has none of them.

/** Lines shown around a changed region. */
export const DIFF_CONTEXT = 3;
/** A change bigger than this share of the file is sent whole: the region would not save much. */
const DIFF_MAX_SHARE = 0.5;
/** Changed regions sent in a row before the file is sent whole again, so the agent never has to piece together too much. */
const MAX_DIFFS = 4;

interface Seen {
  start: number;
  limit: number;
  hash: string;
  /** The tool results that, together, show the agent the file as it was then: a whole read and the changes sent after it. */
  basis: string[];
  /** The file's lines, kept only when the read covered the whole file, to find what changed. */
  lines: string[] | null;
}

const hashOf = (text: string) => createHash('sha1').update(text).digest('hex');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class ReadMemo {
  private seen = new Map<string, Seen>();
  /** Reads answered with "unchanged" or only the changed lines, for the context panel. */
  saved = 0;

  /**
   * What read_file returns for `text`, the whole file at `rel`. `visible` says whether an earlier
   * tool result (by call id) is still whole in the conversation.
   */
  read(rel: string, text: string, callId: string, visible: (id: string) => boolean, offset = 1, limit = DEFAULT_READ_LINES): string {
    const start = Math.max(1, offset);
    const lines = text.split('\n');
    const whole = start === 1 && lines.length <= limit;
    const hash = hashOf(text);
    const prev = this.seen.get(rel);
    const same = prev && prev.start === start && prev.limit === limit && prev.basis.every(visible);
    if (same && prev.hash === hash) {
      this.saved++;
      return `${rel} is unchanged since you read it (${plural(lines.length, 'line')}); the copy earlier in this conversation is current.`;
    }
    if (same && whole && prev.lines && prev.basis.length <= MAX_DIFFS) {
      const changed = changedRegion(rel, prev.lines, lines);
      if (changed) {
        this.saved++;
        this.seen.set(rel, { start, limit, hash, basis: [...prev.basis, callId], lines });
        return changed;
      }
    }
    this.seen.set(rel, { start, limit, hash, basis: [callId], lines: whole ? lines : null });
    return numberLines(text, offset, limit);
  }

  /** Forgets a file, e.g. after a read of it failed. */
  forget(rel: string) {
    this.seen.delete(rel);
  }
}

/**
 * The lines that differ between two versions of a file, numbered as they are now, with a few lines
 * around them; null when the change is too big for that to be worth it.
 */
export function changedRegion(rel: string, before: string[], after: string[]): string | null {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const added = after.length - head - tail;
  const removed = before.length - head - tail;
  if (added === 0 && removed === 0) return null;
  if (Math.max(added, removed) > after.length * DIFF_MAX_SHARE) return null;
  const from = Math.max(0, head - DIFF_CONTEXT);
  const to = Math.min(after.length, head + added + DIFF_CONTEXT);
  const what =
    added === 0
      ? `old lines ${head + 1}-${head + removed} were removed`
      : `lines ${head + 1}-${head + added} are new` + (removed ? `, replacing old lines ${head + 1}-${head + removed}` : '');
  const shift = added - removed;
  const moved = shift && tail > 0 ? ` Lines after it moved ${shift > 0 ? 'down' : 'up'} by ${Math.abs(shift)}.` : '';
  const shown = after.slice(from, to).map((line, i) => `${String(from + i + 1).padStart(5)}  ${line}`).join('\n');
  return (
    `${rel} changed since you read it (now ${plural(after.length, 'line')}, was ${before.length}): ${what}. ` +
    `Only that part is shown, with ${DIFF_CONTEXT} lines around it; the rest is as you read it.${moved}\n${shown}`
  );
}

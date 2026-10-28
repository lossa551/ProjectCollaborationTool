import type { LoopMessage, ToolCall, ToolResult } from './models/types.js';

// Keeps a long chat from re-sending everything it ever read (issue #88). The
// last few steps' tool results stay whole; older ones become a one-line
// summary, and big inputs of those old calls (a whole file written) are
// shortened too. Trimming happens in batches so the start of the history
// stays the same between batches and the provider's prompt cache keeps
// working.

/** Steps (rounds of tool results) at the end of the history that are always kept whole. */
export const KEEP_TOOL_STEPS = 6;
/** Old results to clear at once: trimming waits until this many have piled up. */
export const TRIM_BATCH = 6;
/** Results and inputs at most this long are left alone; a summary would not save much. */
export const TRIM_MIN_CHARS = 500;

const CLEARED = 'Old result cleared to keep the context small:';

/** A result still worth clearing: long, and not cleared already. */
const clearable = (r: ToolResult) => r.content.length > TRIM_MIN_CHARS && !r.content.startsWith(`[${CLEARED}`);

const countLines = (text: string) => (text ? text.split('\n').length : 0);
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const short = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** What an old tool result said, in one line. */
export function summarizeResult(call: ToolCall | undefined, result: ToolResult): string {
  const input = (call?.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>;
  const lines = countLines(result.content);
  let what: string;
  switch (call?.name) {
    case 'read_file': {
      const offset = typeof input.offset === 'number' ? ` from line ${input.offset}` : '';
      what = `read ${str(input.path)}${offset}, ${plural(lines, 'line')}`;
      break;
    }
    case 'search':
      what = `searched for "${short(str(input.pattern))}"${str(input.path) ? ` in ${str(input.path)}` : ''}, ${plural(lines, 'line')} of matches`;
      break;
    case 'list_files':
      what = `listed ${str(input.path) || 'the project'}, ${plural(lines, 'entry', 'entries')}`;
      break;
    case 'run_command': {
      const exit = /\(exit code ([^)]+)\)\s*$/.exec(result.content)?.[1];
      what = `ran ${short(str(input.command))}${exit ? `, exit code ${exit}` : ''}, ${plural(lines, 'line')} of output`;
      break;
    }
    default:
      what = `${call?.name ?? 'tool'}, ${plural(lines, 'line')} of output`;
  }
  // Keep the end of a failure: it usually says what went wrong.
  const tail = result.isError ? `\nLast lines: ${result.content.slice(-300).trim()}` : '';
  return `[${CLEARED} ${what}. Run the tool again if you need it.]${tail}`;
}

/** A copy of a tool input with its long text fields shortened. */
function shortenInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > TRIM_MIN_CHARS) {
      out[key] = `[${plural(countLines(value), 'line')} cleared from the context]`;
      changed = true;
    } else out[key] = value;
  }
  return changed ? out : input;
}

/**
 * Trims old tool results in place, once at least `batch` of them are waiting.
 * Returns how many results and inputs it cleared (0 when it left the history alone).
 */
export function trimHistory(history: LoopMessage[], keep = KEEP_TOOL_STEPS, batch = TRIM_BATCH): number {
  const steps = history.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
  const old = steps.slice(0, Math.max(0, steps.length - keep));
  if (old.length === 0) return 0;
  const calls = new Map<string, ToolCall>();
  for (const m of history) if (m.role === 'assistant') for (const c of m.toolCalls) calls.set(c.id, c);
  const oldIds = new Set(old.flatMap((i) => (history[i] as Extract<LoopMessage, { role: 'tool' }>).results.map((r) => r.id)));
  // Long results, and long inputs (a whole file written), that are old enough to go.
  let due = 0;
  for (const i of old) for (const r of (history[i] as Extract<LoopMessage, { role: 'tool' }>).results) if (clearable(r)) due++;
  for (const id of oldIds) if (shortenInput(calls.get(id)?.input) !== calls.get(id)?.input) due++;
  if (due === 0 || due < batch) return 0;

  for (const i of old) {
    const m = history[i] as Extract<LoopMessage, { role: 'tool' }>;
    history[i] = {
      ...m,
      results: m.results.map((r) => (clearable(r) ? { ...r, content: summarizeResult(calls.get(r.id), r) } : r)),
    };
  }
  // The calls that led to those results: a whole file written need not be sent again either.
  const last = old[old.length - 1]!;
  for (let i = 0; i < last; i++) {
    const m = history[i]!;
    if (m.role !== 'assistant' || !m.toolCalls.some((c) => oldIds.has(c.id))) continue;
    const toolCalls = m.toolCalls.map((c) => (oldIds.has(c.id) ? { ...c, input: shortenInput(c.input) } : c));
    // The provider's own blocks (Anthropic) carry the same inputs.
    const raw = Array.isArray(m.raw)
      ? m.raw.map((b: unknown) => {
          const block = b as { type?: string; id?: string; input?: unknown };
          return block?.type === 'tool_use' && block.id && oldIds.has(block.id) ? { ...block, input: shortenInput(block.input) } : b;
        })
      : m.raw;
    history[i] = { ...m, toolCalls, raw };
  }
  return due;
}

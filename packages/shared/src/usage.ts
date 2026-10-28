import { z } from 'zod';

// What agents cost. Each agent's runner reports the tokens of every model
// call (and what Claude Code or Codex report at the end of a run); the server
// adds them up per chat, day and model. Cost is estimated from a price table
// the session shares and anyone can edit, except where the tool itself said
// what a run cost.

const Rate = z.number().min(0).max(10_000);

/**
 * Higher prices for calls whose prompt is longer than a number of tokens
 * (Haiku 5.5 charges more past 100k). Applied per call, by that call's whole
 * input: uncached, read from and written to the cache together.
 */
export const LongPromptPrice = z.object({
  above: z.number().int().min(1).max(1e9),
  input: Rate,
  output: Rate,
  cacheRead: Rate,
  cacheWrite: Rate,
});
export type LongPromptPrice = z.infer<typeof LongPromptPrice>;

/** Prices in US dollars per million tokens. */
export const ModelPrice = z.object({
  /** Matched against the start of the model name, ignoring case; the longest match wins. */
  model: z.string().trim().min(1).max(100),
  input: z.number().min(0).max(10_000),
  output: z.number().min(0).max(10_000),
  /** Input read from the provider's prompt cache. */
  cacheRead: z.number().min(0).max(10_000),
  /** Input written to the prompt cache (Anthropic charges extra for it). */
  cacheWrite: z.number().min(0).max(10_000),
  /** Prices for calls with a longer prompt, if the model has them. */
  longPrompt: LongPromptPrice.optional(),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

export const PriceTable = z.array(ModelPrice).max(200);
export type PriceTable = z.infer<typeof PriceTable>;

/**
 * Starting prices, from the providers' price pages in October 2026. People
 * change them in Settings when a provider does; Ollama runs locally and is free.
 */
export const DEFAULT_PRICES: PriceTable = [
  { model: 'claude-fable-5', input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  { model: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  { model: 'claude-opus-5', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { model: 'claude-opus-4', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // Opus 4.0 (also its dated name claude-opus-4-2025…) and 4.1 cost three times more than later Opus 4 models.
  { model: 'claude-opus-4-0', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { model: 'claude-opus-4-1', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { model: 'claude-opus-4-2025', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { model: 'claude-sonnet-5', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { model: 'claude-sonnet-4', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  {
    model: 'claude-haiku-5-5',
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    // Prompts over 100k tokens cost five times as much per token.
    longPrompt: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  },
  { model: 'claude-haiku-4-5', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { model: 'deepseek-chat', input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.28 },
  { model: 'deepseek-reasoner', input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.28 },
  { model: 'gpt-5', input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  { model: 'gpt-5-mini', input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
];

/**
 * Adds the default long-prompt prices to a saved table that predates them:
 * only to a row for the same model with the same base prices as the default,
 * so a row someone changed by hand is left alone.
 */
export function withDefaultTiers(table: PriceTable): PriceTable {
  return table.map((row) => {
    if (row.longPrompt) return row;
    const known = DEFAULT_PRICES.find((d) => d.model === row.model && d.longPrompt);
    if (!known?.longPrompt) return row;
    const same = known.input === row.input && known.output === row.output && known.cacheRead === row.cacheRead && known.cacheWrite === row.cacheWrite;
    return same ? { ...row, longPrompt: known.longPrompt } : row;
  });
}

/**
 * How a call's cost is known: from the price table, reported by the tool
 * itself (Claude Code), or free (a local model).
 */
export const UsageSource = z.enum(['priced', 'reported', 'free']);
export type UsageSource = z.infer<typeof UsageSource>;

const Tokens = z.number().int().min(0).max(1e12);

/** Tokens of one model call (or one CLI run), as the provider counted them. */
export const TokenUsage = z.object({
  /** Input that was not read from or written to the cache. */
  input: Tokens,
  output: Tokens,
  cacheRead: Tokens,
  cacheWrite: Tokens,
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/** A day on the runner's clock, e.g. 2026-10-27. */
export const UsageDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** What an agent's runner reports after a model call. */
export const UsageReport = TokenUsage.extend({
  chatId: z.string(),
  model: z.string().trim().min(1).max(100),
  source: UsageSource,
  /** Dollars, when the tool reported its own cost. */
  cost: z.number().min(0).max(1e6).nullable(),
  day: UsageDay,
  /** For work outside a chat (a commit message draft): the task it was for. */
  taskId: z.string().max(100).nullable().optional(),
  /**
   * True when the report is one model call, so its input is that call's
   * prompt size: long-prompt prices and cache rebuilds are counted only then.
   * A CLI run's totals at the end are many calls together.
   */
  single: z.boolean().optional(),
});
export type UsageReport = z.infer<typeof UsageReport>;

/** Everything one chat spent on one model on one day. */
export const UsageRow = TokenUsage.extend({
  chatId: z.string(),
  agentId: z.string(),
  /** The chat's task when the calls were made, so a task keeps its cost when the chat moves on. */
  taskId: z.string().nullable(),
  model: z.string().max(100),
  source: UsageSource,
  day: UsageDay,
  calls: z.number().int().min(0),
  /** Reported cost in dollars; only for source "reported". */
  cost: z.number().min(0),
  /**
   * The part of the tokens above that came from calls with a prompt past
   * their model's long-prompt threshold (when the call was made), priced at
   * the long-prompt rate.
   */
  long: TokenUsage.optional(),
  /** Calls that wrote more of their prompt to the cache than they read from it. */
  cacheRebuilds: z.number().int().min(0).optional(),
  updatedAt: z.number(),
});
export type UsageRow = z.infer<typeof UsageRow>;

export const usageKey = (row: { chatId: string; day: string; model: string; source: UsageSource }) =>
  `${row.chatId}|${row.day}|${row.model}|${row.source}`;

const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const plus = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

/** A cache write smaller than this is a new turn's tail, not the prompt being cached again. */
const REBUILD_MIN = 1024;

/** True when one call wrote most of its prompt to the cache again instead of reading it. */
export const isCacheRebuild = (t: TokenUsage) => t.cacheWrite >= REBUILD_MIN && t.cacheWrite > t.cacheRead;

/**
 * Adds a report to its row (or starts one). With the price table, a single
 * call over its model's long-prompt threshold is kept apart so it is priced
 * at the higher rate.
 */
export function addUsage(
  row: UsageRow | undefined,
  report: UsageReport,
  chat: { agentId: string; taskId: string | null },
  now = Date.now(),
  prices: PriceTable = [],
): UsageRow {
  const tier = report.single && report.source === 'priced' ? priceFor(report.model, prices)?.longPrompt : undefined;
  const isLong = !!tier && inputTokens(report) > tier.above;
  const long = isLong ? plus(row?.long ?? ZERO, report) : row?.long;
  const rebuilds = (row?.cacheRebuilds ?? 0) + (report.single && isCacheRebuild(report) ? 1 : 0);
  return {
    chatId: report.chatId,
    agentId: row?.agentId ?? chat.agentId,
    // Calls for a different task later on the same day count for the task they were made for.
    taskId: chat.taskId ?? row?.taskId ?? null,
    model: report.model,
    source: report.source,
    day: report.day,
    calls: (row?.calls ?? 0) + 1,
    input: (row?.input ?? 0) + report.input,
    output: (row?.output ?? 0) + report.output,
    cacheRead: (row?.cacheRead ?? 0) + report.cacheRead,
    cacheWrite: (row?.cacheWrite ?? 0) + report.cacheWrite,
    cost: (row?.cost ?? 0) + (report.source === 'reported' ? (report.cost ?? 0) : 0),
    ...(long ? { long } : {}),
    ...(rebuilds ? { cacheRebuilds: rebuilds } : {}),
    updatedAt: now,
  };
}

/** The price entry for a model: the longest matching prefix, or null if none. */
export function priceFor(model: string, prices: PriceTable): ModelPrice | null {
  const name = model.toLowerCase();
  let best: ModelPrice | null = null;
  for (const price of prices) {
    const prefix = price.model.toLowerCase();
    if (name.startsWith(prefix) && (!best || prefix.length > best.model.length)) best = price;
  }
  return best;
}

type Rates = Omit<LongPromptPrice, 'above'>;

const atRates = (t: TokenUsage, r: Rates) =>
  (t.input * r.input + t.output * r.output + t.cacheRead * r.cacheRead + t.cacheWrite * r.cacheWrite) / 1_000_000;

/**
 * Dollars for some tokens at a price, or null without one. `long` is the part
 * of the tokens from calls past the long-prompt threshold; it is priced at the
 * long-prompt rate when the model has one.
 */
export function tokenCost(tokens: TokenUsage, price: ModelPrice | null, long?: TokenUsage): number | null {
  if (!price) return null;
  if (!long) return atRates(tokens, price);
  const rest: TokenUsage = {
    input: Math.max(0, tokens.input - long.input),
    output: Math.max(0, tokens.output - long.output),
    cacheRead: Math.max(0, tokens.cacheRead - long.cacheRead),
    cacheWrite: Math.max(0, tokens.cacheWrite - long.cacheWrite),
  };
  return atRates(rest, price) + atRates(long, price.longPrompt ?? price);
}

/** What a row cost; null when its model has no price. */
export function rowCost(row: UsageRow, prices: PriceTable): number | null {
  if (row.source === 'free') return 0;
  if (row.source === 'reported') return row.cost;
  return tokenCost(row, priceFor(row.model, prices), row.long);
}

export interface UsageTotal extends TokenUsage {
  calls: number;
  /** Estimated dollars, leaving out models without a price. */
  cost: number;
  /** Models used that have no price yet, so the cost is too low. */
  unpriced: string[];
  /** Calls that wrote most of their prompt to the cache again. */
  cacheRebuilds: number;
  /** Input tokens of calls priced at a long-prompt rate. */
  longInput: number;
}

export const EMPTY_TOTAL: UsageTotal = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  calls: 0,
  cost: 0,
  unpriced: [],
  cacheRebuilds: 0,
  longInput: 0,
};

export function totalUsage(rows: UsageRow[], prices: PriceTable): UsageTotal {
  const total: UsageTotal = { ...EMPTY_TOTAL, unpriced: [] };
  for (const row of rows) {
    total.input += row.input;
    total.output += row.output;
    total.cacheRead += row.cacheRead;
    total.cacheWrite += row.cacheWrite;
    total.calls += row.calls;
    total.cacheRebuilds += row.cacheRebuilds ?? 0;
    if (row.long) total.longInput += inputTokens(row.long);
    const cost = rowCost(row, prices);
    if (cost === null) {
      if (!total.unpriced.includes(row.model)) total.unpriced.push(row.model);
    } else total.cost += cost;
  }
  return total;
}

/** All input the model read, cached or not: what providers call prompt or input tokens. */
export const inputTokens = (t: TokenUsage) => t.input + t.cacheRead + t.cacheWrite;
export const allTokens = (t: TokenUsage) => inputTokens(t) + t.output;

/** How a total's input splits between uncached, read from the cache and written to it, as shares of 1. */
export interface CacheShare {
  uncached: number;
  read: number;
  write: number;
}

export function cacheShare(t: TokenUsage): CacheShare | null {
  const all = inputTokens(t);
  if (all === 0) return null;
  return { uncached: t.input / all, read: t.cacheRead / all, write: t.cacheWrite / all };
}

/**
 * A hint when the prompt cache keeps breaking: most input written to the
 * cache and the prompt rebuilt more than a couple of times. Each chat's first
 * call writes its whole prompt, so a few rebuilds are normal.
 */
export function cacheHint(t: UsageTotal): string | null {
  const share = cacheShare(t);
  if (!share || share.write < 0.3 || t.cacheRebuilds < 3) return null;
  return (
    `The prompt cache was rebuilt ${t.cacheRebuilds} times, so ${Math.round(share.write * 100)}% of the input was paid at the cache-write price. ` +
    'That happens when the system prompt or tool list changes mid-chat, or when the chat sits idle for more than 5 minutes between turns.'
  );
}

/** The local calendar day of a time, as rows store it. */
export function usageDay(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The first day of the week (Monday) that contains a time. */
export function weekStart(time: number): string {
  const d = new Date(time);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return usageDay(d.getTime());
}

export interface BudgetUse {
  /** 'chat', or 'task:' and the task's id. */
  key: string;
  /** What is being limited, e.g. 'this chat' or 'task "Double jump"'. */
  label: string;
  limit: number;
  spent: number;
}

/**
 * The chat's and its task's budgets with what each has spent. Spent counts
 * every chat of the task, including the ones it had before.
 */
export function budgetsFor(
  chat: { id: string; budget: number | null; taskId: string | null },
  task: { id: string; title: string; budget: number | null } | null,
  rows: UsageRow[],
  prices: PriceTable,
  extra = 0,
): BudgetUse[] {
  const budgets: BudgetUse[] = [];
  if (chat.budget !== null) {
    budgets.push({ key: 'chat', label: 'this chat', limit: chat.budget, spent: totalUsage(rows.filter((r) => r.chatId === chat.id), prices).cost + extra });
  }
  if (task && task.budget !== null) {
    const spent = totalUsage(rows.filter((r) => r.taskId === task.id), prices).cost + extra;
    budgets.push({ key: `task:${task.id}`, label: `the task "${task.title}"`, limit: task.budget, spent });
  }
  return budgets;
}

/** e.g. $0.42, $12.30, <$0.01, $0. */
export function formatCost(dollars: number): string {
  if (dollars === 0) return '$0';
  if (dollars < 0.01) return '<$0.01';
  if (dollars < 100) return `$${dollars.toFixed(2)}`;
  return `$${Math.round(dollars).toLocaleString('en-US')}`;
}

/** e.g. 950, 12.3k, 1.2M. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}M`;
}

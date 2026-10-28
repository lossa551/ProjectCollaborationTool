import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRICES,
  addUsage,
  budgetsFor,
  cacheHint,
  cacheShare,
  formatCost,
  formatTokens,
  priceFor,
  totalUsage,
  usageDay,
  weekStart,
  withDefaultTiers,
  type UsageReport,
  type UsageRow,
} from '@pct/shared';

const report = (extra: Partial<UsageReport> = {}): UsageReport => ({
  chatId: 'c1',
  model: 'claude-opus-5-5',
  source: 'priced',
  input: 1_000_000,
  output: 100_000,
  cacheRead: 0,
  cacheWrite: 0,
  cost: null,
  day: '2026-10-27',
  ...extra,
});

const row = (extra: Partial<UsageReport> = {}, chat = { agentId: 'a1', taskId: 't1' as string | null }): UsageRow =>
  addUsage(undefined, report(extra), chat, 1);

describe('agent usage and cost', () => {
  it('picks the longest matching price', () => {
    expect(priceFor('claude-opus-5-5', DEFAULT_PRICES)?.input).toBe(4);
    expect(priceFor('claude-opus-5', DEFAULT_PRICES)?.input).toBe(5);
    expect(priceFor('claude-opus-4-8', DEFAULT_PRICES)?.model).toBe('claude-opus-4');
    expect(priceFor('GPT-5-mini-2026', DEFAULT_PRICES)?.model).toBe('gpt-5-mini');
    expect(priceFor('qwen3', DEFAULT_PRICES)).toBeNull();
  });

  it('prices Opus 4.0 and 4.1 at their own, higher rate', () => {
    expect(priceFor('claude-opus-4-1', DEFAULT_PRICES)?.input).toBe(15);
    expect(priceFor('claude-opus-4-1-20250805', DEFAULT_PRICES)?.output).toBe(75);
    expect(priceFor('claude-opus-4-0', DEFAULT_PRICES)?.input).toBe(15);
    expect(priceFor('claude-opus-4-20250514', DEFAULT_PRICES)?.input).toBe(15);
    expect(priceFor('claude-opus-4-5', DEFAULT_PRICES)?.input).toBe(5);
  });

  it('adds calls up per row and prices them by kind', () => {
    const first = row();
    const both = addUsage(first, report({ input: 0, output: 0, cacheRead: 1_000_000 }), { agentId: 'a1', taskId: 't1' }, 2);
    expect(both).toMatchObject({ calls: 2, input: 1_000_000, cacheRead: 1_000_000, output: 100_000, taskId: 't1', updatedAt: 2 });
    // $4 + $0.20 cache read + 100k at $20/M.
    expect(totalUsage([both], DEFAULT_PRICES).cost).toBeCloseTo(6.2);

    const reported = row({ source: 'reported', cost: 0.3, chatId: 'c2' });
    const free = row({ source: 'free', model: 'qwen3', chatId: 'c3' });
    const unknown = row({ model: 'mystery-1', chatId: 'c4' });
    const total = totalUsage([both, reported, free, unknown], DEFAULT_PRICES);
    expect(total.cost).toBeCloseTo(6.5);
    expect(total.unpriced).toEqual(['mystery-1']);
    expect(total.calls).toBe(5);
  });

  it('measures a chat and its task against their budgets', () => {
    const rows = [row(), row({ chatId: 'c2' })];
    const chat = { id: 'c1', budget: 5, taskId: 't1' };
    const task = { id: 't1', title: 'Double jump', budget: 10 };
    expect(budgetsFor(chat, task, rows, DEFAULT_PRICES)).toEqual([
      { key: 'chat', label: 'this chat', limit: 5, spent: 6 },
      { key: 'task:t1', label: 'the task "Double jump"', limit: 10, spent: 12 },
    ]);
    expect(budgetsFor({ ...chat, budget: null }, null, rows, DEFAULT_PRICES)).toEqual([]);
  });

  it('formats days, cost and tokens', () => {
    const wednesday = new Date(2026, 9, 28, 15).getTime();
    expect(usageDay(wednesday)).toBe('2026-10-28');
    expect(weekStart(wednesday)).toBe('2026-10-26');
    expect(weekStart(new Date(2026, 10, 1, 9).getTime())).toBe('2026-10-26');
    expect([0, 0.004, 0.42, 12.3, 1234].map(formatCost)).toEqual(['$0', '<$0.01', '$0.42', '$12.30', '$1,234']);
    expect([950, 1234, 56_000, 1_200_000].map(formatTokens)).toEqual(['950', '1.2k', '56k', '1.2M']);
  });

  it('prices single Haiku 5.5 calls over 100k tokens at the long-prompt rate', () => {
    const haiku = { model: 'claude-haiku-5-5', input: 150_000, output: 10_000, single: true };
    const chat = { agentId: 'a1', taskId: null };
    const long = addUsage(undefined, report(haiku), chat, 1, DEFAULT_PRICES);
    expect(long.long).toMatchObject({ input: 150_000, output: 10_000 });
    // 150k at $0.50/M + 10k at $2.50/M.
    expect(totalUsage([long], DEFAULT_PRICES).cost).toBeCloseTo(0.1);
    expect(totalUsage([long], DEFAULT_PRICES).longInput).toBe(150_000);

    // A short call on the same row stays at the base rate: 50k at $0.10/M.
    const both = addUsage(long, report({ ...haiku, input: 50_000, output: 0 }), chat, 2, DEFAULT_PRICES);
    expect(both.long?.input).toBe(150_000);
    expect(totalUsage([both], DEFAULT_PRICES).cost).toBeCloseTo(0.105);

    // Cache reads count toward the prompt size.
    const cached = addUsage(undefined, report({ ...haiku, input: 1000, output: 0, cacheRead: 120_000 }), chat, 1, DEFAULT_PRICES);
    expect(cached.long?.cacheRead).toBe(120_000);

    // A CLI run's totals are many calls, so they stay at the base rate.
    const run = addUsage(undefined, report({ ...haiku, single: false }), chat, 1, DEFAULT_PRICES);
    expect(run.long).toBeUndefined();
    expect(totalUsage([run], DEFAULT_PRICES).cost).toBeCloseTo(0.02);

    // Without the price table (old callers), nothing is split.
    expect(addUsage(undefined, report(haiku), chat, 1).long).toBeUndefined();
  });

  it('adds the default long-prompt price only to unchanged saved rows', () => {
    const base = DEFAULT_PRICES.find((p) => p.model === 'claude-haiku-5-5')!;
    const { longPrompt: _, ...saved } = base;
    expect(withDefaultTiers([saved])[0]!.longPrompt?.above).toBe(100_000);
    expect(withDefaultTiers([{ ...saved, input: 0.2 }])[0]!.longPrompt).toBeUndefined();
    const own = { ...base, longPrompt: { ...base.longPrompt!, above: 50_000 } };
    expect(withDefaultTiers([own])[0]).toEqual(own);
  });

  it('shows the cache-write share and flags a cache that keeps breaking', () => {
    const chat = { agentId: 'a1', taskId: null };
    // First call writes the prompt, later calls read it and add a small tail.
    let healthy = addUsage(undefined, report({ input: 100, output: 0, cacheWrite: 20_000, single: true }), chat, 1);
    for (let i = 0; i < 5; i++) healthy = addUsage(healthy, report({ input: 100, output: 0, cacheRead: 20_000, cacheWrite: 500, single: true }), chat, 1);
    const ok = totalUsage([healthy], DEFAULT_PRICES);
    expect(ok.cacheRebuilds).toBe(1);
    expect(cacheShare(ok)!.read).toBeGreaterThan(0.7);
    expect(cacheHint(ok)).toBeNull();

    let broken = addUsage(undefined, report({ input: 100, output: 0, cacheWrite: 20_000, single: true }), chat, 1);
    for (let i = 0; i < 4; i++) broken = addUsage(broken, report({ input: 100, output: 0, cacheWrite: 20_000, single: true }), chat, 1);
    const bad = totalUsage([broken], DEFAULT_PRICES);
    expect(bad.cacheRebuilds).toBe(5);
    expect(cacheShare(bad)!.write).toBeGreaterThan(0.9);
    expect(cacheHint(bad)).toMatch(/rebuilt 5 times/);

    expect(cacheShare(report({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0 }))).toBeNull();
  });
});

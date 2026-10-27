import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRICES,
  addUsage,
  budgetsFor,
  formatCost,
  formatTokens,
  priceFor,
  totalUsage,
  usageDay,
  weekStart,
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
});

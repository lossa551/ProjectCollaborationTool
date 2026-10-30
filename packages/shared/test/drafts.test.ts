import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APPROVALS,
  DEFAULT_PRICES,
  byDraftCost,
  cheapestAgent,
  commitDraftUsageId,
  draftCost,
  draftCostWarning,
  draftKindOf,
  draftRows,
  isOwnDraft,
  reviewDraftUsageId,
  notesDraftUsageId,
  type AgentConnection,
  type AgentProfile,
  type UsageRow,
} from '../src/index.js';

const agent = (id: string, connection: AgentConnection): AgentProfile => ({
  id,
  name: id,
  connection,
  responsibilities: '',
  allowedPaths: [],
  approvals: DEFAULT_APPROVALS,
  createdAt: 0,
  updatedAt: 0,
});

const api = (id: string, model: string, provider: 'anthropic' | 'ollama' | 'deepseek' = 'anthropic') =>
  agent(id, { type: 'api', provider, model, baseUrl: null });

const opus = api('Opus', 'claude-opus-5-5');
const haiku = api('Haiku', 'claude-haiku-5-5');
const local = api('Local', 'qwen3', 'ollama');
const claudeCode = agent('Claude Code', { type: 'cli', tool: 'claude-code', model: null, auth: 'api' });
const claudeHaiku = agent('Claude Code Haiku', { type: 'cli', tool: 'claude-code', model: 'haiku', auth: 'api' });

describe('draft usage ids', () => {
  it('keeps notes and commit drafts apart, both the agent’s own', () => {
    expect(draftKindOf(notesDraftUsageId('a'))).toBe('notes');
    expect(draftKindOf(commitDraftUsageId('a'))).toBe('commit');
    expect(draftKindOf(reviewDraftUsageId('a'))).toBe('review');
    expect(draftKindOf('chat-1')).toBeNull();
    expect(isOwnDraft(notesDraftUsageId('a'), 'a')).toBe(true);
    expect(isOwnDraft(commitDraftUsageId('a'), 'a')).toBe(true);
    expect(isOwnDraft(notesDraftUsageId('b'), 'a')).toBe(false);
    const row = (chatId: string) => ({ chatId }) as UsageRow;
    expect(draftRows([row(notesDraftUsageId('a')), row(commitDraftUsageId('a')), row('chat')], 'notes', 'a')).toHaveLength(1);
  });
});

describe('draft cost', () => {
  it('estimates a typical note draft per model', () => {
    expect(draftCost(haiku, DEFAULT_PRICES)).toBeCloseTo(0.0015, 6);
    expect(draftCost(opus, DEFAULT_PRICES)).toBeCloseTo(0.06, 6);
    expect(draftCost(local, DEFAULT_PRICES)).toBe(0);
    // Claude Code's own default model is not known; its short names are.
    expect(draftCost(claudeCode, DEFAULT_PRICES)).toBeNull();
    // On a Claude plan it bills nothing per token.
    expect(draftCost(agent('Plan', { type: 'cli', tool: 'claude-code', model: 'opus', auth: 'plan' }), DEFAULT_PRICES)).toBe(0);
    expect(draftCost(claudeHaiku, DEFAULT_PRICES)).toBeCloseTo(0.0015, 6);
    expect(draftCost(api('X', 'mystery-model', 'deepseek'), DEFAULT_PRICES)).toBeNull();
  });

  it('orders agents cheapest first, unknown prices last', () => {
    expect(byDraftCost([claudeCode, opus, haiku, local], DEFAULT_PRICES).map((a) => a.id)).toEqual(['Local', 'Haiku', 'Opus', 'Claude Code']);
    expect(cheapestAgent([opus, haiku], DEFAULT_PRICES)?.id).toBe('Haiku');
    expect(cheapestAgent([], DEFAULT_PRICES)).toBeUndefined();
  });

  it('warns about an expensive notes agent and names a cheaper one', () => {
    expect(draftCostWarning(haiku, [opus, haiku], DEFAULT_PRICES)).toBeNull();
    expect(draftCostWarning(local, [local], DEFAULT_PRICES)).toBeNull();
    const warning = draftCostWarning(opus, [opus, haiku], DEFAULT_PRICES);
    expect(warning).toContain('Opus costs about $0.06 per note draft');
    expect(warning).toContain('Haiku would cost about $0.0015');
    expect(draftCostWarning(opus, [opus], DEFAULT_PRICES)).toContain('Haiku 5.5');
    expect(draftCostWarning(claudeCode, [claudeCode, local], DEFAULT_PRICES)).toContain('Local would cost nothing (local model)');
  });
});

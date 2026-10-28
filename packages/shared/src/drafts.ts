import type { AgentProfile } from './model.js';
import { commitDraftUsageId } from './commit-message.js';
import { priceFor, tokenCost, type PriceTable, type UsageRow } from './usage.js';

// Agents also write things outside any chat: commit messages on the GitHub
// page and folder notes, which the notes agent drafts by itself all day (#94).
// Both are counted as the agent's own usage, each under its own id so the
// cost view can show them apart. Small, frequent work like this should run on
// the cheapest model there is, so the pickers default to it.

export type DraftKind = 'commit' | 'notes';

/** Folder note drafts' model calls are counted under this id, like commit drafts under commitDraftUsageId. */
export const notesDraftUsageId = (profileId: string) => `folder-notes:${profileId}`;

export const draftUsageId = (kind: DraftKind, profileId: string) =>
  kind === 'notes' ? notesDraftUsageId(profileId) : commitDraftUsageId(profileId);

/** Which kind of draft a usage id belongs to, or null for a chat. */
export function draftKindOf(chatId: string): DraftKind | null {
  if (chatId.startsWith('commit-message:')) return 'commit';
  if (chatId.startsWith('folder-notes:')) return 'notes';
  return null;
}

/** True when the id is one of this agent's draft ids, so its usage counts as the agent's own. */
export const isOwnDraft = (chatId: string, profileId: string) =>
  chatId === commitDraftUsageId(profileId) || chatId === notesDraftUsageId(profileId);

/** The usage rows of one agent's drafts of a kind. */
export const draftRows = (rows: UsageRow[], kind: DraftKind, profileId: string) => {
  const id = draftUsageId(kind, profileId);
  return rows.filter((r) => r.chatId === id);
};

/**
 * Roughly what one folder note draft sends and gets back: six files of 4000
 * characters and up to 400 paths in, a short note out.
 */
export const TYPICAL_DRAFT = { input: 12_000, output: 600, cacheRead: 0, cacheWrite: 0 };

/** A note draft costing more than this (dollars) gets a warning. Haiku 5.5 costs about $0.0015. */
export const EXPENSIVE_DRAFT = 0.01;

/** Claude Code's short model names, priced like the models they stand for. */
const MODEL_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5',
};

/** The model an agent calls, as far as the app knows; null when a command-line tool uses its own default. */
export function agentModel(agent: AgentProfile): string | null {
  const model = agent.connection.model;
  if (!model) return null;
  return agent.connection.type === 'cli' ? (MODEL_ALIASES[model.toLowerCase()] ?? model) : model;
}

/** Estimated dollars for one typical draft by this agent: 0 for a local model, null when its price is unknown. */
export function draftCost(agent: AgentProfile, prices: PriceTable): number | null {
  if (agent.connection.type === 'api' && agent.connection.provider === 'ollama') return 0;
  const model = agentModel(agent);
  return model ? tokenCost(TYPICAL_DRAFT, priceFor(model, prices)) : null;
}

/** The agents cheapest first; ones whose price is unknown go last, in their own order. */
export function byDraftCost(agents: AgentProfile[], prices: PriceTable): AgentProfile[] {
  const cost = (a: AgentProfile) => draftCost(a, prices) ?? Infinity;
  return agents
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => cost(a.agent) - cost(b.agent) || a.index - b.index)
    .map((e) => e.agent);
}

export const cheapestAgent = (agents: AgentProfile[], prices: PriceTable): AgentProfile | undefined => byDraftCost(agents, prices)[0];

/**
 * A warning when an agent is costly for drafts that run all day: its price is
 * unknown, or a draft costs more than EXPENSIVE_DRAFT. Names a cheaper agent
 * from `others` when there is one.
 */
export function draftCostWarning(agent: AgentProfile, others: AgentProfile[], prices: PriceTable): string | null {
  const cost = draftCost(agent, prices);
  if (cost !== null && cost <= EXPENSIVE_DRAFT) return null;
  const cheaper = byDraftCost(others, prices).find((a) => {
    const c = draftCost(a, prices);
    return a.id !== agent.id && c !== null && (cost === null || c < cost);
  });
  const own =
    cost === null
      ? `The app does not know what ${agent.name}'s model costs, so it may be an expensive one.`
      : `${agent.name} costs about ${dollars(cost)} per note draft, and drafts run every 15 minutes while notes are stale.`;
  if (!cheaper) return `${own} A small model such as Haiku 5.5, or a local Ollama model, does this for much less.`;
  const theirs = draftCost(cheaper, prices) ?? 0;
  return `${own} ${cheaper.name} would cost ${theirs === 0 ? 'nothing (local model)' : `about ${dollars(theirs)}`}.`;
}

/** Small dollar amounts with enough digits to compare, e.g. $0.0015, $0.06. */
export function dollars(value: number): string {
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toPrecision(2)}`;
  return `$${value.toFixed(2)}`;
}

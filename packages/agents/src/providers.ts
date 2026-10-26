import { API_PROVIDERS, apiKeyName, type AgentProfile } from '@pct/shared';
import { AnthropicAdapter } from './models/anthropic.js';
import { OpenAICompatibleAdapter } from './models/openai.js';
import type { ModelAdapter } from './models/types.js';

// Picks the adapter for an API agent. Keys are looked up on this PC only.

export type ApiKeys = (name: string) => string | null;

export function createModel(agent: AgentProfile, keys: ApiKeys): ModelAdapter {
  const connection = agent.connection;
  if (connection.type !== 'api') throw new Error(`${agent.name} is not an API agent`);
  const preset = API_PROVIDERS[connection.provider];
  const baseUrl = connection.baseUrl ?? preset.baseUrl;
  const key = keys(apiKeyName(connection.provider, baseUrl));
  if (preset.needsKey && !key) {
    throw new Error(`No API key for ${preset.label} on this PC. Add it on the Agents screen.`);
  }
  if (connection.provider === 'anthropic') return new AnthropicAdapter(connection.model, key ?? '', connection.baseUrl);
  if (!baseUrl) throw new Error(`${agent.name} needs the address of its API`);
  return new OpenAICompatibleAdapter(connection.model, baseUrl, key);
}

import { z } from 'zod';
import type { TokenUsage } from '@pct/shared';

// One shape for every model API, so the agent loop does not care which
// provider runs it. Adapters translate to and from their API's format.

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  id: string;
  content: string;
  isError: boolean;
}

export type LoopMessage =
  | { role: 'user'; text: string }
  /** raw: the provider's own content (e.g. thinking blocks), passed back unchanged to the same provider. */
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; raw?: unknown }
  /** note: what the app tells the agent along with the results, e.g. a task change during the turn (see contextUpdate). */
  | { role: 'tool'; results: ToolResult[]; note?: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON schema of the input. */
  schema: Record<string, unknown>;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  stop: StopReason;
  raw?: unknown;
  /** Tokens the provider counted for this call, when it said. */
  usage?: TokenUsage;
  /** The model that answered, when the provider said (e.g. a dated version of an alias). */
  model?: string;
}

export interface ModelRequest {
  system: string;
  messages: LoopMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  /** Text as it streams in. */
  onText: (delta: string) => void;
}

export interface ModelAdapter {
  complete(request: ModelRequest): Promise<ModelTurn>;
}

/** Tool inputs come from the model: check them before use. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): { ok: true; value: T } | { ok: false; error: string } {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: `Invalid input: ${result.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}` };
}

import type { TokenUsage } from '@pct/shared';
import type { LoopMessage, ModelAdapter, ModelRequest, ModelTurn, StopReason, ToolCall } from './types.js';

// Any API that speaks the OpenAI chat completions format: DeepSeek, OpenAI,
// Ollama (the local runtime) and others. Plain fetch with streaming, so no
// SDK per provider is needed.

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

function toMessages(system: string, messages: LoopMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text || null,
        ...(m.toolCalls.length > 0 && {
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
          })),
        }),
      });
    } else for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `Error: ${r.content}` : r.content });
  }
  return out;
}

const STOP: Record<string, StopReason> = { stop: 'end', tool_calls: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };

export class OpenAICompatibleAdapter implements ModelAdapter {
  constructor(
    private readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKey: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(request: ModelRequest): Promise<ModelTurn> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal: request.signal,
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey && { authorization: `Bearer ${this.apiKey}` }),
      },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        // The last chunk then says how many tokens the call used.
        stream_options: { include_usage: true },
        messages: toMessages(request.system, request.messages),
        tools: request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })),
      }),
    });
    if (!response.ok || !response.body) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      throw new Error(`${this.baseUrl} answered ${response.status}${detail ? `: ${detail}` : ''}`);
    }

    let text = '';
    let finish: string | null = null;
    let usage: TokenUsage | undefined;
    let answeredBy: string | undefined;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    const decoder = new TextDecoder();
    let buffer = '';
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk: {
          choices?: {
            delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] };
            finish_reason?: string | null;
          }[];
          error?: { message?: string };
          model?: string;
          usage?: ApiUsage | null;
        };
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) throw new Error(chunk.error.message ?? 'The model API reported an error');
        if (chunk.usage) usage = readUsage(chunk.usage);
        if (chunk.model) answeredBy = chunk.model;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          text += choice.delta.content;
          request.onText(choice.delta.content);
        }
        for (const call of choice.delta?.tool_calls ?? []) {
          const current = calls.get(call.index) ?? { id: '', name: '', args: '' };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name += call.function.name;
          if (call.function?.arguments) current.args += call.function.arguments;
          calls.set(call.index, current);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }

    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => {
        let input: unknown;
        try {
          input = c.args ? JSON.parse(c.args) : {};
        } catch {
          // Reported back to the model as an invalid input.
          input = { __unparsed: c.args };
        }
        return { id: c.id || `call_${index}`, name: c.name, input };
      });
    const stop = toolCalls.length > 0 ? 'tool_use' : (STOP[finish ?? ''] ?? 'end');
    return { text, toolCalls, stop, ...(usage && { usage }), ...(answeredBy && { model: answeredBy }) };
  }
}

interface ApiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  /** DeepSeek's names for cached and uncached input. */
  prompt_cache_hit_tokens?: number;
}

/** Prompt tokens include the cached ones; they are counted apart, since they cost less. */
function readUsage(raw: ApiUsage): TokenUsage {
  const prompt = raw.prompt_tokens ?? 0;
  const cached = Math.min(prompt, raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? 0);
  return { input: prompt - cached, output: raw.completion_tokens ?? 0, cacheRead: cached, cacheWrite: 0 };
}

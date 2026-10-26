import Anthropic from '@anthropic-ai/sdk';
import type { LoopMessage, ModelAdapter, ModelRequest, ModelTurn, StopReason } from './types.js';

// Claude through the Anthropic API, with streaming. Thinking is left at the
// model's default (adaptive on current models), and the assistant's content
// blocks go back unchanged on the next request so nothing is lost.

function toParams(messages: LoopMessage[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    switch (m.role) {
      case 'user':
        return { role: 'user', content: m.text };
      case 'assistant':
        if (Array.isArray(m.raw)) return { role: 'assistant', content: m.raw as Anthropic.ContentBlockParam[] };
        return {
          role: 'assistant',
          content: [
            ...(m.text ? [{ type: 'text' as const, text: m.text }] : []),
            ...m.toolCalls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.input })),
          ],
        };
      case 'tool':
        // All results of one turn go back in a single user message.
        return {
          role: 'user',
          content: m.results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.content, is_error: r.isError })),
        };
    }
  });
}

const STOP: Record<string, StopReason> = { end_turn: 'end', tool_use: 'tool_use', max_tokens: 'max_tokens', refusal: 'refusal' };

export class AnthropicAdapter implements ModelAdapter {
  private readonly client: Anthropic;

  constructor(
    private readonly model: string,
    apiKey: string,
    baseURL?: string | null,
  ) {
    this.client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  async complete(request: ModelRequest): Promise<ModelTurn> {
    const tools: Anthropic.Tool[] = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema as Anthropic.Tool.InputSchema,
      // File contents stream as they are written; inputs are validated before use.
      eager_input_streaming: true,
    }));
    let jsonRetries = 0;
    for (;;) {
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: 64000,
          system: request.system,
          messages: toParams(request.messages),
          tools,
          cache_control: { type: 'ephemeral' },
        },
        { signal: request.signal },
      );
      stream.on('text', (delta) => request.onText(delta));
      let message: Anthropic.Message;
      try {
        message = await stream.finalMessage();
      } catch (error) {
        // A tool input that could not be parsed at all: ask again. API errors go up.
        if (error instanceof Anthropic.APIError || request.signal.aborted || jsonRetries++ >= 2) throw error;
        continue;
      }
      const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const toolCalls = message.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : []));
      return { text, toolCalls, stop: STOP[message.stop_reason ?? ''] ?? 'other', raw: message.content };
    }
  }
}

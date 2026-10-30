#!/usr/bin/env node
// Stands in for `claude -p --output-format stream-json`: says how it signed in
// (an API key from the environment, else the Claude plan) and reports a cost.
let prompt = '';
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  const key = process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none';
  const line = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  line({ type: 'system', subtype: 'init', session_id: `fake-${Date.now()}`, apiKeySource: key, apiProvider: 'firstParty' });
  line({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: `key: ${key}` }], usage: { input_tokens: 1000, output_tokens: 50 } } });
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: `key: ${key}`,
    modelUsage: { 'claude-opus-5-5': { inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.5 } },
  });
});

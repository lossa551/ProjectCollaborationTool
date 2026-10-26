import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HookServer, OpenAICompatibleAdapter, parseClaudeLine, parseCodexLine } from '@pct/agents';

const hookScript = fileURLToPath(new URL('../bin/pct-hook.cjs', import.meta.url));
let hook: HookServer | null = null;

afterEach(async () => {
  await hook?.stop();
  hook = null;
});

function runHook(env: Record<string, string>, event: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [hookScript], { env: { ...process.env, ...env } }, (error, stdout) => {
      if (error) reject(error);
      else resolve(JSON.parse(stdout));
    });
    child.stdin!.end(JSON.stringify(event));
  });
}

describe('Claude Code hook', () => {
  it('asks the app and answers Claude Code with its decision', async () => {
    const asked: unknown[] = [];
    hook = new HookServer(async (request) => {
      asked.push(request);
      return request.toolName === 'Read' ? { allow: true, reason: 'ok' } : { allow: false, reason: 'outside the task' };
    });
    await hook.start();
    const allowed = await runHook(hook.env('chat-1'), { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x/a.gd' } });
    expect(allowed).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'ok' } });
    const denied = (await runHook(hook.env('chat-1'), { tool_name: 'Write', tool_input: { file_path: '/x/b.gd' } })) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(asked[0]).toEqual({ chatId: 'chat-1', toolName: 'Read', toolInput: { file_path: '/x/a.gd' } });
  });

  it('denies when the app cannot be reached or the token is wrong', async () => {
    hook = new HookServer(async () => ({ allow: true, reason: 'ok' }));
    await hook.start();
    const wrong = (await runHook({ ...hook.env('c'), PCT_HOOK_TOKEN: 'nope' }, { tool_name: 'Bash', tool_input: {} })) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(wrong.hookSpecificOutput.permissionDecision).toBe('deny');
    const gone = (await runHook({ PCT_HOOK_URL: 'http://127.0.0.1:1/hook', PCT_HOOK_TOKEN: 'x', PCT_CHAT_ID: 'c' }, { tool_name: 'Bash' })) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(gone.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('CLI output', () => {
  it('reads Claude Code stream-json', () => {
    expect(parseClaudeLine('{"type":"system","subtype":"init","session_id":"s1"}')).toEqual([{ type: 'session', id: 's1' }]);
    expect(
      parseClaudeLine(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', id: 'u1', name: 'Edit', input: { file_path: '/p/a.gd' } }] },
        }),
      ),
    ).toEqual([
      { type: 'text', text: 'Looking' },
      { type: 'tool', id: 'u1', name: 'Edit', summary: '/p/a.gd' },
    ]);
    expect(
      parseClaudeLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'denied', is_error: true }] } })),
    ).toEqual([{ type: 'tool_result', id: 'u1', output: 'denied', failed: true }]);
    expect(parseClaudeLine('not json')).toEqual([]);
  });

  it('reads Codex exec --json', () => {
    expect(parseCodexLine('{"type":"thread.started","thread_id":"th"}')).toEqual([{ type: 'session', id: 'th' }]);
    expect(parseCodexLine('{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Done"}}')).toEqual([{ type: 'text', text: 'Done' }]);
    expect(
      parseCodexLine('{"type":"item.completed","item":{"id":"i2","type":"command_execution","command":"ls","aggregated_output":"a","exit_code":1}}'),
    ).toEqual([
      { type: 'tool', id: 'i2', name: 'command', summary: 'ls' },
      { type: 'tool_result', id: 'i2', output: 'a', failed: true },
    ]);
    expect(parseCodexLine('{"type":"turn.failed","error":{"message":"quota"}}')).toEqual([{ type: 'error', message: 'quota' }]);
  });
});

describe('OpenAI-compatible adapter', () => {
  it('streams text and puts together tool calls sent in pieces', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.gd"}' } }] }, finish_reason: 'tool_calls' }] },
    ];
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    let sent: { url: string; body: unknown } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new OpenAICompatibleAdapter('deepseek-chat', 'https://api.deepseek.com/', 'key', fakeFetch);
    const deltas: string[] = [];
    const turn = await adapter.complete({
      system: 'sys',
      messages: [{ role: 'user', text: 'hi' }],
      tools: [{ name: 'read_file', description: 'd', schema: { type: 'object' } }],
      signal: new AbortController().signal,
      onText: (d) => deltas.push(d),
    });
    expect(deltas.join('')).toBe('Hello');
    expect(turn).toEqual({ text: 'Hello', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a.gd' } }], stop: 'tool_use' });
    expect(sent!.url).toBe('https://api.deepseek.com/chat/completions');
    expect((sent!.body as { messages: unknown[] }).messages[0]).toEqual({ role: 'system', content: 'sys' });
  });
});

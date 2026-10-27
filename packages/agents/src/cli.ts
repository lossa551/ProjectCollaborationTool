import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TokenUsage } from '@pct/shared';
import { clip } from './files.js';

// Command-line agents (Claude Code, Codex CLI) run headless in the project
// folder. Their output is turned into chat events. Claude Code asks the app
// before every tool use through a PreToolUse hook (bin/pct-hook.cjs), which
// posts to a small HTTP server here; Codex has no such hook, so what it
// changed is checked after each run instead (see runner.ts).

export type CliEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; summary: string }
  | { type: 'tool_result'; id: string; output: string; failed: boolean }
  | { type: 'error'; message: string }
  /** What a run used, per model, as the tool reported it at the end; cost when it said. */
  | { type: 'usage'; model: string | null; usage: TokenUsage; cost: number | null }
  /** One model call while the run goes on (Claude Code), for budget checks before the run ends. */
  | { type: 'progress'; id: string; model: string | null; usage: TokenUsage };

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

const summarizeInput = (input: Record<string, unknown>): string => {
  for (const key of ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query', 'description']) {
    const value = input[key];
    if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  }
  return '';
};

const resultText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text : '')).join('');
  }
  return '';
};

/** One line of `claude -p --output-format stream-json` as chat events. */
export function parseClaudeLine(line: string): CliEvent[] {
  let event: {
    type?: string;
    subtype?: string;
    session_id?: string;
    message?: { id?: unknown; model?: unknown; content?: unknown; usage?: Record<string, unknown> };
    is_error?: boolean;
    result?: unknown;
    total_cost_usd?: unknown;
    usage?: Record<string, unknown>;
    modelUsage?: Record<string, Record<string, unknown>>;
  };
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  const out: CliEvent[] = [];
  if (event.type === 'system' && event.subtype === 'init' && event.session_id) out.push({ type: 'session', id: event.session_id });
  const content = Array.isArray(event.message?.content) ? (event.message.content as Record<string, unknown>[]) : [];
  if (event.type === 'assistant') {
    const message = event.message;
    if (typeof message?.id === 'string' && message.usage) {
      const u = message.usage;
      out.push({
        type: 'progress',
        id: message.id,
        model: typeof message.model === 'string' ? message.model : null,
        usage: { input: count(u.input_tokens), output: count(u.output_tokens), cacheRead: count(u.cache_read_input_tokens), cacheWrite: count(u.cache_creation_input_tokens) },
      });
    }
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) out.push({ type: 'text', text: block.text });
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        out.push({ type: 'tool', id: block.id, name: block.name, summary: summarizeInput((block.input ?? {}) as Record<string, unknown>) });
      }
    }
  }
  if (event.type === 'user') {
    for (const block of content) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        out.push({ type: 'tool_result', id: block.tool_use_id, output: clip(resultText(block.content), 4000), failed: block.is_error === true });
      }
    }
  }
  if (event.type === 'result') {
    // Per model when it says (a run can use a small model on the side), else the whole run.
    const models = event.modelUsage && typeof event.modelUsage === 'object' ? Object.entries(event.modelUsage) : [];
    if (models.length > 0) {
      for (const [model, u] of models) {
        out.push({
          type: 'usage',
          model,
          usage: { input: count(u.inputTokens), output: count(u.outputTokens), cacheRead: count(u.cacheReadInputTokens), cacheWrite: count(u.cacheCreationInputTokens) },
          cost: typeof u.costUSD === 'number' ? u.costUSD : null,
        });
      }
    } else if (event.usage) {
      const u = event.usage;
      out.push({
        type: 'usage',
        model: null,
        usage: { input: count(u.input_tokens), output: count(u.output_tokens), cacheRead: count(u.cache_read_input_tokens), cacheWrite: count(u.cache_creation_input_tokens) },
        cost: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
      });
    }
  }
  if (event.type === 'result' && event.is_error) {
    out.push({ type: 'error', message: typeof event.result === 'string' && event.result ? event.result : 'Claude Code stopped with an error' });
  }
  return out;
}

/** One line of `codex exec --json` as chat events (current and older event shapes). */
export function parseCodexLine(line: string): CliEvent[] {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  const out: CliEvent[] = [];
  const type = event.type;
  if (type === 'thread.started' && typeof event.thread_id === 'string') out.push({ type: 'session', id: event.thread_id });
  if ((type === 'item.started' || type === 'item.completed') && event.item && typeof event.item === 'object') {
    const item = event.item as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : String(Math.random());
    const done = type === 'item.completed';
    if (item.type === 'agent_message' && done && typeof item.text === 'string') out.push({ type: 'text', text: item.text });
    if (item.type === 'command_execution') {
      const command = typeof item.command === 'string' ? item.command : '';
      if (!done) out.push({ type: 'tool', id, name: 'command', summary: command });
      else {
        out.push({ type: 'tool', id, name: 'command', summary: command });
        const exit = typeof item.exit_code === 'number' ? item.exit_code : 0;
        out.push({ type: 'tool_result', id, output: clip(String(item.aggregated_output ?? ''), 4000), failed: exit !== 0 });
      }
    }
    if (item.type === 'file_change' && done) {
      const changes = Array.isArray(item.changes) ? (item.changes as { path?: unknown; kind?: unknown }[]) : [];
      const summary = changes.map((c) => `${String(c.kind ?? 'edit')} ${String(c.path ?? '')}`).join(', ');
      out.push({ type: 'tool', id, name: 'file change', summary });
      out.push({ type: 'tool_result', id, output: '', failed: item.status === 'failed' });
    }
  }
  if (type === 'turn.completed' && event.usage && typeof event.usage === 'object') {
    // Input tokens include the cached ones.
    const u = event.usage as Record<string, unknown>;
    const cached = Math.min(count(u.input_tokens), count(u.cached_input_tokens));
    out.push({ type: 'usage', model: null, usage: { input: count(u.input_tokens) - cached, output: count(u.output_tokens), cacheRead: cached, cacheWrite: 0 }, cost: null });
  }
  if (type === 'turn.failed' || type === 'error') {
    const error = event.error as { message?: unknown } | undefined;
    const message = typeof event.message === 'string' ? event.message : typeof error?.message === 'string' ? error.message : 'Codex stopped with an error';
    out.push({ type: 'error', message });
  }
  // Older Codex versions: {"msg": {"type": "agent_message", "message": "..."}}
  const msg = event.msg as Record<string, unknown> | undefined;
  if (msg && msg.type === 'agent_message' && typeof msg.message === 'string') out.push({ type: 'text', text: msg.message });
  return out;
}

/** Quotes an argument for cmd.exe, which runs .cmd shims such as the npm-installed `claude`. */
function quoteForCmd(arg: string): string {
  return /^[\w\-.:\\/=@]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

export function spawnCli(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  const windows = process.platform === 'win32';
  return spawn(windows ? quoteForCmd(command) : command, windows ? args.map(quoteForCmd) : args, {
    cwd: options.cwd,
    env: options.env,
    shell: windows,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export interface CliRunOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  signal: AbortSignal;
  parse: (line: string) => CliEvent[];
  onEvent: (event: CliEvent) => void;
}

/** Runs a CLI agent to completion; resolves with its exit code. Stops it on abort. */
export function runCli(options: CliRunOptions): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnCli(options.command, options.args, { cwd: options.cwd, env: options.env });
    } catch (error) {
      options.onEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      resolve({ exitCode: null, stderr: '' });
      return;
    }
    const stop = () => child.kill();
    options.signal.addEventListener('abort', stop, { once: true });
    let buffer = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) for (const event of options.parse(line)) options.onEvent(event);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 8000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => options.onEvent({ type: 'error', message: error.message }));
    child.on('close', (code) => {
      options.signal.removeEventListener('abort', stop);
      if (buffer.trim()) for (const event of options.parse(buffer.trim())) options.onEvent(event);
      resolve({ exitCode: code, stderr });
    });
    child.stdin?.end(options.prompt);
  });
}

export interface HookRequest {
  chatId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

export type HookDecider = (request: HookRequest) => Promise<{ allow: boolean; reason: string }>;

/**
 * The local endpoint Claude Code's hook asks. Listens on 127.0.0.1 only, and
 * every request must carry this run's token.
 */
export class HookServer {
  private server: Server | null = null;
  readonly token = randomBytes(24).toString('hex');
  private settingsFile: string | null = null;
  url = '';

  constructor(private readonly decide: HookDecider) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/hook' || req.headers.authorization !== `Bearer ${this.token}`) {
        res.writeHead(403).end();
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => {
        if (body.length < 4 * 1024 * 1024) body += chunk.toString('utf8');
      });
      req.on('end', () => {
        void (async () => {
          let answer = { allow: false, reason: 'Foreus could not read the request' };
          try {
            const data = JSON.parse(body) as { chatId?: unknown; event?: { tool_name?: unknown; tool_input?: unknown } };
            if (typeof data.chatId === 'string' && typeof data.event?.tool_name === 'string') {
              answer = await this.decide({
                chatId: data.chatId,
                toolName: data.event.tool_name,
                toolInput: (data.event.tool_input && typeof data.event.tool_input === 'object' ? data.event.tool_input : {}) as Record<string, unknown>,
              });
            }
          } catch (error) {
            answer = { allow: false, reason: error instanceof Error ? error.message : String(error) };
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
        })();
      });
    });
    // A request can wait on a person's approval for a long time.
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.server = server;
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  }

  /**
   * Claude Code settings that run our hook before every tool. Written to a
   * temporary file because it is passed with --settings.
   */
  claudeSettingsFile(hookScript: string, nodePath: string): string {
    if (this.settingsFile) return this.settingsFile;
    const command = `"${nodePath}" "${hookScript}"`;
    const settings = { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 3600 }] }] } };
    const file = join(tmpdir(), `pct-claude-settings-${randomBytes(6).toString('hex')}.json`);
    writeFileSync(file, JSON.stringify(settings), { mode: 0o600 });
    this.settingsFile = file;
    return file;
  }

  /** Environment the hook script reads. */
  env(chatId: string): Record<string, string> {
    return { PCT_HOOK_URL: this.url, PCT_HOOK_TOKEN: this.token, PCT_CHAT_ID: chatId };
  }

  async stop(): Promise<void> {
    if (this.settingsFile) rmSync(this.settingsFile, { force: true });
    this.settingsFile = null;
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

import type { ChildProcess } from 'node:child_process';
import { spawnCli } from './cli.js';

// A small client for MCP servers that run as a local process and speak
// JSON-RPC over stdin and stdout (the "stdio" transport), such as the Godot
// MCP server and Summer Engine's. The app talks to the engine's server itself
// and passes the tools on to agents, so every call goes through our checks
// first (see engine.ts and runner.ts); agents never reach the server directly.

export interface McpServerCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  /** The text parts of the answer, joined. */
  text: string;
  isError: boolean;
}

const PROTOCOL_VERSION = '2025-06-18';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class McpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private stderr = '';
  private starting: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly server: McpServerCommand,
    private readonly options: { label: string; startTimeoutMs?: number; callTimeoutMs?: number } = { label: 'MCP server' },
  ) {}

  get running(): boolean {
    return this.child !== null && !this.closed;
  }

  /** Starts the server and says hello; resolves once it is ready. */
  start(): Promise<void> {
    this.starting ??= this.open().catch((error: unknown) => {
      this.close();
      this.starting = null;
      throw error;
    });
    return this.starting;
  }

  private async open() {
    this.closed = false;
    const child = spawnCli(this.server.command, this.server.args, {
      cwd: this.server.cwd ?? process.cwd(),
      env: { ...process.env, ...this.server.env },
    });
    this.child = child;
    this.buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.child === child) this.take(chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4000);
    });
    const exited = new Promise<never>((_, reject) => {
      child.on('error', (error) => reject(new Error(`${this.options.label} could not be started: ${error.message}`)));
      child.on('close', (code) => {
        const why = new Error(`${this.options.label} stopped (exit code ${code ?? 'none'})${this.lastError()}`);
        reject(why);
        // Closed by us, and maybe started again since: nothing more to do.
        if (this.child !== child) return;
        this.closed = true;
        this.child = null;
        // The next call starts it again.
        this.starting = null;
        for (const waiter of this.pending.values()) waiter.reject(why);
        this.pending.clear();
      });
    });
    // Unhandled once the server is running; the pending requests hear about it instead.
    exited.catch(() => {});
    await Promise.race([
      this.request(
        'initialize',
        { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'foreus', version: '1' } },
        this.options.startTimeoutMs ?? 60_000,
      ),
      exited,
    ]);
    this.notify('notifications/initialized', {});
  }

  private lastError(): string {
    const line = this.stderr.trim().split('\n').filter(Boolean).at(-1);
    return line ? `: ${line.slice(0, 300)}` : '';
  }

  private take(text: string) {
    this.buffer += text;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: unknown } };
      try {
        message = JSON.parse(line);
      } catch {
        // Servers sometimes log to stdout; that is not ours to read.
        continue;
      }
      if (typeof message.method === 'string') {
        // The server asks something of us (ping, roots): answer what we can.
        if (message.id !== undefined) this.answer(message.id, message.method);
        continue;
      }
      if (typeof message.id !== 'number') continue;
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(String(message.error.message ?? 'The engine server answered with an error')));
      else waiter.resolve(message.result);
    }
  }

  private answer(id: unknown, method: string) {
    if (method === 'ping') this.send({ jsonrpc: '2.0', id, result: {} });
    else if (method === 'roots/list') this.send({ jsonrpc: '2.0', id, result: { roots: [] } });
    else this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `${method} is not supported` } });
  }

  private send(message: unknown) {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private notify(method: string, params: unknown) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (!this.child || this.closed) return Promise.reject(new Error(`${this.options.label} is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.notify('notifications/cancelled', { requestId: id, reason: 'timeout' });
        done();
        reject(new Error(`${this.options.label} did not answer within ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      const onAbort = () => {
        this.pending.delete(id);
        this.notify('notifications/cancelled', { requestId: id, reason: 'stopped' });
        done();
        reject(new Error('stopped'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          done();
          resolve(value);
        },
        reject: (error) => {
          done();
          reject(error);
        },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async listTools(): Promise<McpTool[]> {
    await this.start();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = (await this.request('tools/list', cursor ? { cursor } : {}, 30_000)) as { tools?: unknown; nextCursor?: unknown };
      for (const tool of Array.isArray(result?.tools) ? (result.tools as Record<string, unknown>[]) : []) {
        if (typeof tool.name !== 'string') continue;
        tools.push({
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? (tool.inputSchema as Record<string, unknown>) : { type: 'object' },
        });
      }
      if (typeof result?.nextCursor !== 'string' || !result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    await this.start();
    const result = (await this.request('tools/call', { name, arguments: args }, this.options.callTimeoutMs ?? 5 * 60_000, signal)) as {
      content?: unknown;
      structuredContent?: unknown;
      isError?: unknown;
    };
    const parts = Array.isArray(result?.content) ? (result.content as Record<string, unknown>[]) : [];
    const texts = parts.map((p) => (p.type === 'text' && typeof p.text === 'string' ? p.text : p.type === 'image' ? '[image]' : '')).filter(Boolean);
    if (texts.length === 0 && result?.structuredContent !== undefined) texts.push(JSON.stringify(result.structuredContent));
    return { text: texts.join('\n'), isError: result?.isError === true };
  }

  close() {
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.starting = null;
    for (const waiter of this.pending.values()) waiter.reject(new Error(`${this.options.label} was closed`));
    this.pending.clear();
    if (child) {
      child.stdin?.end();
      child.kill();
    }
  }
}

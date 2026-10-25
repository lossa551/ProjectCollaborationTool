import type { SessionInfo } from '@pct/shared';

// Where the server keeps durable state. The in-memory store is enough while the
// session only has presence; SQLite comes next, and Postgres when the server
// moves to a hosted machine. All of them implement this interface.

export interface SessionEvent {
  at: number;
  type: string;
  actorId: string | null;
  data: Record<string, unknown>;
}

export interface Storage {
  loadSession(): Promise<SessionInfo | null>;
  saveSession(session: SessionInfo): Promise<void>;
  /** Append-only log of what happened, for the activity feed and undo. */
  appendEvent(event: SessionEvent): Promise<void>;
  listEvents(limit?: number): Promise<SessionEvent[]>;
  close(): Promise<void>;
}

export class MemoryStorage implements Storage {
  private session: SessionInfo | null = null;
  private readonly events: SessionEvent[] = [];

  async loadSession() {
    return this.session;
  }

  async saveSession(session: SessionInfo) {
    this.session = session;
  }

  async appendEvent(event: SessionEvent) {
    this.events.push(event);
  }

  async listEvents(limit = 100) {
    return this.events.slice(-limit);
  }

  async close() {}
}

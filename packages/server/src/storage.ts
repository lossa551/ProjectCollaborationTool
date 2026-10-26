import type {
  Activity,
  AgentProfile,
  BloatReport,
  ChatInfo,
  ChatMessage,
  Lock,
  LockRules,
  ParticipantKind,
  RepoRef,
  SessionInfo,
  Task,
  DocId,
} from '@pct/shared';

// Where the server keeps durable state. The in-memory store is the first
// implementation; SqliteStorage keeps it on disk, and Postgres when the server
// moves to a hosted machine. All of them implement this interface.

/**
 * A person or agent the server has seen before. The client proves it is the
 * same one by presenting the token whose hash is stored here.
 */
export interface Identity {
  id: string;
  name: string;
  kind: ParticipantKind;
  createdAt: number;
  lastSeenAt: number;
}

export interface Storage {
  loadSession(): Promise<SessionInfo | null>;
  saveSession(session: SessionInfo): Promise<void>;
  /** The session secret, kept so invite codes stay valid across restarts. */
  loadSecret(): Promise<string | null>;
  saveSecret(secret: string): Promise<void>;
  findIdentity(tokenHash: string): Promise<Identity | null>;
  saveIdentity(tokenHash: string, identity: Identity): Promise<void>;
  listTasks(): Promise<Task[]>;
  saveTask(task: Task): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  listLocks(): Promise<Lock[]>;
  saveLock(lock: Lock): Promise<void>;
  deleteLock(lockId: string): Promise<void>;
  /** Null until someone changes the rules; the server then uses the defaults. */
  loadLockRules(): Promise<LockRules | null>;
  saveLockRules(rules: LockRules): Promise<void>;
  /** The GitHub repository the session is linked to. */
  loadGitHubRepo(): Promise<RepoRef | null>;
  saveGitHubRepo(repo: RepoRef | null): Promise<void>;
  listAgents(): Promise<AgentProfile[]>;
  saveAgent(agent: AgentProfile): Promise<void>;
  deleteAgent(agentId: string): Promise<void>;
  listChats(): Promise<ChatInfo[]>;
  saveChat(chat: ChatInfo): Promise<void>;
  /** Deletes the chat and its messages. */
  deleteChat(chatId: string): Promise<void>;
  /** The most recent messages of a chat, oldest first. */
  listChatMessages(chatId: string, limit?: number): Promise<ChatMessage[]>;
  /** Adds a message, or replaces the one with the same id. */
  saveChatMessage(message: ChatMessage): Promise<void>;
  /** The shared documents (planning space, project memory) as encoded Yjs state. */
  loadDocs(): Promise<Partial<Record<DocId, Uint8Array>>>;
  saveDoc(docId: DocId, state: Uint8Array): Promise<void>;
  /** The last bloat check anyone shared. */
  loadBloat(): Promise<BloatReport | null>;
  saveBloat(report: BloatReport): Promise<void>;
  /** Append-only log of what happened, for the activity feed and later undo. */
  appendActivity(entry: Activity): Promise<void>;
  /** The most recent entries, oldest first. */
  listActivity(limit?: number): Promise<Activity[]>;
  close(): Promise<void>;
}

export class MemoryStorage implements Storage {
  private session: SessionInfo | null = null;
  private secret: string | null = null;
  private readonly identities = new Map<string, Identity>();
  private readonly tasks = new Map<string, Task>();
  private readonly locks = new Map<string, Lock>();
  private lockRules: LockRules | null = null;
  private githubRepo: RepoRef | null = null;
  private readonly activity: Activity[] = [];
  private readonly agents = new Map<string, AgentProfile>();
  private readonly chats = new Map<string, ChatInfo>();
  private readonly chatMessages = new Map<string, ChatMessage[]>();
  private readonly docs: Partial<Record<DocId, Uint8Array>> = {};
  private bloat: BloatReport | null = null;

  async loadSession() {
    return this.session;
  }

  async saveSession(session: SessionInfo) {
    this.session = session;
  }

  async loadSecret() {
    return this.secret;
  }

  async saveSecret(secret: string) {
    this.secret = secret;
  }

  async findIdentity(tokenHash: string) {
    return this.identities.get(tokenHash) ?? null;
  }

  async saveIdentity(tokenHash: string, identity: Identity) {
    this.identities.set(tokenHash, identity);
  }

  async listTasks() {
    return [...this.tasks.values()];
  }

  async saveTask(task: Task) {
    this.tasks.set(task.id, task);
  }

  async deleteTask(taskId: string) {
    this.tasks.delete(taskId);
  }

  async listLocks() {
    return [...this.locks.values()];
  }

  async saveLock(lock: Lock) {
    this.locks.set(lock.id, lock);
  }

  async deleteLock(lockId: string) {
    this.locks.delete(lockId);
  }

  async loadLockRules() {
    return this.lockRules;
  }

  async saveLockRules(rules: LockRules) {
    this.lockRules = rules;
  }

  async loadGitHubRepo() {
    return this.githubRepo;
  }

  async saveGitHubRepo(repo: RepoRef | null) {
    this.githubRepo = repo;
  }

  async listAgents() {
    return [...this.agents.values()];
  }

  async saveAgent(agent: AgentProfile) {
    this.agents.set(agent.id, agent);
  }

  async deleteAgent(agentId: string) {
    this.agents.delete(agentId);
  }

  async listChats() {
    return [...this.chats.values()];
  }

  async saveChat(chat: ChatInfo) {
    this.chats.set(chat.id, chat);
  }

  async deleteChat(chatId: string) {
    this.chats.delete(chatId);
    this.chatMessages.delete(chatId);
  }

  async listChatMessages(chatId: string, limit = 500) {
    return (this.chatMessages.get(chatId) ?? []).slice(-limit);
  }

  async saveChatMessage(message: ChatMessage) {
    const list = this.chatMessages.get(message.chatId) ?? [];
    const index = list.findIndex((m) => m.id === message.id);
    if (index >= 0) list[index] = message;
    else list.push(message);
    this.chatMessages.set(message.chatId, list);
  }

  async loadDocs() {
    return { ...this.docs };
  }

  async saveDoc(docId: DocId, state: Uint8Array) {
    this.docs[docId] = state;
  }

  async loadBloat() {
    return this.bloat;
  }

  async saveBloat(report: BloatReport) {
    this.bloat = report;
  }

  async appendActivity(entry: Activity) {
    this.activity.push(entry);
  }

  async listActivity(limit = 100) {
    return this.activity.slice(-limit);
  }

  async close() {}
}

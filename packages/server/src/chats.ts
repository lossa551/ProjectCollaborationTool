import { randomUUID } from 'node:crypto';
import type {
  AgentProfile,
  AgentSaveMessage,
  ChatAgentState,
  ChatContext,
  ChatInfo,
  ChatMessage,
  ChatPostMessage,
  Handoff,
  Participant,
  TaskOwner,
} from '@pct/shared';
import type { Storage } from './storage.js';

// Agent profiles and the shared agent chats. People and agents post into the
// same chats; only the chat's own agent may post tool use and approval cards,
// and only people may decide an approval. Messages being streamed live only in
// memory until the agent finishes them, so a long answer is not written to
// disk a hundred times.

export type ChatResult<T> =
  | { ok: true; value: T; description: string | null }
  | { ok: false; code: 'not_found' | 'not_allowed' | 'conflict'; message: string };

/** Messages kept in memory per chat, and sent when a chat is opened. */
export const CHAT_HISTORY_LIMIT = 500;

const owner = (p: Participant): TaskOwner => ({ id: p.id, name: p.name, kind: p.kind });

export class AgentChats {
  private readonly agents = new Map<string, AgentProfile>();
  private readonly chats = new Map<string, ChatInfo>();
  /** Loaded lazily from storage, then kept up to date. */
  private readonly messages = new Map<string, ChatMessage[]>();

  constructor(
    agents: AgentProfile[],
    chats: ChatInfo[],
    private readonly storage: Storage,
  ) {
    for (const agent of agents) this.agents.set(agent.id, agent);
    // Nobody is working in a chat right after a restart.
    for (const chat of chats) this.chats.set(chat.id, { ...chat, state: 'idle', activity: null });
  }

  listAgents(): AgentProfile[] {
    return [...this.agents.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  getAgent(agentId: string): AgentProfile | undefined {
    return this.agents.get(agentId);
  }

  listChats(): ChatInfo[] {
    return [...this.chats.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  getChat(chatId: string): ChatInfo | undefined {
    return this.chats.get(chatId);
  }

  saveAgent(input: AgentSaveMessage['agent'], now = Date.now()): ChatResult<AgentProfile> {
    const existing = input.id ? this.agents.get(input.id) : undefined;
    if (input.id && !existing) return { ok: false, code: 'not_found', message: 'That agent no longer exists' };
    const agent: AgentProfile = {
      id: existing?.id ?? randomUUID(),
      name: input.name,
      connection: input.connection,
      responsibilities: input.responsibilities,
      allowedPaths: input.allowedPaths,
      approvals: input.approvals,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.agents.set(agent.id, agent);
    return { ok: true, value: agent, description: existing ? `changed agent ${agent.name}` : `added agent ${agent.name}` };
  }

  deleteAgent(agentId: string): ChatResult<AgentProfile> {
    const agent = this.agents.get(agentId);
    if (!agent) return { ok: false, code: 'not_found', message: 'That agent no longer exists' };
    this.agents.delete(agentId);
    return { ok: true, value: agent, description: `removed agent ${agent.name}` };
  }

  createChat(
    input: { id: string; agentId: string; title: string; taskId?: string | null; handoff?: Handoff | null },
    by: Participant,
    now = Date.now(),
  ): ChatResult<ChatInfo> {
    const existing = this.chats.get(input.id);
    // A replayed create changes nothing.
    if (existing) return { ok: true, value: existing, description: null };
    const agent = this.agents.get(input.agentId);
    if (!agent) return { ok: false, code: 'not_found', message: 'That agent no longer exists' };
    const chat: ChatInfo = {
      id: input.id,
      title: input.title,
      agentId: agent.id,
      taskId: input.taskId ?? null,
      createdBy: owner(by),
      handoff: input.handoff ?? null,
      branchedFrom: null,
      state: 'idle',
      activity: null,
      context: null,
      createdAt: now,
      updatedAt: now,
    };
    this.chats.set(chat.id, chat);
    this.messages.set(chat.id, []);
    const description = chat.handoff
      ? `handed off to ${agent.name}${chat.handoff.fromName ? ` from ${chat.handoff.fromName}` : ''}`
      : `started a chat with ${agent.name}: "${chat.title}"`;
    return { ok: true, value: chat, description };
  }

  /**
   * Starts a new chat with a copy of another chat's messages, up to and
   * including one of them, and a notice saying where it came from. The copies
   * get new ids; the original chat is not changed. Only the conversation is
   * branched, not the files the agent changed.
   */
  async branchChat(
    input: { id: string; fromChatId: string; fromMessageId: string; agentId?: string; title: string },
    by: Participant,
    now = Date.now(),
  ): Promise<ChatResult<{ chat: ChatInfo; messages: ChatMessage[] }>> {
    const existing = this.chats.get(input.id);
    // A replayed branch changes nothing.
    if (existing) return { ok: true, value: { chat: existing, messages: await this.history(existing.id) }, description: null };
    const parent = this.chats.get(input.fromChatId);
    if (!parent) return { ok: false, code: 'not_found', message: 'That chat no longer exists' };
    const agent = this.agents.get(input.agentId ?? parent.agentId);
    if (!agent) return { ok: false, code: 'not_found', message: 'That agent no longer exists' };
    const source = await this.history(parent.id);
    const end = source.findIndex((m) => m.id === input.fromMessageId);
    if (end < 0) return { ok: false, code: 'not_found', message: 'That message is no longer in the chat' };
    // The chat may have been created by a replay while loading.
    const raced = this.chats.get(input.id);
    if (raced) return { ok: true, value: { chat: raced, messages: await this.history(raced.id) }, description: null };

    const chat: ChatInfo = {
      id: input.id,
      title: input.title,
      agentId: agent.id,
      taskId: parent.taskId,
      createdBy: owner(by),
      handoff: parent.handoff,
      branchedFrom: { chatId: parent.id, messageId: input.fromMessageId, title: parent.title },
      state: 'idle',
      activity: null,
      context: null,
      createdAt: now,
      updatedAt: now,
    };
    const messages: ChatMessage[] = source.slice(0, end + 1).map((m) => ({
      ...m,
      id: randomUUID(),
      chatId: chat.id,
      // Nothing is still being written or waiting for an answer in the copy.
      streaming: false,
      approval: m.approval?.state === 'pending' ? { ...m.approval, state: 'expired' } : m.approval,
      tool: m.tool?.status === 'running' ? { ...m.tool, status: 'failed' } : m.tool,
    }));
    const switched = agent.id === parent.agentId ? '' : ` It continues with ${agent.name}.`;
    messages.push({
      id: randomUUID(),
      chatId: chat.id,
      author: owner(by),
      kind: 'notice',
      text:
        `${by.name} branched this chat from "${parent.title}".${switched} ` +
        'Only the conversation was branched: files changed later in the original chat are still changed in the project folder.',
      streaming: false,
      tool: null,
      approval: null,
      at: now,
      updatedAt: now,
    });
    this.chats.set(chat.id, chat);
    this.messages.set(chat.id, messages.slice(-CHAT_HISTORY_LIMIT));
    return { ok: true, value: { chat, messages }, description: `branched "${parent.title}" into "${chat.title}"` };
  }

  updateChat(chatId: string, changes: { title?: string; taskId?: string | null }, now = Date.now()): ChatResult<ChatInfo> {
    const chat = this.chats.get(chatId);
    if (!chat) return { ok: false, code: 'not_found', message: 'That chat no longer exists' };
    const next: ChatInfo = {
      ...chat,
      title: changes.title ?? chat.title,
      taskId: changes.taskId !== undefined ? changes.taskId : chat.taskId,
      updatedAt: now,
    };
    this.chats.set(chatId, next);
    return { ok: true, value: next, description: null };
  }

  deleteChat(chatId: string): ChatResult<ChatInfo> {
    const chat = this.chats.get(chatId);
    if (!chat) return { ok: false, code: 'not_found', message: 'That chat no longer exists' };
    this.chats.delete(chatId);
    this.messages.delete(chatId);
    return { ok: true, value: chat, description: `deleted the chat "${chat.title}"` };
  }

  /** Unlinks chats from a deleted task. */
  detachTask(taskId: string, now = Date.now()): ChatInfo[] {
    const changed: ChatInfo[] = [];
    for (const chat of this.chats.values()) {
      if (chat.taskId !== taskId) continue;
      const next = { ...chat, taskId: null, updatedAt: now };
      this.chats.set(chat.id, next);
      changed.push(next);
    }
    return changed;
  }

  async history(chatId: string): Promise<ChatMessage[]> {
    const cached = this.messages.get(chatId);
    if (cached) return cached;
    const loaded = await this.storage.listChatMessages(chatId, CHAT_HISTORY_LIMIT);
    // The chat may have been deleted, or filled by a post, while loading.
    if (!this.chats.has(chatId)) return [];
    const current = this.messages.get(chatId);
    if (current) return current;
    this.messages.set(chatId, loaded);
    return loaded;
  }

  /**
   * Adds a message or updates one the same participant posted before.
   * Returns the message and whether it should be saved now (it is finished).
   */
  async post(
    chatId: string,
    input: ChatPostMessage['message'],
    by: Participant,
    now = Date.now(),
  ): Promise<ChatResult<{ message: ChatMessage; persist: boolean }>> {
    const chat = this.chats.get(chatId);
    if (!chat) return { ok: false, code: 'not_found', message: 'That chat no longer exists' };
    const isChatAgent = by.kind === 'agent' && by.agent?.profileId === chat.agentId;
    if (by.kind === 'agent' && !isChatAgent) {
      return { ok: false, code: 'not_allowed', message: 'Only the chat’s own agent can post in it' };
    }
    if (by.kind === 'human' && (input.kind !== 'text' && input.kind !== 'handoff')) {
      return { ok: false, code: 'not_allowed', message: 'People can post text and handoffs' };
    }
    const list = await this.history(chatId);
    if (!this.chats.has(chatId)) return { ok: false, code: 'not_found', message: 'That chat no longer exists' };
    const index = list.findIndex((m) => m.id === input.id);
    const existing = index >= 0 ? list[index] : undefined;
    if (existing && existing.author.id !== by.id) {
      return { ok: false, code: 'not_allowed', message: 'You can only change your own messages' };
    }

    let approval: ChatMessage['approval'] = null;
    if (input.approval && isChatAgent) {
      if (existing?.approval && existing.approval.state !== 'pending') {
        // Decided by a person: the agent cannot change the outcome.
        approval = existing.approval;
      } else if (input.approval.state === 'pending' || input.approval.state === 'expired') {
        approval = { action: input.approval.action, reason: input.approval.reason, state: input.approval.state, decidedBy: null };
      } else {
        return { ok: false, code: 'not_allowed', message: 'Only a person can approve or deny' };
      }
    }

    const message: ChatMessage = {
      id: input.id,
      chatId,
      author: owner(by),
      kind: input.kind,
      text: input.text,
      streaming: isChatAgent ? (input.streaming ?? false) : false,
      tool: isChatAgent ? (input.tool ?? null) : null,
      approval,
      at: existing?.at ?? now,
      updatedAt: now,
    };
    if (existing) list[index] = message;
    else {
      list.push(message);
      if (list.length > CHAT_HISTORY_LIMIT) list.shift();
    }
    this.chats.set(chatId, { ...chat, updatedAt: now });
    return { ok: true, value: { message, persist: !message.streaming }, description: null };
  }

  /** A person approves or denies a pending request from the agent. */
  async decide(chatId: string, messageId: string, approve: boolean, by: Participant, now = Date.now()): Promise<ChatResult<ChatMessage>> {
    if (by.kind !== 'human') return { ok: false, code: 'not_allowed', message: 'Only a person can approve or deny' };
    const chat = this.chats.get(chatId);
    if (!chat) return { ok: false, code: 'not_found', message: 'That chat no longer exists' };
    const list = await this.history(chatId);
    const index = list.findIndex((m) => m.id === messageId);
    const existing = index >= 0 ? list[index] : undefined;
    if (!existing?.approval) return { ok: false, code: 'not_found', message: 'That request is gone' };
    if (existing.approval.state !== 'pending') {
      const who = existing.approval.decidedBy ? ` by ${existing.approval.decidedBy}` : '';
      return { ok: false, code: 'conflict', message: `Already ${existing.approval.state}${who}` };
    }
    const message: ChatMessage = {
      ...existing,
      approval: { ...existing.approval, state: approve ? 'approved' : 'denied', decidedBy: by.name },
      updatedAt: now,
    };
    list[index] = message;
    const agentName = this.agents.get(chat.agentId)?.name ?? existing.author.name;
    return {
      ok: true,
      value: message,
      description: `${approve ? 'approved' : 'denied'} ${agentName}: ${existing.approval.action}`,
    };
  }

  setAgentState(
    chatId: string,
    state: ChatAgentState,
    context: ChatContext | null | undefined,
    by: Participant,
    activity?: string | null,
  ): ChatResult<ChatInfo> {
    const chat = this.chats.get(chatId);
    if (!chat) return { ok: false, code: 'not_found', message: 'That chat no longer exists' };
    if (by.agent?.profileId !== chat.agentId) return { ok: false, code: 'not_allowed', message: 'Only the chat’s own agent reports its state' };
    const next: ChatInfo = {
      ...chat,
      state,
      activity: state === 'idle' ? null : activity !== undefined ? activity : chat.activity,
      context: context !== undefined ? context : chat.context,
    };
    this.chats.set(chatId, next);
    return { ok: true, value: next, description: null };
  }

  /**
   * An agent left: its unfinished messages are closed as they are, open
   * requests expire, and its chats go idle.
   */
  agentLeft(participant: Participant, now = Date.now()): { messages: ChatMessage[]; chats: ChatInfo[] } {
    const profileId = participant.agent?.profileId;
    if (!profileId) return { messages: [], chats: [] };
    const messages: ChatMessage[] = [];
    const chats: ChatInfo[] = [];
    for (const chat of this.chats.values()) {
      if (chat.agentId !== profileId) continue;
      if (chat.state !== 'idle') {
        const next = { ...chat, state: 'idle' as const, activity: null };
        this.chats.set(chat.id, next);
        chats.push(next);
      }
      const list = this.messages.get(chat.id) ?? [];
      list.forEach((m, i) => {
        if (m.author.id !== participant.id) return;
        const pending = m.approval?.state === 'pending';
        if (!m.streaming && !pending) return;
        const next: ChatMessage = {
          ...m,
          streaming: false,
          approval: pending ? { ...m.approval!, state: 'expired' } : m.approval,
          updatedAt: now,
        };
        list[i] = next;
        messages.push(next);
      });
    }
    return { messages, chats };
  }
}

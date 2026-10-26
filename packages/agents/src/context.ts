import {
  STAGE_LABELS,
  estimateTokens,
  renderHandoff,
  type AgentProfile,
  type ChatContext,
  type ChatInfo,
  type Task,
} from '@pct/shared';

// What an agent is told before it starts: its role and limits, the task, and
// the handoff it was given. The same pieces are listed in the chat's context
// panel, so everyone can see exactly what the agent knows.

export interface ContextInput {
  agent: AgentProfile;
  chat: ChatInfo;
  task: Task | null;
  /** Name of the person whose PC runs the agent. */
  startedBy: string;
}

interface Piece {
  label: string;
  detail: string;
  text: string;
}

function pieces({ agent, chat, task, startedBy }: ContextInput): Piece[] {
  const out: Piece[] = [];
  out.push({
    label: 'Role and rules',
    detail: agent.responsibilities.trim() ? agent.responsibilities.trim().slice(0, 200) : 'No responsibilities written yet',
    text: [
      `You are ${agent.name}, an AI agent in a shared live session where people and other agents work on the same project. ` +
        `You run on ${startedBy}'s PC, in their project folder. People in the session can read this chat and post in it; ` +
        'messages from them start with their name.',
      agent.responsibilities.trim() ? `Your responsibilities:\n${agent.responsibilities.trim()}` : '',
      'Every file edit and command you make is checked by the app against file locks, your allowed paths, the task’s allowed ' +
        'paths and the approval rules. Some actions wait for a person to approve them. If an action is blocked or denied, ' +
        'do not try to reach the same result another way: say what you need and why. Keep changes to what the task asks for, ' +
        'and avoid adding new systems, dependencies or files the task does not need. Paths are relative to the repository root.',
      agent.allowedPaths.length > 0 ? `You may change only these paths:\n${agent.allowedPaths.map((p) => `- ${p}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  });
  if (task) {
    const lines = [`Task: "${task.title}"`, `Stage: ${STAGE_LABELS[task.stage]}`];
    if (task.scope.length) lines.push(`Allowed paths for this task:\n${task.scope.map((s) => `- ${s}`).join('\n')}`);
    if (task.branch) lines.push(`Branch: ${task.branch}`);
    out.push({ label: 'Task', detail: `${task.title} · ${STAGE_LABELS[task.stage]}`, text: lines.join('\n') });
  }
  if (chat.handoff) {
    out.push({
      label: 'Handoff',
      detail: `${chat.handoff.criteria.length} acceptance criteria, ${chat.handoff.decisions.length} decisions`,
      text: renderHandoff(chat.handoff, task?.title ?? null),
    });
  }
  return out;
}

export function systemPrompt(input: ContextInput): string {
  return pieces(input)
    .map((p) => p.text)
    .join('\n\n');
}

/** The context panel's list: the pieces above, files the agent read, and the conversation. */
export function describeContext(input: ContextInput, extra: { filesRead: string[]; conversation: string }): ChatContext {
  const items = pieces(input).map((p) => ({ label: p.label, detail: p.detail, tokens: estimateTokens(p.text) }));
  for (const file of extra.filesRead.slice(-150)) items.push({ label: 'File', detail: file, tokens: 0 });
  const conversation = estimateTokens(extra.conversation);
  items.push({ label: 'Conversation', detail: 'Messages and tool results so far', tokens: conversation });
  return { items, tokens: items.reduce((sum, item) => sum + item.tokens, 0) };
}

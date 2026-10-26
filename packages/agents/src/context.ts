import {
  CRITERION_STATE_LABELS,
  STAGE_LABELS,
  estimateTokens,
  renderHandoff,
  renderFolderNotes,
  renderMemory,
  type FolderNote,
  type MemoryEntry,
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
  /** Project memory: decisions, conventions, known issues and plans. */
  memory: MemoryEntry[];
  /** AGENTS.md notes for the folders the task touches, shallowest first (see notesForPaths). */
  folderNotes: FolderNote[];
  /** The chat's own copy of the project (branch and what it started from); null when it works in the project folder. */
  worktree: { branch: string; base: string | null } | null;
  /** The agent has the record_test_result tool (our own loop); CLI agents report results in the chat instead. */
  recordsResults: boolean;
}

interface Piece {
  label: string;
  detail: string;
  text: string;
}

function pieces({ agent, chat, task, startedBy, memory, folderNotes, recordsResults, worktree }: ContextInput): Piece[] {
  const out: Piece[] = [];
  out.push({
    label: 'Role and rules',
    detail: agent.responsibilities.trim() ? agent.responsibilities.trim().slice(0, 200) : 'No responsibilities written yet',
    text: [
      `You are ${agent.name}, an AI agent in a shared live session where people and other agents work on the same project. ` +
        (worktree
          ? `You run on ${startedBy}'s PC, in your own copy of the project (a git worktree on branch ${worktree.branch}` +
            `${worktree.base ? `, started from ${worktree.base}` : ''}). Your changes stay in this copy until a person reviews and ` +
            'merges them; do not commit, switch branches or merge yourself. '
          : `You run on ${startedBy}'s PC, in their project folder. `) +
        'People in the session can read this chat and post in it; messages from them start with their name.',
      agent.responsibilities.trim() ? `Your responsibilities:\n${agent.responsibilities.trim()}` : '',
      'Every file edit and command you make is checked by the app against file locks, your allowed paths, the task’s allowed ' +
        'paths and the approval rules. The app locks each file for you before your first edit to it, so others can see what ' +
        'you are working on; if someone else holds a file, it waits for them first. Some actions wait for a person to ' +
        'approve them. If an action is blocked or denied, ' +
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
    if (task.readFirst.length) {
      lines.push(`Read these first; start from them instead of exploring the project:\n${task.readFirst.map((s) => `- ${s}`).join('\n')}`);
    }
    if (task.branch) lines.push(`Branch: ${task.branch}`);
    if (task.criteria.length) {
      lines.push(
        `Acceptance criteria (id, state, text):\n${task.criteria.map((c) => `- [${c.id}] ${CRITERION_STATE_LABELS[c.state]}: ${c.text}`).join('\n')}`,
        recordsResults
          ? 'When you have checked a criterion (for example by running the tests), record the result with record_test_result, ' +
              'saying what you checked. Only mark it verified when you saw it work.'
          : 'When you have checked a criterion, say in the chat which one, whether it passed and how you checked it, so a person can record the result.',
      );
    }
    out.push({ label: 'Task', detail: `${task.title} · ${STAGE_LABELS[task.stage]}`, text: lines.join('\n') });
  }
  const remembered = renderMemory(memory);
  if (remembered) {
    out.push({
      label: 'Project memory',
      detail: `${memory.length} ${memory.length === 1 ? 'entry' : 'entries'}`,
      text: `Project memory, agreed by the team. Follow these decisions and conventions, and keep the known issues in mind:\n\n${remembered}`,
    });
  }
  const notes = renderFolderNotes(folderNotes);
  if (notes.text) {
    out.push({
      label: 'Folder notes',
      detail:
        notes.included.map((n) => n.path).join(', ') +
        (notes.skipped.length ? `${notes.included.length ? '; ' : ''}${notes.skipped.length} more listed by path` : ''),
      text: notes.text,
    });
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

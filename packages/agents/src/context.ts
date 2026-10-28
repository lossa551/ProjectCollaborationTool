import {
  CRITERION_STATE_LABELS,
  STAGE_LABELS,
  estimateTokens,
  renderHandoff,
  renderFolderNotes,
  renderMemory,
  MEMORY_EXPORT_PATH,
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
  /** The chat's task's other chats: memory saved from them comes first (see memoryOrder). */
  taskChatIds?: string[];
  /** The agent has the read_memory tool (our own loop); CLI agents read docs/project-memory.md instead. */
  readsMemory?: boolean;
  /** AGENTS.md notes for the folders the task touches, shallowest first (see notesForPaths). */
  folderNotes: FolderNote[];
  /** The chat's own copy of the project (branch and what it started from); null when it works in the project folder. */
  worktree: { branch: string; base: string | null } | null;
  /** The agent has the record_test_result tool (our own loop); CLI agents report results in the chat instead. */
  recordsResults: boolean;
  /** A Godot (or Summer Engine) or Unreal project, when the agent uses the engine on this PC (issues #10, #11). */
  engine?: {
    /** The engine server's name, when the agent has its tools. */
    bridge: string | null;
    /** The tools drive an editor that has the project open (Summer, Unreal), rather than a headless Godot. */
    liveEditor: boolean;
    /** The project.godot folder, repo-relative ('' for the top, and for Unreal projects). */
    godotDir: string;
    /** An Unreal project: the .uproject's folder (repo-relative) and name; null for Godot. */
    unreal?: { dir: string; name: string } | null;
    /** The same folder on disk. */
    projectDir: string;
    /** How to run the tests: 'tool' for run_tests, else the command; null when they cannot run. */
    tests: string | null;
  } | null;
}

/** What an agent is told about an Unreal project (issue #11). */
function unrealPiece(engine: NonNullable<ContextInput['engine']>, project: { dir: string; name: string }): Piece {
  const content = project.dir ? `${project.dir}/Content` : 'Content';
  const lines = [
    `This is an Unreal Engine project (${project.name}.uproject${project.dir ? ` in ${project.dir}/` : ''}). /Game/ object paths are files in ${content}/: ` +
      '/Game/X/BP_Door is X/BP_Door.uasset, a level is .umap. Assets and levels are binary: change them in the editor, never by writing the files.',
    `Follow Epic's folder structure and asset naming (AGENTS.md has the pages): new assets go in ${content}/${project.name}/ (Assets/, Envs/ for ` +
      `levels, Sequences/, Media/, Tools/) or ${content}/Common/, named [Prefix]_[Name]_[Descriptor]_[Variant] (BP_, WBP_, M_, MI_, SM_, SK_, ` +
      'T_, DT_, E_, F_, FXS_, ...). The app refuses engine calls that would put a new asset elsewhere or name it otherwise.',
  ];
  if (engine.bridge) {
    lines.push(
      `You have the ${engine.bridge}'s tool \`unreal\`: it works in the Unreal Editor that has the project open. Use its operations in order: ` +
        'search (2-4 plain words), describe (the exact contract, and the consent grant a delete needs), then execute with tool + action ' +
        'and params. Copy each answer\'s nextCall instead of guessing names. If it answers NOT_CONNECTED, the editor is not open: say so ' +
        'and work on code and files meanwhile.',
      'Engine calls that change assets or levels are checked like file edits (an exclusive lock on each .uasset/.umap, allowed paths, ' +
        'approvals); deletes always ask a person; placing actors, saving everything, playing the game, console commands and Python ' +
        'follow the rule for commands. Save what you changed (control_editor save_all) before you finish, so it reaches the files.',
    );
  }
  if (engine.tests) {
    lines.push(
      engine.tests === 'tool'
        ? 'Run the automation tests with run_tests (Unreal Automation, headless; it takes minutes), and use the result as evidence for the acceptance criteria.'
        : `Run the automation tests with this command (headless; it takes minutes), and use the result as evidence for the acceptance criteria:\n${engine.tests}`,
    );
  }
  return { label: 'Game engine', detail: engine.bridge ?? 'Unreal project', text: lines.join('\n') };
}

interface Piece {
  label: string;
  detail: string;
  text: string;
}

function pieces({ agent, chat, task, startedBy, memory, taskChatIds, readsMemory, folderNotes, recordsResults, worktree, engine }: ContextInput): Piece[] {
  const out: Piece[] = [];
  out.push({
    label: 'Role and rules',
    detail: agent.responsibilities.trim() ? agent.responsibilities.trim().slice(0, 200) : 'No responsibilities written yet',
    text: [
      `You are ${agent.name}, an AI agent in a shared live session where people and other agents work on the same project. ` +
        (worktree
          ? `You run on ${startedBy}'s PC, in your own copy of the project (a git worktree on branch ${worktree.branch}` +
            `${worktree.base ? `, started from ${worktree.base}` : ''}). Your changes stay in this copy until a person reviews and ` +
            'merges them; do not commit, switch branches or merge yourself. The app saves each of your turns as a commit, so people ' +
            'can undo a turn; when they do, you are told which files went back. '
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
  if (engine?.unreal) {
    out.push(unrealPiece(engine, engine.unreal));
  } else if (engine) {
    const where = engine.godotDir ? `in ${engine.godotDir}/ (res:// is that folder)` : 'in the top folder (res:// is the repository root)';
    const lines = [`This is a Godot project ${where}. It may be opened in Godot or in Summer Engine, which is built on Godot.`];
    if (engine.bridge) {
      lines.push(
        engine.liveEditor
          ? `You have ${engine.bridge}'s tools: they work in the editor that has the project open. Prefer them for scene changes ` +
              '(adding nodes, setting properties, saving scenes): Summer checks each write against the latest version and refuses stale ones. ' +
              'If it refuses because a file changed, read it again before retrying.'
          : `You have the ${engine.bridge}'s tools (their names start with godot_). They run Godot on your folder; ` +
              `projectPath is always ${engine.projectDir}. Prefer them for creating scenes and adding nodes.`,
        'Engine tools that change scenes or resources are checked like file edits (locks, allowed paths, approvals), and ' +
          'running the game or editor scripts follows the rule for commands.',
      );
    }
    if (engine.tests) {
      lines.push(
        engine.tests === 'tool'
          ? 'Run the game’s tests with run_tests, and use the result as evidence for the acceptance criteria.'
          : `Run the game’s tests with this command, and use the result as evidence for the acceptance criteria:\n${engine.tests}`,
      );
    }
    out.push({ label: 'Game engine', detail: engine.bridge ?? 'Godot project', text: lines.join('\n') });
  }
  const remembered = renderMemory(memory, {
    focus: {
      chatIds: [chat.id, ...(taskChatIds ?? [])],
      paths: [...(task?.scope ?? []), ...(task?.readFirst ?? []), ...(chat.handoff?.scope ?? []), ...(chat.handoff?.readFirst ?? [])],
    },
    readHint: readsMemory
      ? 'read one with read_memory when it concerns your work'
      : `their full text is in ${MEMORY_EXPORT_PATH}; read it there when one concerns your work, if the file is there`,
  });
  if (remembered.text) {
    const shown = remembered.included.length + remembered.listed.length;
    const parts = [`${shown} ${shown === 1 ? 'entry' : 'entries'}`];
    if (remembered.listed.length) parts.push(`${remembered.listed.length} by title only`);
    if (remembered.archived) parts.push(`${remembered.archived} archived left out`);
    out.push({
      label: 'Project memory',
      detail: parts.join(', '),
      text: `Project memory, agreed by the team. Follow these decisions and conventions, and keep the known issues in mind:\n\n${remembered.text}`,
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
export function describeContext(
  input: ContextInput,
  extra: {
    filesRead: string[];
    conversation: string;
    /** Prompt tokens the provider counted for the agent's last call, when there was one. */
    measured?: number | null;
    /** Old tool results and inputs shortened so far (see trimHistory). */
    trimmed?: number;
    /** When to suggest continuing in a new chat; null for agents that keep their own context. */
    warnAt?: number | null;
  },
): ChatContext {
  const items = pieces(input).map((p) => ({ label: p.label, detail: p.detail, tokens: estimateTokens(p.text) }));
  for (const file of extra.filesRead.slice(-150)) items.push({ label: 'File', detail: file, tokens: 0 });
  const conversation = estimateTokens(extra.conversation);
  const trimmed = extra.trimmed ?? 0;
  items.push({
    label: 'Conversation',
    detail: `Messages and tool results so far${trimmed ? ` (${trimmed} old ${trimmed === 1 ? 'result' : 'results'} shortened)` : ''}`,
    tokens: conversation,
  });
  const estimated = items.reduce((sum, item) => sum + item.tokens, 0);
  return { items, tokens: extra.measured || estimated, warnAt: extra.warnAt ?? null, trimmed };
}

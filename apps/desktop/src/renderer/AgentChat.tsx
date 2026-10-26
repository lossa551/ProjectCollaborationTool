import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  MEMORY_KIND_SINGULAR,
  MemoryKind,
  STAGE_LABELS,
  TaskStage,
  describeConnection,
  type AgentProfile,
  type ChatInfo,
  type ChatMessage,
  type Task,
} from '@pct/shared';
import type { AppState, WorktreeAction } from '../common/api';
import { runnerOf } from './Agents';
import { Avatar } from './Avatar';

// Screen 7: shared agent chats. Everyone in the session sees every chat live
// and can post in it; the agent answers from the PC that runs it. Edits and
// commands that need a person show up as approval cards anyone can decide.

const STATE_LABEL = { idle: null, working: 'Working…', waiting: 'Waiting' } as const;

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function pendingCount(messages: ChatMessage[] | undefined): number {
  return (messages ?? []).filter((m) => m.approval?.state === 'pending').length;
}

export function ChatScreen({
  state,
  chatId,
  onSelect,
  newChatAgentId,
  onSetup,
}: {
  state: AppState;
  chatId: string | null;
  onSelect: (chatId: string | null) => void;
  /** Open the new chat form with this agent picked (from agent setup). */
  newChatAgentId: string | null;
  /** Opens agent setup (Settings). */
  onSetup: () => void;
}) {
  const { session } = state;
  const [composing, setComposing] = useState(newChatAgentId !== null || session.chats.length === 0);
  useEffect(() => {
    if (newChatAgentId) setComposing(true);
  }, [newChatAgentId]);
  const chat = session.chats.find((c) => c.id === chatId) ?? null;
  const sorted = [...session.chats].sort((a, b) => b.updatedAt - a.updatedAt);

  // Load each chat's messages once it is opened (and again after a reconnect).
  const opened = useRef(new Set<string>());
  useEffect(() => {
    if (session.status !== 'connected') opened.current.clear();
  }, [session.status]);
  useEffect(() => {
    if (!chat || session.status !== 'connected' || opened.current.has(chat.id)) return;
    opened.current.add(chat.id);
    window.pct.openChat(chat.id);
  }, [chat, session.status]);

  return (
    <div className="chat-screen">
      <aside className="chat-list">
        <button onClick={() => setComposing(true)} disabled={session.status !== 'connected' || session.agents.length === 0}>
          New chat
        </button>
        {session.agents.length === 0 && <p className="muted small">Add an agent first.</p>}
        <ul>
          {sorted.map((c) => {
            const agent = session.agents.find((a) => a.id === c.agentId);
            const pending = pendingCount(session.messages[c.id]);
            return (
              <li key={c.id}>
                <button
                  className={c.id === chatId ? 'chat-item active' : 'chat-item'}
                  onClick={() => {
                    setComposing(false);
                    onSelect(c.id);
                  }}
                >
                  <span className="chat-item-title">{c.title}</span>
                  <span className="muted small">
                    {agent?.name ?? 'Removed agent'}
                    {STATE_LABEL[c.state] && <span className="warning"> · {STATE_LABEL[c.state]}</span>}
                    {pending > 0 && <span className="nav-count">{pending}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <button className="link small chat-setup" onClick={onSetup}>
          {session.agents.length === 0 ? 'Add an agent' : 'Set up agents'}
        </button>
      </aside>
      {composing ? (
        <NewChat
          state={state}
          agentId={newChatAgentId}
          onCreated={(id) => {
            setComposing(false);
            onSelect(id);
          }}
          onCancel={session.chats.length > 0 ? () => setComposing(false) : undefined}
        />
      ) : chat ? (
        <Conversation key={chat.id} state={state} chat={chat} onSelect={onSelect} />
      ) : (
        <div className="chat-empty muted">Pick a chat, or start a new one.</div>
      )}
    </div>
  );
}

function NewChat({
  state,
  agentId,
  onCreated,
  onCancel,
}: {
  state: AppState;
  agentId: string | null;
  onCreated: (chatId: string) => void;
  onCancel?: () => void;
}) {
  const { session } = state;
  const [agent, setAgent] = useState(agentId ?? session.agents[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [taskId, setTaskId] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (agentId) setAgent(agentId);
  }, [agentId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const task = session.tasks.find((t) => t.id === taskId);
    const result = await window.pct.createChat({ agentId: agent, title: title.trim() || task?.title || 'New chat', taskId: taskId || null });
    if (result.ok) onCreated(result.value);
    else setError(result.error);
  };

  return (
    <form className="card new-chat" onSubmit={(e) => void submit(e)}>
      <h2>New chat</h2>
      <label className="field">
        <span>Agent</span>
        <select value={agent} onChange={(e) => setAgent(e.target.value)} required>
          {session.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {describeConnection(a.connection)}
              {runnerOf(a, session.participants) ? '' : ' (not running)'}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Task (optional): the agent gets its plan and paths</span>
        <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
          <option value="">No task</option>
          {session.tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title} · {STAGE_LABELS[t.stage]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is this chat about?" maxLength={200} />
      </label>
      {error && <p className="error small">{error}</p>}
      <div className="row">
        <button type="submit" disabled={!agent}>
          Start chat
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function Conversation({ state, chat, onSelect }: { state: AppState; chat: ChatInfo; onSelect: (chatId: string) => void }) {
  const { session } = state;
  const agent = session.agents.find((a) => a.id === chat.agentId);
  const runner = agent ? runnerOf(agent, session.participants) : undefined;
  const messages = session.messages[chat.id];
  const online = session.status === 'connected';
  const [text, setText] = useState('');
  const [branchFrom, setBranchFrom] = useState<ChatMessage | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const parent = chat.branchedFrom ? session.chats.find((c) => c.id === chat.branchedFrom!.chatId) : undefined;
  const last = messages?.[messages.length - 1];

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages?.length, last?.text.length, last?.tool?.status]);

  const send = (event?: FormEvent) => {
    event?.preventDefault();
    if (!text.trim()) return;
    window.pct.postChat(chat.id, text);
    setText('');
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  return (
    <section className="conversation">
      <header className="conversation-head">
        <div className="grow">
          <h2>{chat.title}</h2>
          <span className="muted small">
            {agent ? `${agent.name} · ${describeConnection(agent.connection)}` : 'This agent was removed'}
            {runner ? ` · on ${runner.agent!.startedBy}’s PC` : ' · not running'}
          </span>
          {chat.branchedFrom && (
            <span className="branched-from small muted">
              Branched from{' '}
              {parent ? (
                <button className="link" onClick={() => onSelect(parent.id)}>
                  {parent.title}
                </button>
              ) : (
                <span>{chat.branchedFrom.title} (deleted)</span>
              )}{' '}
              at {time(chat.createdAt)}
            </span>
          )}
          {chat.state !== 'idle' && (
            <span className="agent-now small">
              <span className={`dot dot-${chat.state}`} />
              Now: {chat.activity ?? STATE_LABEL[chat.state]}
            </span>
          )}
        </div>
        {STATE_LABEL[chat.state] && <span className="badge badge-warn">{STATE_LABEL[chat.state]}</span>}
        {chat.state !== 'idle' && runner && (
          <button className="secondary" onClick={() => window.pct.stopChat(chat.id)}>
            Stop
          </button>
        )}
      </header>
      {chat.worktree && (
        <WorktreeBar
          state={state}
          chat={chat}
          agentName={agent?.name ?? 'Agent'}
          reviewing={diff !== null}
          onReview={(text) => setDiff(text)}
        />
      )}
      {diff !== null ? (
        <DiffView text={diff} onClose={() => setDiff(null)} />
      ) : (
        <div className="messages">
          {messages === undefined && <p className="muted">Loading…</p>}
          {messages?.length === 0 && <p className="muted">No messages yet. Everyone in the session can see and post in this chat.</p>}
          {messages?.map((m) => (
            <Message
              key={m.id}
              message={m}
              chat={chat}
              agentName={agent?.name ?? 'The agent'}
              running={!!runner}
              youId={session.you?.id ?? null}
              online={online}
              branches={session.chats.filter((c) => c.branchedFrom?.chatId === chat.id && c.branchedFrom.messageId === m.id)}
              onBranch={() => setBranchFrom(m)}
              onSelect={onSelect}
            />
          ))}
          <div ref={end} />
        </div>
      )}
      {!runner && agent && (
        <p className="banner small">
          {agent.name} is not running. Start it on the Agents screen; it answers what was posted here once it is up.
        </p>
      )}
      {branchFrom ? (
        <BranchForm
          state={state}
          chat={chat}
          from={branchFrom}
          onDone={(next) => {
            setBranchFrom(null);
            if (next) onSelect(next);
          }}
        />
      ) : (
        <form className="composer" onSubmit={send}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={2}
            placeholder={agent ? `Message ${agent.name} (Enter sends, Shift+Enter for a new line)` : 'Message'}
            disabled={!online}
          />
          <button type="submit" disabled={!online || !text.trim()}>
            Send
          </button>
        </form>
      )}
    </section>
  );
}

const TOOL_ICON = { running: '…', done: '✓', failed: '✗', blocked: '⛔' } as const;

function Message({
  message: m,
  chat,
  agentName,
  running,
  youId,
  online,
  branches,
  onBranch,
  onSelect,
}: {
  message: ChatMessage;
  chat: ChatInfo;
  agentName: string;
  /** The chat's agent is running on someone's PC. */
  running: boolean;
  youId: string | null;
  online: boolean;
  /** Chats branched from this message. */
  branches: ChatInfo[];
  onBranch: () => void;
  onSelect: (chatId: string) => void;
}) {
  if (m.kind === 'notice') return <p className="msg-notice">{m.text}</p>;
  if (m.kind === 'checkpoint' && m.checkpoint) {
    return <Checkpoint message={m} chat={chat} agentName={agentName} running={running} online={online} />;
  }
  if (m.kind === 'tool' && m.tool) {
    return (
      <details className={`msg-tool tool-${m.tool.status}`}>
        <summary>
          <span className="tool-icon">{TOOL_ICON[m.tool.status]}</span> {m.tool.name} <code>{m.tool.summary}</code>
        </summary>
        {m.tool.output && <pre>{m.tool.output}</pre>}
      </details>
    );
  }
  if (m.kind === 'approval' && m.approval) {
    const { approval } = m;
    return (
      <div className={`msg-approval approval-${approval.state}`}>
        <strong>
          {m.author.name} wants to: {approval.action}
        </strong>
        <p className="small">{approval.reason}</p>
        {approval.state === 'pending' ? (
          <div className="row">
            <button disabled={!online} onClick={() => window.pct.decideApproval(m.chatId, m.id, true)}>
              Approve
            </button>
            <button className="secondary" disabled={!online} onClick={() => window.pct.decideApproval(m.chatId, m.id, false)}>
              Deny
            </button>
          </div>
        ) : (
          <span className="small muted">
            {approval.state === 'expired' ? 'Nobody decided in time' : `${approval.state === 'approved' ? 'Approved' : 'Denied'} by ${approval.decidedBy}`}
          </span>
        )}
      </div>
    );
  }
  const mine = m.author.id === youId;
  return (
    <div className={`msg ${m.author.kind === 'agent' ? 'msg-agent' : 'msg-human'}${m.kind === 'handoff' ? ' msg-handoff' : ''}`}>
      <Avatar name={m.author.name} kind={m.author.kind} status="active" small />
      <div className="msg-body">
        <div className="msg-meta small">
          <strong>{mine ? 'You' : m.author.name}</strong> <span className="muted">{time(m.at)}</span>
          {m.kind === 'handoff' && <span className="badge">Handoff</span>}
          {!m.streaming && (
            <button className="link msg-branch" disabled={!online} onClick={onBranch} title="Start a new chat with the conversation up to here">
              Branch from here
            </button>
          )}
        </div>
        <div className="msg-text">
          {m.text}
          {m.streaming && <span className="cursor">▍</span>}
        </div>
        {branches.length > 0 && (
          <div className="msg-branches small muted">
            Branched into{' '}
            {branches.map((b, i) => (
              <span key={b.id}>
                {i > 0 && ', '}
                <button className="link" onClick={() => onSelect(b.id)}>
                  {b.title}
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The end of an agent turn that changed files, saved as a commit in the
 * agent's copy. Anyone can undo the turn or take the copy back to it; the
 * agent does it on the PC that holds the copy.
 */
function Checkpoint({
  message: m,
  chat,
  agentName,
  running,
  online,
}: {
  message: ChatMessage;
  chat: ChatInfo;
  agentName: string;
  running: boolean;
  online: boolean;
}) {
  const checkpoint = m.checkpoint!;
  const [showFiles, setShowFiles] = useState(false);
  const copy = chat.worktree;
  const here = copy?.head === checkpoint.commit;
  const files = `${checkpoint.files.length}${checkpoint.truncated ? '+' : ''} ${checkpoint.files.length === 1 ? 'file' : 'files'}`;
  const blocked = !online
    ? 'You are offline'
    : copy?.branch !== checkpoint.branch
      ? `This turn was made in another copy (${checkpoint.branch})`
      : !running
        ? `${agentName} is not running; start it on ${copy.owner.name}’s PC`
        : chat.state !== 'idle'
          ? `Wait until ${agentName} finishes its turn, or stop it`
          : null;
  const undo = () => window.pct.undoTurn(chat.id, m.id, 'undo');
  const goBack = () => {
    const later = 'Anything changed after it, undos included, is taken out of the copy; it can be brought back from its own checkpoint.';
    if (confirm(`Take ${agentName}’s copy back to exactly how it was at the end of turn ${checkpoint.turn}? ${later}`)) {
      window.pct.undoTurn(chat.id, m.id, 'go-back');
    }
  };

  return (
    <div className={`msg-checkpoint small${checkpoint.undone ? ' checkpoint-undone' : ''}`}>
      <div className="checkpoint-line">
        <span className="grow">
          <strong>Turn {checkpoint.turn}</strong> · {files} changed · <code title={`${checkpoint.commit} on ${checkpoint.branch}`}>{checkpoint.commit.slice(0, 7)}</code>{' '}
          <span className="muted">{time(m.at)}</span>
          {here && <span className="badge">The copy is here</span>}
          {checkpoint.undone && (
            <span className="badge">
              {checkpoint.undone.how === 'undo' ? 'Undone' : 'Gone back past'} by {checkpoint.undone.by} at {time(checkpoint.undone.at)}
            </span>
          )}{' '}
          <button className="link" onClick={() => setShowFiles((v) => !v)}>
            {showFiles ? 'Hide files' : 'Show files'}
          </button>
        </span>
        <span className="checkpoint-actions">
          {!checkpoint.undone && (
            <button className="secondary" disabled={!!blocked} title={blocked ?? 'Put back every file this turn changed; later turns stay'} onClick={undo}>
              Undo this turn
            </button>
          )}
          {!here && (
            <button
              className="secondary"
              disabled={!!blocked}
              title={blocked ?? `Take the copy back to how it was at the end of turn ${checkpoint.turn}`}
              onClick={goBack}
            >
              Go back to here
            </button>
          )}
        </span>
      </div>
      {showFiles && (
        <ul className="worktree-files">
          {checkpoint.files.map((f) => (
            <li key={f.path}>
              <span className={`change change-${f.change}`}>{f.change}</span> <code>{f.path}</code>
            </li>
          ))}
          {checkpoint.truncated && <li className="muted">and more…</li>}
        </ul>
      )}
    </div>
  );
}

/** Starts a new chat with the conversation up to one message, with the same agent or another one. */
function BranchForm({ state, chat, from, onDone }: { state: AppState; chat: ChatInfo; from: ChatMessage; onDone: (chatId: string | null) => void }) {
  const { session } = state;
  const [title, setTitle] = useState(`${chat.title} (branch)`.slice(0, 200));
  const [agentId, setAgentId] = useState(session.agents.some((a) => a.id === chat.agentId) ? chat.agentId : (session.agents[0]?.id ?? ''));
  const [error, setError] = useState<string | null>(null);
  const answers = from.author.kind === 'human';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await window.pct.branchChat({ fromChatId: chat.id, fromMessageId: from.id, title: title.trim() || chat.title, agentId });
    if (result.ok) onDone(result.value);
    else setError(result.error);
  };

  return (
    <form className="branch-form" onSubmit={(e) => void submit(e)}>
      <p className="small">
        <strong>
          Branch from {from.author.name}’s message at {time(from.at)}.
        </strong>{' '}
        The new chat gets the conversation up to here; this chat stays as it is.
        {answers ? ' The agent answers this message again in the new chat.' : ''} Files are not branched.
      </p>
      <div className="row">
        <input className="grow" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} aria-label="Title" />
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Agent">
          {session.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {runnerOf(a, session.participants) ? '' : ' (not running)'}
            </option>
          ))}
        </select>
        <button type="submit" disabled={!agentId || session.status !== 'connected'}>
          Start branch
        </button>
        <button type="button" className="secondary" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}

/** One line about an agent chat's own copy: branch, what changed, whose PC. */
export function WorktreeSummary({ chat, agentName, youId }: { chat: ChatInfo; agentName: string; youId: string | null }) {
  const copy = chat.worktree;
  if (!copy) return null;
  const files = copy.files.length;
  return (
    <span className="worktree-summary">
      <code title={copy.folder}>{copy.branch}</code>
      <span className="muted">
        {' '}
        {files === 0 ? 'no changes to merge' : `${files}${copy.truncated ? '+' : ''} ${files === 1 ? 'file' : 'files'} changed`}
        {copy.commits > 0 && ` · ${copy.commits} ${copy.commits === 1 ? 'commit' : 'commits'}`}
        {copy.base && ` · from ${copy.base}`}
        {` · ${agentName} on ${copy.owner.id === youId ? 'your' : `${copy.owner.name}’s`} PC`}
      </span>
    </span>
  );
}

/**
 * The chat's own copy of the project, under the chat header: what it changed,
 * and on the PC that holds it the actions to review, merge, push or discard.
 */
function WorktreeBar({
  state,
  chat,
  agentName,
  reviewing,
  onReview,
}: {
  state: AppState;
  chat: ChatInfo;
  agentName: string;
  reviewing: boolean;
  onReview: (diff: string | null) => void;
}) {
  const copy = chat.worktree!;
  const youId = state.session.you?.id ?? null;
  const mine = copy.owner.id === youId;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const idle = chat.state === 'idle';
  const hasChanges = copy.files.length > 0;
  const yourBranch = state.workspace?.workspace?.branch ?? null;

  const act = async (action: WorktreeAction) => {
    setBusy(true);
    setResult(null);
    const r = await window.pct.worktreeAction(chat.id, action);
    setBusy(false);
    if (r.ok) {
      if (r.value) setResult({ ok: true, text: r.value });
      if (action === 'discard' && r.value) onReview(null);
    } else setResult({ ok: false, text: r.error });
  };
  const review = async () => {
    if (reviewing) return onReview(null);
    setBusy(true);
    const r = await window.pct.worktreeDiff(chat.id);
    setBusy(false);
    if (r.ok) onReview(r.value);
    else setResult({ ok: false, text: r.error });
  };
  const waitTitle = idle ? undefined : `Wait until ${agentName} finishes its turn, or stop it`;

  return (
    <div className="worktree-bar small">
      <div className="worktree-line">
        <span>
          <WorktreeSummary chat={chat} agentName={agentName} youId={youId} />
          {hasChanges && (
            <button className="link" onClick={() => setShowFiles((v) => !v)}>
              {showFiles ? 'Hide files' : 'Show files'}
            </button>
          )}
        </span>
        {mine && (
          <span className="worktree-actions">
            <button className="secondary" disabled={busy || !hasChanges} onClick={() => void review()}>
              {reviewing ? 'Back to chat' : 'Review changes'}
            </button>
            <button
              disabled={busy || !idle || !hasChanges || !yourBranch}
              title={waitTitle ?? (yourBranch ? `Merge ${copy.branch} into ${yourBranch} in your project folder` : 'Choose your project folder first')}
              onClick={() => void act('merge')}
            >
              Merge into {yourBranch ?? 'my branch'}
            </button>
            <button
              className="secondary"
              disabled={busy || !idle || !hasChanges}
              title={waitTitle ?? 'Push the branch to GitHub and open a pull request'}
              onClick={() => void act('pull-request')}
            >
              Open a pull request
            </button>
            <button className="secondary" disabled={busy} onClick={() => void act('open')}>
              Open folder
            </button>
            <button className="danger" disabled={busy || !idle} title={waitTitle ?? 'Throw away the copy and its branch'} onClick={() => void act('discard')}>
              Discard
            </button>
          </span>
        )}
      </div>
      {showFiles && (
        <ul className="worktree-files">
          {copy.files.map((f) => (
            <li key={f.path}>
              <span className={`change change-${f.change}`}>{f.change === 'untracked' ? 'new' : f.change}</span> <code>{f.path}</code>
            </li>
          ))}
          {copy.truncated && <li className="muted">and more…</li>}
        </ul>
      )}
      {!mine && hasChanges && (
        <p className="muted">
          {copy.owner.name} can review and merge these changes, or open a pull request so you can see them on GitHub.
        </p>
      )}
      {result && <p className={result.ok ? 'muted' : 'error'}>{result.text}</p>}
    </div>
  );
}

/** A unified diff, coloured by line. */
function DiffView({ text, onClose }: { text: string; onClose: () => void }) {
  const lines = text.split('\n');
  const kind = (line: string) =>
    line.startsWith('diff --git')
      ? 'diff-file'
      : line.startsWith('@@')
        ? 'diff-hunk'
        : line.startsWith('+') && !line.startsWith('+++')
          ? 'diff-add'
          : line.startsWith('-') && !line.startsWith('---')
            ? 'diff-del'
            : '';
  return (
    <div className="diff-view">
      <div className="diff-head">
        <span className="muted small grow">Changes in the agent’s copy since it started. Your project folder has none of these until you merge.</span>
        <button className="secondary" onClick={onClose}>
          Back to chat
        </button>
      </div>
      {text.trim() ? (
        <pre>
          {lines.map((line, i) => (
            <div key={i} className={kind(line)}>
              {line || ' '}
            </div>
          ))}
        </pre>
      ) : (
        <p className="muted">No changes.</p>
      )}
    </div>
  );
}

/** Side panel for the open chat: what the agent knows, its task, and handing off. */
export function ChatSidePanel({
  state,
  chat,
  onSelect,
  onCollapse,
}: {
  state: AppState;
  chat: ChatInfo;
  onSelect: (chatId: string) => void;
  onCollapse?: () => void;
}) {
  const { session } = state;
  const task = session.tasks.find((t) => t.id === chat.taskId) ?? null;
  const [handingOff, setHandingOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = session.status === 'connected';
  const context = chat.context;

  return (
    <aside className="side-panel">
      {onCollapse && (
        <button className="link small side-collapse" onClick={onCollapse} title="Hide this panel">
          Hide ›
        </button>
      )}
      {handingOff ? (
        <HandoffForm
          state={state}
          chat={chat}
          task={task}
          onDone={(next) => {
            setHandingOff(false);
            if (next) onSelect(next);
          }}
        />
      ) : (
        <>
          <section>
            <h2>Context</h2>
            {context ? (
              <>
                <ul className="context-list small">
                  {context.items.map((item, i) => (
                    <li key={i} title={item.detail}>
                      <span className="grow">
                        {item.label}
                        <span className="muted"> · {item.detail}</span>
                      </span>
                      {item.tokens > 0 && <span className="muted">{formatTokens(item.tokens)}</span>}
                    </li>
                  ))}
                </ul>
                <p className="small">About {formatTokens(context.tokens)} tokens in context.</p>
              </>
            ) : (
              <p className="muted small">Shown once the agent has started on this chat.</p>
            )}
          </section>
          <HeldLocks state={state} chat={chat} />
          <section>
            <h2>Task</h2>
            <select value={chat.taskId ?? ''} disabled={!online} onChange={(e) => window.pct.updateChat(chat.id, { taskId: e.target.value || null })}>
              <option value="">No task</option>
              {session.tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            {task ? (
              <p className="muted small">
                {STAGE_LABELS[task.stage]}
                {task.scope.length > 0 ? ` · paths ${task.scope.join(', ')}` : ' · no paths set'}
              </p>
            ) : (
              <button
                className="link small"
                disabled={!online}
                onClick={() => {
                  setError(null);
                  void window.pct.chatToTask(chat.id).then((r) => !r.ok && setError(r.error));
                }}
              >
                Turn this chat into a task
              </button>
            )}
          </section>
          {chat.handoff && (
            <section>
              <h2>Handed over</h2>
              <p className="small">
                {chat.handoff.fromName ? `From ${chat.handoff.fromName}` : 'Handoff'}
                {chat.handoff.stage && ` for ${STAGE_LABELS[chat.handoff.stage]}`}
              </p>
              {chat.handoff.criteria.length > 0 && (
                <ul className="small criteria">
                  {chat.handoff.criteria.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
            </section>
          )}
          <section>
            <button disabled={!online || session.agents.length === 0} onClick={() => setHandingOff(true)}>
              Hand off to another agent
            </button>
            <p className="muted small">The next agent gets the plan, decisions, paths and acceptance criteria.</p>
          </section>
          <SaveToMemory state={state} chat={chat} />
          {error && <p className="error small">{error}</p>}
          <button
            className="danger"
            disabled={!online}
            onClick={() => {
              setError(null);
              void window.pct.deleteChat(chat.id).then((r) => !r.ok && setError(r.error));
            }}
          >
            Delete chat
          </button>
        </>
      )}
    </aside>
  );
}

/** Keeps what a chat settled (a decision, a convention, a known issue) in project memory. */
function SaveToMemory({ state, chat }: { state: AppState; chat: ChatInfo }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<MemoryKind>('decision');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saved, setSaved] = useState(false);
  const saveable = state.canEditTasks;

  const start = () => {
    // Prefilled from the agent's last answer; edit it down to what is worth keeping.
    const messages = state.session.messages[chat.id] ?? [];
    const last = [...messages].reverse().find((m) => m.author.kind === 'agent' && m.kind === 'text' && m.text.trim());
    setTitle(chat.title);
    setBody(last?.text.trim().slice(0, 20_000) ?? '');
    setSaved(false);
    setOpen(true);
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    window.pct.editMemory({
      op: 'create',
      id: crypto.randomUUID(),
      kind,
      title: title.trim().slice(0, 200),
      body: body.trim(),
      source: { kind: 'chat', id: chat.id, title: chat.title },
    });
    setOpen(false);
    setSaved(true);
  };

  if (!open) {
    return (
      <section>
        <button className="secondary" disabled={!saveable} onClick={start}>
          Save to project memory
        </button>
        <p className="muted small">{saved ? 'Saved. Every agent gets it from now on.' : 'Keep a decision or finding from this chat for everyone, agents included.'}</p>
      </section>
    );
  }
  return (
    <form className="handoff-form" onSubmit={save}>
      <h2>Save to project memory</h2>
      <label className="field">
        <span>As</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
          {MemoryKind.options.map((k) => (
            <option key={k} value={k}>
              {MEMORY_KIND_SINGULAR[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </label>
      <label className="field">
        <span>What to remember</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} maxLength={20_000} />
      </label>
      <div className="row">
        <button type="submit" disabled={!title.trim()}>
          Save
        </button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

const NEXT_STAGE: Partial<Record<TaskStage, TaskStage>> = { planning: 'implementing', implementing: 'review', review: 'testing', testing: 'done' };

function HandoffForm({
  state,
  chat,
  task,
  onDone,
}: {
  state: AppState;
  chat: ChatInfo;
  task: Task | null;
  /** With the new chat's id after a handoff. */
  onDone: (chatId?: string) => void;
}) {
  const { session } = state;
  const messages = session.messages[chat.id] ?? [];
  // Prefilled once, from the agent's last answer when the form opened.
  const [lastAgentText] = useState(() => [...messages].reverse().find((m) => m.author.kind === 'agent' && m.kind === 'text')?.text ?? '');
  const others = session.agents.filter((a) => a.id !== chat.agentId);
  const [agentId, setAgentId] = useState(others[0]?.id ?? session.agents[0]?.id ?? '');
  const [stage, setStage] = useState<TaskStage | ''>(task ? (NEXT_STAGE[task.stage] ?? task.stage) : '');
  const [plan, setPlan] = useState(chat.handoff?.plan || lastAgentText);
  const [decisions, setDecisions] = useState(chat.handoff?.decisions.join('\n') ?? '');
  const [criteria, setCriteria] = useState(
    (task?.criteria.length ? task.criteria.map((c) => c.text) : (chat.handoff?.criteria ?? [])).join('\n'),
  );
  const [scope, setScope] = useState((task?.scope.length ? task.scope : (chat.handoff?.scope ?? [])).join('\n'));
  const [readFirst, setReadFirst] = useState((task?.readFirst.length ? task.readFirst : (chat.handoff?.readFirst ?? [])).join('\n'));
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const split = (text: string) =>
    text
      .split('\n')
      .map((l) => l.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await window.pct.handOff({
      fromChatId: chat.id,
      taskId: task?.id ?? null,
      agentId,
      handoff: {
        stage: stage || null,
        plan: plan.trim(),
        decisions: split(decisions),
        criteria: split(criteria),
        scope: split(scope),
        readFirst: split(readFirst),
        notes: notes.trim(),
      },
    });
    if (!result.ok) setError(result.error);
    else onDone(result.value);
  };

  return (
    <form className="handoff-form" onSubmit={(e) => void submit(e)}>
      <header>
        <h2>Hand off</h2>
      </header>
      <label className="field">
        <span>To</span>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {session.agents.map((a: AgentProfile) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      {task && (
        <label className="field">
          <span>Move "{task.title}" to</span>
          <select value={stage} onChange={(e) => setStage(e.target.value as TaskStage)}>
            {TaskStage.options.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>Plan</span>
        <textarea value={plan} onChange={(e) => setPlan(e.target.value)} rows={6} maxLength={20000} />
      </label>
      <label className="field">
        <span>Decisions made, one per line</span>
        <textarea value={decisions} onChange={(e) => setDecisions(e.target.value)} rows={3} />
      </label>
      <label className="field">
        <span>Acceptance criteria, one per line</span>
        <textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={3} />
      </label>
      <label className="field">
        <span>Allowed paths, one per line</span>
        <textarea value={scope} onChange={(e) => setScope(e.target.value)} rows={2} spellCheck={false} />
      </label>
      <label className="field">
        <span>Files to read first, one per line</span>
        <textarea value={readFirst} onChange={(e) => setReadFirst(e.target.value)} rows={2} spellCheck={false} />
      </label>
      <label className="field">
        <span>Notes</span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </label>
      {error && <p className="error small">{error}</p>}
      <div className="row">
        <button type="submit" disabled={!agentId}>
          Hand off
        </button>
        <button type="button" className="secondary" onClick={() => onDone()}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Files the agent locked for this chat: kept while they have uncommitted changes. */
function HeldLocks({ state, chat }: { state: AppState; chat: ChatInfo }) {
  const { session } = state;
  const held = session.locks.filter((l) => l.chatId === chat.id);
  const online = session.status === 'connected';
  return (
    <section>
      <h2>Locked for this chat</h2>
      {held.length > 0 ? (
        <>
          <ul className="held-locks small">
            {held.map((lock) => (
              <li key={lock.id}>
                <code title={lock.path}>{lock.path}</code>
                <span className={`badge badge-${lock.kind}`}>{lock.kind === 'exclusive' ? 'Exclusive' : 'Soft'}</span>
                <button className="link" disabled={!online} onClick={() => window.pct.releaseLock(lock.id)}>
                  Release
                </button>
              </li>
            ))}
          </ul>
          <p className="muted small">
            The agent locks a file before its first edit and frees it when the turn ends, unless it changed the file
            and the change is not merged yet. Merging or discarding its copy frees them, and so does finishing the task.
          </p>
        </>
      ) : (
        <p className="muted small">Nothing yet. The agent locks each file before its first edit.</p>
      )}
    </section>
  );
}

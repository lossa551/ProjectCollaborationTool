import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { findOverlaps, type Activity, type ChatInfo, type Lock, type Participant } from '@pct/shared';
import type { AppState, HostingInfo } from '../common/api';
import { ChatScreen, ChatSidePanel } from './AgentChat';
import { AgentsScreen } from './Agents';
import { Avatar } from './Avatar';
import { Board } from './Board';
import { GitHubScreen, WorkspaceCard } from './GitHub';
import { LocksScreen } from './Locks';
import { MemoryScreen } from './Memory';
import { PlanningScreen } from './Planning';
import { TaskDetail } from './TaskDetail';
import { UpdateButton } from './UpdateButton';

// Nav items from docs/design/interface.md.
type View = 'board' | 'planning' | 'locks' | 'agents' | 'chat' | 'memory';
const NAV: { label: string; view: View }[] = [
  { label: 'Session board', view: 'board' },
  { label: 'Planning space', view: 'planning' },
  { label: 'Locks and GitHub', view: 'locks' },
  { label: 'Agents', view: 'agents' },
  { label: 'Agent chat', view: 'chat' },
  { label: 'Project memory', view: 'memory' },
];

const STATUS_LABEL = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Live',
  reconnecting: 'Offline, reconnecting…',
  closed: 'Disconnected',
} as const;

function statusLabel(status: keyof typeof STATUS_LABEL, pending: number): string {
  if (status === 'connected' || pending === 0) return STATUS_LABEL[status];
  return `Offline, ${pending} ${pending === 1 ? 'change' : 'changes'} waiting to sync`;
}

export function SessionScreen({ state }: { state: AppState }) {
  const { session, hosting } = state;
  const participants = [...session.participants].sort((a, b) => a.connectedAt - b.connectedAt);
  const online = session.status === 'connected';
  const editable = state.canEditTasks;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [view, setView] = useState<View>('board');
  const [locksTab, setLocksTab] = useState<'github' | 'locks'>('github');
  const [chatId, setChatId] = useState<string | null>(null);
  const [newChatAgentId, setNewChatAgentId] = useState<string | null>(null);
  const openChat = chatId ? session.chats.find((c) => c.id === chatId) : undefined;
  const showChat = (id: string) => {
    setNewChatAgentId(null);
    setChatId(id);
    setSelectedId(null);
    setView('chat');
  };
  const pendingApprovals = Object.values(session.messages)
    .flat()
    .filter((m) => m.approval?.state === 'pending').length;
  const abandoned = session.locks.filter((l) => l.abandoned).length;
  const selected = session.tasks.find((t) => t.id === selectedId) ?? null;
  const overlaps = useMemo(
    () =>
      findOverlaps({
        workspaces: Object.entries(session.workspaces).map(([participantId, workspace]) => ({
          participantId,
          name: session.participants.find((p) => p.id === participantId)?.name ?? 'Someone',
          workspace,
        })),
        github: session.github,
        locks: session.locks,
      }),
    [session.workspaces, session.participants, session.github, session.locks],
  );

  return (
    <div className="shell">
      <header className="titlebar">
        <strong>{session.session?.name ?? 'Session'}</strong>
        <span className={`status status-${session.status}`}>{statusLabel(session.status, session.pending)}</span>
        <UpdateButton hosting={!!hosting} />
        <div className="avatars">
          {participants.map((p) => (
            <Avatar key={p.id} name={p.name} kind={p.kind} status={p.status} />
          ))}
        </div>
        {hosting && (
          <button className="secondary" onClick={() => setSnapshotOpen((open) => !open)} title="Save the board, planning and memory as they are now, say before a big change">
            Snapshot
          </button>
        )}
        {hosting && (
          <button className="secondary" onClick={() => setInviteOpen((open) => !open)}>
            Invite
          </button>
        )}
        <button className="secondary" onClick={() => void window.pct.leave()}>
          {hosting ? 'Stop hosting' : 'Leave'}
        </button>
        {hosting && inviteOpen && <InvitePopover hosting={hosting} onClose={() => setInviteOpen(false)} />}
        {hosting && snapshotOpen && <SnapshotPopover canTag={!!state.workspace?.folder && !state.workspace.error} onClose={() => setSnapshotOpen(false)} />}
      </header>

      <nav className="sidebar">
        {NAV.map((item) => (
          <button key={item.label} className={item.view === view ? 'nav active' : 'nav'} onClick={() => setView(item.view)}>
            {item.label}
            {item.view === 'locks' && abandoned > 0 && <span className="nav-count">{abandoned}</span>}
            {item.view === 'chat' && pendingApprovals > 0 && <span className="nav-count">{pendingApprovals}</span>}
          </button>
        ))}
        <WorkspaceCard local={state.workspace} tasks={session.tasks} onOpenTask={setSelectedId} />
      </nav>

      <main className="content">
        <Banner state={state} />
        {view === 'planning' ? (
          <PlanningScreen state={state} onOpenTask={setSelectedId} onOpenChat={showChat} />
        ) : view === 'memory' ? (
          <MemoryScreen state={state} onOpenTask={setSelectedId} onOpenChat={showChat} />
        ) : view === 'agents' ? (
          <AgentsScreen
            state={state}
            onOpenChat={(agentId) => {
              const existing = [...session.chats].sort((a, b) => b.updatedAt - a.updatedAt).find((c) => c.agentId === agentId);
              setChatId(existing?.id ?? null);
              setNewChatAgentId(existing ? null : agentId);
              setView('chat');
            }}
          />
        ) : view === 'chat' ? (
          <ChatScreen
            state={state}
            chatId={chatId}
            newChatAgentId={newChatAgentId}
            onSelect={(id) => {
              setNewChatAgentId(null);
              setChatId(id);
            }}
          />
        ) : view === 'board' ? (
          <Board
            tasks={session.tasks}
            locks={session.locks}
            participants={participants}
            github={session.github}
            overlaps={overlaps}
            chats={session.chats}
            editable={editable}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        ) : (
          <>
            <div className="tabs">
              <button className={locksTab === 'github' ? 'nav active' : 'nav'} onClick={() => setLocksTab('github')}>
                GitHub{overlaps.length > 0 && <span className="nav-count">{overlaps.length}</span>}
              </button>
              <button className={locksTab === 'locks' ? 'nav active' : 'nav'} onClick={() => setLocksTab('locks')}>
                Locks{abandoned > 0 && <span className="nav-count">{abandoned}</span>}
              </button>
            </div>
            {locksTab === 'github' ? (
              <GitHubScreen state={state} participants={participants} overlaps={overlaps} onOpenTask={setSelectedId} />
            ) : (
          <LocksScreen
            locks={session.locks}
            rules={session.lockRules}
            tasks={session.tasks}
            participants={participants}
            youId={session.you?.id ?? null}
            editable={online}
            onOpenTask={setSelectedId}
            onOpenChat={showChat}
          />
            )}
          </>
        )}
      </main>

      {view === 'chat' && openChat && !selected ? (
        <ChatSidePanel state={state} chat={openChat} onSelect={setChatId} />
      ) : selected ? (
        <TaskDetail
          task={selected}
          tasks={session.tasks}
          participants={participants}
          locks={session.locks}
          lockRules={session.lockRules}
          github={session.github}
          overlaps={overlaps}
          workspaces={session.workspaces}
          planning={session.planning}
          youId={session.you?.id ?? null}
          editable={editable}
          online={online}
          onClose={() => setSelectedId(null)}
        />
      ) : (
        <aside className="side-panel">
          <People participants={participants} youId={session.you?.id ?? null} chats={session.chats} locks={session.locks} onOpenChat={showChat} />
          <ActivityFeed activity={session.activity} onSelect={setSelectedId} taskIds={new Set(session.tasks.map((t) => t.id))} />
        </aside>
      )}
    </div>
  );
}

/** Offline notice, or the last thing the server refused. */
function Banner({ state }: { state: AppState }) {
  const { status, error } = state.session;
  const [dismissed, setDismissed] = useState<typeof error>(null);
  useEffect(() => {
    if (!error || error === dismissed) return;
    const timer = setTimeout(() => setDismissed(error), 5000);
    return () => clearTimeout(timer);
  }, [error, dismissed]);

  if ((status === 'reconnecting' || status === 'connecting') && state.canEditTasks) {
    return (
      <p className="banner warning">
        The session server is unreachable. You can keep working on tasks; your changes sync when it is back. Locks and
        owners need the server.
      </p>
    );
  }
  if (status === 'connected' && error && error !== dismissed) {
    return (
      <p className="banner error" onClick={() => setDismissed(error)}>
        {error.message}
      </p>
    );
  }
  return null;
}

function People({
  participants,
  youId,
  chats,
  locks,
  onOpenChat,
}: {
  participants: Participant[];
  youId: string | null;
  chats: ChatInfo[];
  locks: Lock[];
  onOpenChat: (chatId: string) => void;
}) {
  return (
    <section>
      <h2>Who is here</h2>
      <ul className="people">
        {participants.map((p) => (
          <li key={p.id}>
            <Avatar name={p.name} kind={p.kind} status={p.status} />
            <span className="grow">
              {p.name}
              {p.id === youId && <span className="muted"> (you)</span>}
              {p.kind === 'agent' && <span className="muted"> · agent</span>}
            </span>
            <span className={`presence presence-${p.status}`}>{p.status}</span>
            {p.agent && <AgentNow agent={p} chats={chats} locks={locks} onOpenChat={onOpenChat} />}
          </li>
        ))}
      </ul>
      {participants.length === 0 && <p className="muted">Waiting for the server…</p>}
    </section>
  );
}

/** What a running agent is doing right now, and the files it holds. */
function AgentNow({
  agent,
  chats,
  locks,
  onOpenChat,
}: {
  agent: Participant;
  chats: ChatInfo[];
  locks: Lock[];
  onOpenChat: (chatId: string) => void;
}) {
  const busy = chats.filter((c) => c.agentId === agent.agent?.profileId && c.state !== 'idle');
  const held = locks.filter((l) => l.holder.id === agent.id);
  if (busy.length === 0 && held.length === 0) return <span className="agent-now muted small">Idle</span>;
  return (
    <span className="agent-now wrap small">
      {busy.map((c) => (
        <button key={c.id} className="link" onClick={() => onOpenChat(c.id)} title={`In "${c.title}"`}>
          <span className={`dot dot-${c.state}`} />
          {c.activity ?? (c.state === 'waiting' ? 'Waiting' : 'Working')}
        </button>
      ))}
      {busy.length === 0 && <span className="muted">Idle</span>}
      {held.length > 0 && (
        <span className="muted" title={held.map((l) => l.path).join('\n')}>
          holding {held.length === 1 ? held[0]!.path : `${held.length} locks`}
        </span>
      )}
    </span>
  );
}

function ActivityFeed({
  activity,
  taskIds,
  onSelect,
}: {
  activity: Activity[];
  taskIds: Set<string>;
  onSelect: (taskId: string) => void;
}) {
  return (
    <section className="activity">
      <h2>Activity</h2>
      <ol>
        {[...activity].reverse().map((entry) => {
          const clickable = entry.taskId !== null && taskIds.has(entry.taskId);
          return (
            <li key={entry.id} className={clickable ? 'clickable' : undefined} onClick={() => clickable && onSelect(entry.taskId!)}>
              <span>
                {entry.actorName && <strong>{entry.actorName} </strong>}
                {entry.text}
              </span>
              <time className="muted">{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
            </li>
          );
        })}
      </ol>
      {activity.length === 0 && <p className="muted">Nothing yet.</p>}
    </section>
  );
}

function SnapshotPopover({ canTag, onClose }: { canTag: boolean; onClose: () => void }) {
  const [label, setLabel] = useState('');
  const [tag, setTag] = useState(canTag);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const done = await window.pct.createSnapshot({ label, tag: tag && canTag });
    setBusy(false);
    setResult(done.ok ? { ok: true, text: done.value } : { ok: false, text: done.error });
    if (done.ok) setLabel('');
  };
  return (
    <form className="popover card snapshot-popover" onSubmit={create}>
      <h2>Snapshot</h2>
      <p className="muted">
        Saves the board, planning space, project memory, agents and chats as they are now. It is kept until you delete it, and you
        can go back to it with Restore… on the start screen.
      </p>
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Before the inventory rewrite" maxLength={200} autoFocus />
      <label className="check" title={canTag ? undefined : 'Choose your project folder first'}>
        <input type="checkbox" checked={tag && canTag} disabled={!canTag} onChange={(e) => setTag(e.target.checked)} />
        Also tag the current commit in my project folder (changes not committed yet are not in it)
      </label>
      {result && <p className={result.ok ? 'muted' : 'error'}>{result.text}</p>}
      <div className="row">
        <button type="submit" disabled={busy || !label.trim()}>
          Save snapshot
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </form>
  );
}

function InvitePopover({ hosting, onClose }: { hosting: HostingInfo; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    window.pct.copyText(hosting.invite);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="popover card">
      <h2>Invite</h2>
      <p className="muted">Send this code to your friend. Anyone with it can join, so share it privately.</p>
      <div className="invite">
        <code>{hosting.invite}</code>
        <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <p className="muted">
        Address {hosting.address}:{hosting.port}
        {hosting.addressSource === 'tailscale' && ' (Tailscale)'}
      </p>
      {hosting.addressSource !== 'tailscale' && (
        <p className="warning">
          No Tailscale address found on this PC, so the invite uses{' '}
          {hosting.addressSource === 'lan' ? 'your local network address' : 'this PC only'}. Start Tailscale and host
          again so your friend can reach you.
        </p>
      )}
      <button className="secondary" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

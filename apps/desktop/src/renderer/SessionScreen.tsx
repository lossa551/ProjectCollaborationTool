import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { findOverlaps, needsYou, whoIsDoing, type FeatureState, type NeedTarget } from '@pct/shared';
import type { AppState, HostingInfo } from '../common/api';
import { ChatScreen, ChatSidePanel } from './AgentChat';
import { AgentsScreen } from './Agents';
import { Avatar } from './Avatar';
import { Board } from './Board';
import { GitHubScreen, OverlapsScreen, WorkspaceCard } from './GitHub';
import { HomeScreen } from './Home';
import { LocksScreen } from './Locks';
import { MemoryScreen } from './Memory';
import { PlanningScreen } from './Planning';
import { recall, remember } from './storage';
import { TaskDetail } from './TaskDetail';
import { UpdateButton } from './UpdateButton';

// Nav from issue #34: Home first, agent setup behind the Settings gear, and
// GitHub, locks and overlaps together under Code.
type View = 'home' | 'board' | 'planning' | 'agents' | 'code' | 'memory' | 'settings';
const NAV: { label: string; view: View }[] = [
  { label: 'Home', view: 'home' },
  { label: 'Board', view: 'board' },
  { label: 'Planning', view: 'planning' },
  { label: 'Agents', view: 'agents' },
  { label: 'Code', view: 'code' },
  { label: 'Memory', view: 'memory' },
];

type CodeTab = 'github' | 'locks' | 'overlaps';

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

/** When you were last here, as it was when this window opened the session. */
const visitStart = new Map<string, number | null>();

/** Away this long before "Since you were last here" starts over from when you left. */
const AWAY_MS = 30 * 60_000;

/**
 * When you were last here in this session, for the Home digest. Recorded each
 * minute while the window has focus; coming back after a while away moves the
 * digest to cover that time.
 */
function useLastSeen(sessionId: string | null): [number | null, () => void] {
  const [since, setSince] = useState<number | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const key = `lastSeen.${sessionId}`;
    const stored = () => Number(recall(key)) || null;
    // Read before this visit marks anything, once per session per window.
    if (!visitStart.has(sessionId)) visitStart.set(sessionId, stored());
    setSince(visitStart.get(sessionId)!);
    const mark = () => {
      if (document.hasFocus()) remember(key, String(Date.now()));
    };
    const back = () => {
      const last = stored();
      if (last && Date.now() - last > AWAY_MS) setSince(last);
      mark();
    };
    mark();
    const timer = setInterval(mark, 60_000);
    window.addEventListener('focus', back);
    window.addEventListener('beforeunload', mark);
    return () => {
      mark();
      clearInterval(timer);
      window.removeEventListener('focus', back);
      window.removeEventListener('beforeunload', mark);
    };
  }, [sessionId]);
  return [since, () => setSince(Date.now())];
}

export function SessionScreen({ state }: { state: AppState }) {
  const { session, hosting } = state;
  const participants = [...session.participants].sort((a, b) => a.connectedAt - b.connectedAt);
  const online = session.status === 'connected';
  const editable = state.canEditTasks;
  const youId = session.you?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [view, setView] = useState<View>('home');
  const [codeTab, setCodeTab] = useState<CodeTab>('github');
  const [planFocus, setPlanFocus] = useState<{ id: string | null; filter: FeatureState | null }>({ id: null, filter: null });
  const [chatId, setChatId] = useState<string | null>(null);
  const [newChatAgentId, setNewChatAgentId] = useState<string | null>(null);
  const [sideHidden, setSideHidden] = useState(false);
  const [since, markSeen] = useLastSeen(session.session?.id ?? null);
  const openChat = chatId ? session.chats.find((c) => c.id === chatId) : undefined;
  const showChat = (id: string) => {
    setNewChatAgentId(null);
    setChatId(id);
    setSelectedId(null);
    setView('agents');
  };
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
  // One "needs you" list for the Home nav count, Home itself and (later) notifications.
  const needs = useMemo(() => needsYou(session, youId, overlaps), [session, youId, overlaps]);
  const approvals = needs.filter((n) => n.kind === 'approval').length;
  const doing = useMemo(() => new Map(whoIsDoing(session).map((d) => [d.participant.id, d])), [session]);

  const go = (target: NeedTarget) => {
    switch (target.screen) {
      case 'chat':
        return showChat(target.chatId);
      case 'task':
        return setSelectedId(target.taskId);
      case 'planning':
        setPlanFocus({ id: target.itemId, filter: null });
        return setView('planning');
      case 'overlaps':
        setCodeTab('overlaps');
        return setView('code');
      case 'url':
        window.open(target.url);
    }
  };
  const openCode = (tab: CodeTab) => {
    setCodeTab(tab);
    setView('code');
  };
  const showSide = !!selected || (view === 'agents' && !!openChat);

  return (
    <div className={`shell${showSide && !(sideHidden && !selected) ? '' : ' no-side'}`}>
      <header className="titlebar">
        <strong>{session.session?.name ?? 'Session'}</strong>
        <span className={`status status-${session.status}`}>{statusLabel(session.status, session.pending)}</span>
        <UpdateButton hosting={!!hosting} />
        <div className="avatars">
          {participants.map((p) => {
            const d = doing.get(p.id);
            const what = [d?.task?.title, d?.activity ?? (p.kind === 'agent' ? 'idle' : null)].filter(Boolean).join(' · ');
            return (
              <Avatar
                key={p.id}
                name={p.name}
                kind={p.kind}
                status={p.status}
                title={`${p.name}${p.id === youId ? ' (you)' : ''}, ${p.status}${what ? `\n${what}` : ''}`}
              />
            );
          })}
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
        <button
          className={view === 'settings' ? 'secondary gear active' : 'secondary gear'}
          onClick={() => setView('settings')}
          title="Settings: agents and API keys"
          aria-label="Settings"
        >
          ⚙
        </button>
        <button className="secondary" onClick={() => void window.pct.leave()}>
          {hosting ? 'Stop hosting' : 'Leave'}
        </button>
        {hosting && inviteOpen && <InvitePopover hosting={hosting} onClose={() => setInviteOpen(false)} />}
        {hosting && snapshotOpen && <SnapshotPopover canTag={!!state.workspace?.folder && !state.workspace.error} onClose={() => setSnapshotOpen(false)} />}
      </header>

      <nav className="sidebar">
        {NAV.map((item) => (
          <button
            key={item.label}
            className={item.view === view ? 'nav active' : 'nav'}
            onClick={() => {
              if (item.view === 'planning') setPlanFocus({ id: null, filter: null });
              setView(item.view);
            }}
          >
            {item.label}
            {item.view === 'home' && needs.length > 0 && <span className="nav-count">{needs.length}</span>}
            {item.view === 'agents' && approvals > 0 && <span className="nav-count">{approvals}</span>}
          </button>
        ))}
        <WorkspaceCard local={state.workspace} tasks={session.tasks} onOpenTask={setSelectedId} />
      </nav>

      <main className="content">
        <Banner state={state} />
        {view === 'home' ? (
          <HomeScreen
            state={state}
            needs={needs}
            since={since}
            onMarkSeen={markSeen}
            go={go}
            onFeatures={(filter) => {
              setPlanFocus({ id: null, filter });
              setView('planning');
            }}
            onInvite={() => setInviteOpen(true)}
            onSettings={() => setView('settings')}
            onCode={openCode}
          />
        ) : view === 'planning' ? (
          <PlanningScreen
            state={state}
            onOpenTask={setSelectedId}
            onOpenChat={showChat}
            focusId={planFocus.id}
            filter={planFocus.filter}
            onClearFilter={() => setPlanFocus({ id: null, filter: null })}
          />
        ) : view === 'memory' ? (
          <MemoryScreen state={state} onOpenTask={setSelectedId} onOpenChat={showChat} />
        ) : view === 'settings' ? (
          <AgentsScreen
            state={state}
            onOpenChat={(agentId) => {
              const existing = [...session.chats].sort((a, b) => b.updatedAt - a.updatedAt).find((c) => c.agentId === agentId);
              setChatId(existing?.id ?? null);
              setNewChatAgentId(existing ? null : agentId);
              setView('agents');
            }}
          />
        ) : view === 'agents' ? (
          <ChatScreen
            state={state}
            chatId={chatId}
            newChatAgentId={newChatAgentId}
            onSelect={(id) => {
              setNewChatAgentId(null);
              setChatId(id);
            }}
            onSetup={() => setView('settings')}
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
              <button className={codeTab === 'github' ? 'nav active' : 'nav'} onClick={() => setCodeTab('github')}>
                GitHub
              </button>
              <button className={codeTab === 'locks' ? 'nav active' : 'nav'} onClick={() => setCodeTab('locks')}>
                Locks{session.locks.some((l) => l.abandoned) && <span className="nav-count">{session.locks.filter((l) => l.abandoned).length}</span>}
              </button>
              <button className={codeTab === 'overlaps' ? 'nav active' : 'nav'} onClick={() => setCodeTab('overlaps')}>
                Overlaps{overlaps.length > 0 && <span className="nav-count">{overlaps.length}</span>}
              </button>
            </div>
            {codeTab === 'github' ? (
              <GitHubScreen state={state} participants={participants} onOpenTask={setSelectedId} />
            ) : codeTab === 'overlaps' ? (
              <OverlapsScreen overlaps={overlaps} youId={youId} />
            ) : (
              <LocksScreen
                locks={session.locks}
                rules={session.lockRules}
                tasks={session.tasks}
                participants={participants}
                youId={youId}
                editable={online}
                onOpenTask={setSelectedId}
                onOpenChat={showChat}
              />
            )}
          </>
        )}
      </main>

      {selected ? (
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
          youId={youId}
          editable={editable}
          online={online}
          onClose={() => setSelectedId(null)}
        />
      ) : view === 'agents' && openChat ? (
        sideHidden ? (
          <button className="side-show" onClick={() => setSideHidden(false)} title="Show the chat's context, handoff and locks">
            ‹
          </button>
        ) : (
          <ChatSidePanel state={state} chat={openChat} onSelect={setChatId} onCollapse={() => setSideHidden(true)} />
        )
      ) : null}
    </div>
  );
}

/** Offline notice, or the last thing the server refused; an error stays until you dismiss it. */
function Banner({ state }: { state: AppState }) {
  const { status, error } = state.session;
  const [dismissed, setDismissed] = useState<typeof error>(null);

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
      <p className="banner error">
        <span className="grow">{error.message}</span>
        <button className="link" onClick={() => setDismissed(error)} aria-label="Dismiss">
          ✕
        </button>
      </p>
    );
  }
  return null;
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

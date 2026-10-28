import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { chatWorkspaces, findOverlaps, issuesOfTask, needsYou, untriagedIssues, whoIsDoing, type FeatureState, type NeedTarget } from '@pct/shared';
import type { AppState, HostingInfo } from '../common/api';
import { ChatScreen, ChatSidePanel } from './AgentChat';
import { AgentsScreen } from './Agents';
import { Avatar } from './Avatar';
import { Board } from './Board';
import { GitHubScreen, OverlapsScreen, WorkspaceCard } from './GitHub';
import { HomeScreen } from './Home';
import { IssuesScreen } from './Issues';
import { LocksScreen } from './Locks';
import { Logo } from './Logo';
import { MemoryScreen } from './Memory';
import { NotificationSettings } from './Notifications';
import { EngineSettings } from './Engine';
import { PriceSettings } from './Cost';
import { PlanningScreen } from './Planning';
import { SetupScreen } from './Setup';
import { keepFor } from './kept';
import { useClickOutside, useEscape } from './Dialog';
import { recall, remember } from './storage';
import { TaskDetail } from './TaskDetail';
import { UpdateButton, VersionSettings } from './UpdateButton';

// Nav from issue #34: Home first, agent setup behind the Settings gear, and
// GitHub, locks and overlaps together under Code. Agent chats are "Chats" so
// they are not mistaken for setting agents up (issue #64).
type View = 'home' | 'board' | 'planning' | 'chats' | 'code' | 'memory' | 'settings' | 'setup';
const NAV: { label: string; view: View }[] = [
  { label: 'Home', view: 'home' },
  { label: 'Board', view: 'board' },
  { label: 'Planning', view: 'planning' },
  { label: 'Chats', view: 'chats' },
  { label: 'Code', view: 'code' },
  { label: 'Memory', view: 'memory' },
];

export type CodeTab = 'github' | 'issues' | 'locks' | 'overlaps';
export type SettingsTab = 'agents' | 'engine' | 'prices' | 'notifications' | 'versions';
const SETTINGS_TABS: { label: string; tab: SettingsTab }[] = [
  { label: 'Agents', tab: 'agents' },
  { label: 'Game engine', tab: 'engine' },
  { label: 'Model prices', tab: 'prices' },
  { label: 'Notifications', tab: 'notifications' },
  { label: 'Versions', tab: 'versions' },
];

/** One title bar popover at a time (issue #64). */
type Popover = 'menu' | 'invite' | 'snapshot' | null;

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
  keepFor(session.session?.id ?? null);
  const participants = [...session.participants].sort((a, b) => a.connectedAt - b.connectedAt);
  const online = session.status === 'connected';
  const editable = state.canEditTasks;
  const youId = session.you?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [popover, setPopover] = useState<Popover>(null);
  const [view, setView] = useState<View>('home');
  const [codeTab, setCodeTab] = useState<CodeTab>('github');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('agents');
  const openSettings = (tab: SettingsTab = 'agents') => {
    setSettingsTab(tab);
    setView('settings');
  };
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
    setView('chats');
  };
  const selected = session.tasks.find((t) => t.id === selectedId) ?? null;
  const overlaps = useMemo(
    () =>
      findOverlaps({
        workspaces: [
          ...Object.entries(session.workspaces).map(([participantId, workspace]) => ({
            participantId,
            name: session.participants.find((p) => p.id === participantId)?.name ?? 'Someone',
            workspace,
          })),
          ...chatWorkspaces(session.chats, session.agents),
        ],
        github: session.github,
        locks: session.locks,
      }),
    [session.workspaces, session.participants, session.github, session.locks, session.chats, session.agents],
  );
  // One "needs you" list for the Home nav count and Home itself; notifications (main process) build on it too.
  const needs = useMemo(() => needsYou(session, youId, overlaps), [session, youId, overlaps]);
  const approvals = needs.filter((n) => n.kind === 'approval').length;
  const toTriage = useMemo(() => untriagedIssues(session).length, [session.github, session.planning, session.tasks, session.issueMarks]);
  const openFeature = (id: string) => {
    setPlanFocus({ id, filter: null });
    setView('planning');
  };
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
      case 'issues':
        setCodeTab(target.screen);
        return setView('code');
      case 'url':
        window.open(target.url);
    }
  };
  // Clicking a Windows notification opens what it was about; a summary opens Home.
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(
    () =>
      window.pct.onOpenTarget((target) => {
        if (target) goRef.current(target);
        else setView('home');
      }),
    [],
  );
  const openCode = (tab: CodeTab) => {
    setCodeTab(tab);
    setView('code');
  };
  const showSide = !!selected || (view === 'chats' && !!openChat);
  useEscape(() => setSelectedId(null), !!selected);

  return (
    <div className={`shell${showSide && !(sideHidden && !selected) ? '' : ' no-side'}`}>
      <header className="titlebar">
        <Logo size={20} />
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
        <button
          className={view === 'settings' ? 'secondary gear active' : 'secondary gear'}
          onClick={() => openSettings()}
          title="Settings: agents, API keys, model prices and notifications"
          aria-label="Settings"
        >
          ⚙
        </button>
        {hosting ? (
          <SessionMenu
            hosting={hosting}
            popover={popover}
            onPopover={setPopover}
            canTag={!!state.workspace?.folder && !state.workspace.error}
          />
        ) : (
          <button className="secondary" onClick={() => void window.pct.leave()}>
            Leave
          </button>
        )}
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
            {item.view === 'chats' && approvals > 0 && <span className="nav-count">{approvals}</span>}
          </button>
        ))}
        <WorkspaceCard local={state.workspace} tasks={session.tasks} onOpenTask={setSelectedId} onSetup={() => setView('setup')} />
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
            onInvite={() => setPopover('invite')}
            onSettings={openSettings}
            onSetup={() => setView('setup')}
            onCode={openCode}
          />
        ) : view === 'setup' ? (
          <SetupScreen state={state} onDone={() => setView('home')} />
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
          <div className="agents-screen settings-screen">
            <header className="screen-header">
              <h1>Settings</h1>
            </header>
            <div className="tabs" role="tablist">
              {SETTINGS_TABS.map((t) => (
                <button
                  key={t.tab}
                  role="tab"
                  aria-selected={settingsTab === t.tab}
                  className={settingsTab === t.tab ? 'nav active' : 'nav'}
                  onClick={() => setSettingsTab(t.tab)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {settingsTab === 'agents' ? (
              <AgentsScreen
                state={state}
                onOpenChat={(agentId) => {
                  const existing = [...session.chats].sort((a, b) => b.updatedAt - a.updatedAt).find((c) => c.agentId === agentId);
                  setChatId(existing?.id ?? null);
                  setNewChatAgentId(existing ? null : agentId);
                  setView('chats');
                }}
              />
            ) : settingsTab === 'engine' ? (
              <EngineSettings state={state} />
            ) : settingsTab === 'prices' ? (
              <PriceSettings state={state} />
            ) : settingsTab === 'notifications' ? (
              <NotificationSettings state={state} />
            ) : (
              <VersionSettings />
            )}
          </div>
        ) : view === 'chats' ? (
          <ChatScreen
            state={state}
            chatId={chatId}
            newChatAgentId={newChatAgentId}
            onSelect={(id) => {
              setNewChatAgentId(null);
              setChatId(id);
            }}
            onSetup={() => openSettings('agents')}
          />
        ) : view === 'board' ? (
          <Board
            tasks={session.tasks}
            locks={session.locks}
            participants={participants}
            github={session.github}
            overlaps={overlaps}
            chats={session.chats}
            messages={session.messages}
            planning={session.planning}
            youId={youId}
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
              <button className={codeTab === 'issues' ? 'nav active' : 'nav'} onClick={() => setCodeTab('issues')}>
                Issues{toTriage > 0 && <span className="nav-count" title="Not linked or triaged">{toTriage}</span>}
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
            ) : codeTab === 'issues' ? (
              <IssuesScreen state={state} onOpenFeature={openFeature} onOpenTask={setSelectedId} />
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
          chats={session.chats}
          agents={session.agents}
          onOpenChat={showChat}
          planning={session.planning}
          issues={issuesOfTask(session, selected)}
          youId={youId}
          editable={editable}
          online={online}
          usage={session.usage}
          prices={session.prices}
          onClose={() => setSelectedId(null)}
        />
      ) : view === 'chats' && openChat ? (
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

/**
 * The host's session actions in one menu (issue #64): Invite, Snapshot and
 * Stop hosting. Only one of its popovers is open at a time; Escape or a click
 * outside closes it.
 */
function SessionMenu({
  hosting,
  popover,
  onPopover,
  canTag,
}: {
  hosting: HostingInfo;
  popover: Popover;
  onPopover: (popover: Popover) => void;
  canTag: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = () => onPopover(null);
  useEscape(close, popover !== null);
  useClickOutside(ref, close, popover !== null);
  return (
    <div ref={ref} className="session-menu">
      <button
        className={popover ? 'secondary active' : 'secondary'}
        aria-haspopup="menu"
        aria-expanded={popover === 'menu'}
        onClick={() => onPopover(popover ? null : 'menu')}
      >
        Session ▾
      </button>
      {popover === 'menu' && (
        <div className="popover card menu" role="menu">
          <button role="menuitem" className="menu-item" onClick={() => onPopover('invite')} autoFocus>
            Invite…<span className="muted small">Code for your friend to join</span>
          </button>
          <button role="menuitem" className="menu-item" onClick={() => onPopover('snapshot')}>
            Snapshot…<span className="muted small">Save the board, planning and memory as they are now</span>
          </button>
          <button
            role="menuitem"
            className="menu-item bad"
            onClick={() => {
              close();
              void window.pct.leave();
            }}
          >
            Stop hosting<span className="muted small">Ends the session for everyone until you host again</span>
          </button>
        </div>
      )}
      {popover === 'invite' && <InvitePopover hosting={hosting} onClose={close} />}
      {popover === 'snapshot' && <SnapshotPopover canTag={canTag} onClose={close} />}
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
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const copy = () => {
    window.pct.copyText(hosting.invite);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const replace = async () => {
    setBusy(true);
    const done = await window.pct.newInvite();
    setBusy(false);
    setConfirming(false);
    setResult(done.ok ? { ok: true, text: 'New code made. The old one no longer lets anyone new join.' } : { ok: false, text: done.error });
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
      {confirming ? (
        <div className="invite-confirm">
          <p className="muted">
            The current code stops working for anyone who has not joined yet. People who joined before stay in, and their
            Rejoin keeps working. Use this if the code was pasted somewhere it should not be.
          </p>
          <div className="row">
            <button onClick={() => void replace()} disabled={busy}>
              Make a new code
            </button>
            <button className="secondary" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        result && <p className={result.ok ? 'muted' : 'error'}>{result.text}</p>
      )}
      <div className="row">
        {!confirming && (
          <button className="secondary" onClick={() => setConfirming(true)} title="Replace the invite code, say if it leaked">
            New invite code
          </button>
        )}
        <button className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

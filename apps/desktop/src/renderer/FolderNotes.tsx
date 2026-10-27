import { useEffect, useMemo, useState } from 'react';
import { describeConnection } from '@pct/shared';
import type { AppState } from '../common/api';
import {
  STATE_LABELS,
  draftNotePrompt,
  folderLabel,
  formatTokens,
  rootIndex,
  updateNotePrompt,
  type FolderInfo,
  type FolderNotesReport,
  type NoteDraft,
  type NoteState,
} from '../common/folder-notes';
import { runnerOf } from './Agents';

// Project memory, Folder notes tab: each folder of your project folder with
// its token weight and whether its AGENTS.md still matches it. Every warning
// is one click from a fix: a prompt that goes to an agent chat or becomes a task.

const ATTENTION: NoteState[] = ['stale', 'missing', 'drifting'];
const STATE_ORDER: Record<NoteState, number> = { stale: 0, missing: 1, drifting: 2, fresh: 3, 'not-needed': 4 };

const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;

function committedLabel(at: number | null): string {
  if (at === null) return 'being edited now (not committed)';
  if (at === 0) return 'committed long ago';
  const days = Math.floor((Date.now() - at) / 86_400_000);
  return days < 1 ? 'committed today' : days === 1 ? 'committed yesterday' : `committed ${days} days ago`;
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const nameOf = (folder: FolderInfo) => (folder.path === '' ? 'Top folder' : folder.path.slice(folder.path.lastIndexOf('/') + 1));
const isChild = (child: FolderInfo, parent: FolderInfo) =>
  child.depth === parent.depth + 1 && (parent.path === '' || child.path.startsWith(`${parent.path}/`));

export function FolderNotesScreen({
  state,
  onOpenTask,
  onOpenChat,
}: {
  state: AppState;
  onOpenTask: (taskId: string) => void;
  onOpenChat: (chatId: string) => void;
}) {
  const local = state.workspace;
  const [report, setReport] = useState<FolderNotesReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState<'tree' | 'attention'>('tree');
  const [selectedPath, setSelectedPath] = useState<string>('');
  /** Folders opened or closed by hand; the rest start open down to two levels. */
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [indexCopied, setIndexCopied] = useState(false);

  const scan = async (fresh: boolean) => {
    setScanning(true);
    const result = await window.pct.scanFolderNotes(fresh);
    setScanning(false);
    if (result.ok) {
      setReport(result.value);
      setError(null);
    } else setError(result.error);
  };

  // Scan when the tab opens and whenever git sees your folder change; the main
  // process answers from its cache when nothing did.
  const folderKey = local && !local.error ? JSON.stringify([local.folder, local.workspace?.branch, local.workspace?.files, local.git?.uncommitted]) : null;
  useEffect(() => {
    if (folderKey) void scan(false);
    else setReport(null);
  }, [folderKey]);

  const folders = report?.folders ?? [];
  const byPath = useMemo(() => new Map(folders.map((f) => [f.path, f])), [folders]);
  const counts = useMemo(() => {
    const out: Record<NoteState, number> = { fresh: 0, drifting: 0, stale: 0, missing: 0, 'not-needed': 0 };
    for (const f of folders) out[f.state]++;
    return out;
  }, [folders]);
  const parents = useMemo(() => new Set(folders.filter((f) => f.path !== '').map((f) => (f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''))), [folders]);
  const selected = byPath.get(selectedPath) ?? folders[0] ?? null;

  if (!local || local.error) {
    return (
      <section className="card">
        <h2>Folder notes</h2>
        <p className="muted">
          Folder notes are read from your project folder. Choose it at the bottom left, then come back here.
        </p>
      </section>
    );
  }

  // The tree: a folder shows when all its parents are open. Deep folders
  // start closed so big projects open readable.
  const visible = (folder: FolderInfo) => {
    for (let path = folder.path; path !== ''; ) {
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      const parentInfo = byPath.get(parent);
      if (parentInfo && !isOpen(parentInfo)) return false;
      path = parent;
    }
    return true;
  };
  const hasChildren = (folder: FolderInfo) => parents.has(folder.path);
  const isOpen = (folder: FolderInfo) => opened[folder.path] ?? folder.depth < 2;
  const toggle = (folder: FolderInfo) => setOpened({ ...opened, [folder.path]: !isOpen(folder) });
  const rows =
    filter === 'tree'
      ? folders.filter(visible)
      : folders
          .filter((f) => ATTENTION.includes(f.state))
          .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.ownTokens - a.ownTokens);
  const maxTokens = Math.max(1, ...folders.filter((f) => f.path !== '').map((f) => f.tokens));
  const attention = counts.stale + counts.missing + counts.drifting;

  return (
    <div className="folder-notes">
      <NoteDrafts state={state} />
      <section className="card">
        <div className="fn-header">
          <div className="grow">
            <h2>Folder notes</h2>
            <p className="muted small">
              A folder note is a short <code>AGENTS.md</code> that tells agents what a folder does, what to read first and what to skip, so
              they read less. Weight is readable text in tokens (characters / 4); binary files only cost their names.
            </p>
          </div>
          <button className="secondary" disabled={scanning} onClick={() => void scan(true)}>
            {scanning ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
        {error && <p className="error small">{error}</p>}
        {report && (
          <>
            <div className="fn-stats">
              <span>
                <strong>{formatTokens(report.totals.tokens)}</strong> <span className="muted">tokens in {report.totals.files} readable files</span>
              </span>
              {report.totals.binaryFiles > 0 && (
                <span className="muted">
                  {report.totals.binaryFiles} binary files ({formatBytes(report.totals.binaryBytes)}) by name only
                </span>
              )}
              <span className="muted">
                {report.totals.notes} {report.totals.notes === 1 ? 'note' : 'notes'}
              </span>
              {report.totals.ignoredFiles > 0 && <span className="muted">{report.totals.ignoredFiles} build and engine files skipped</span>}
            </div>
            <div className="fn-stats">
              {(['stale', 'missing', 'drifting', 'fresh'] as const).map((s) => (
                <span key={s} className={`fn-state fn-${s}`}>
                  {STATE_LABELS[s]} {counts[s]}
                </span>
              ))}
            </div>
            {report.truncated && <p className="warning small">This project has more files than the scan reads; the rest are left out.</p>}
          </>
        )}
        {!report && !error && <p className="muted">Scanning {local.folder}…</p>}
      </section>

      {report && (
        <div className="fn-body">
          <section className="card fn-tree">
            <div className="tabs">
              <button className={filter === 'tree' ? 'nav active' : 'nav'} onClick={() => setFilter('tree')}>
                All folders
              </button>
              <button className={filter === 'attention' ? 'nav active' : 'nav'} onClick={() => setFilter('attention')}>
                Needs attention{attention > 0 && <span className="nav-count">{attention}</span>}
              </button>
            </div>
            {rows.length === 0 && <p className="muted">{filter === 'attention' ? 'Every note matches its folder.' : 'No folders.'}</p>}
            <ul className="fn-list">
              {rows.map((folder) => (
                <li key={folder.path}>
                  <button
                    className={folder.path === selected?.path ? 'fn-row active' : 'fn-row'}
                    style={filter === 'tree' ? { paddingLeft: 8 + folder.depth * 16 } : undefined}
                    onClick={() => setSelectedPath(folder.path)}
                  >
                    {filter === 'tree' && (
                      <span
                        className="fn-twisty"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (hasChildren(folder)) toggle(folder);
                        }}
                      >
                        {hasChildren(folder) ? (isOpen(folder) ? '▾' : '▸') : ''}
                      </span>
                    )}
                    <span className="fn-name">{filter === 'tree' ? nameOf(folder) : folder.path || 'Top folder'}</span>
                    {folder.state !== 'not-needed' && <span className={`fn-state fn-${folder.state}`}>{STATE_LABELS[folder.state]}</span>}
                    <span className="fn-weight" title={`${folder.tokens} tokens`}>
                      {folder.tokens > 0 && <span className="fn-bar" style={{ width: `${Math.max(2, (folder.tokens / maxTokens) * 100)}%` }} />}
                      <span className="muted small">{folder.tokens === 0 && folder.binaryFiles > 0 ? 'names only' : formatTokens(folder.tokens)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {selected && <FolderDetail key={selected.path} state={state} folder={selected} report={report} onOpenTask={onOpenTask} onOpenChat={onOpenChat} />}
        </div>
      )}

      {report && report.totals.notes > 0 && (
        <section className="card">
          <h2>Root index</h2>
          <p className="muted small">Every note in one list, for the top of an agent's context or a root AGENTS.md.</p>
          <pre className="fn-prompt">{rootIndex(report)}</pre>
          <button
            className="secondary"
            onClick={() => {
              window.pct.copyText(rootIndex(report));
              setIndexCopied(true);
              setTimeout(() => setIndexCopied(false), 1500);
            }}
          >
            {indexCopied ? 'Copied' : 'Copy'}
          </button>
        </section>
      )}
    </div>
  );
}

function PathList({ title, items }: { title: string; items: string[] }) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, 8);
  return (
    <div className="fn-section">
      <h3 className="section-title">{title}</h3>
      <ul className="fn-paths">
        {shown.map((item) => (
          <li key={item}>
            <code className="lock-path">{item}</code>
          </li>
        ))}
      </ul>
      {items.length > shown.length && (
        <button className="link small" onClick={() => setAll(true)}>
          Show all {items.length}
        </button>
      )}
    </div>
  );
}

function FolderDetail({
  state,
  folder,
  report,
  onOpenTask,
  onOpenChat,
}: {
  state: AppState;
  folder: FolderInfo;
  report: FolderNotesReport;
  onOpenTask: (taskId: string) => void;
  onOpenChat: (chatId: string) => void;
}) {
  const [prompt, setPrompt] = useState<string | null>(null);
  const subfolders = report.folders.filter((f) => isChild(f, folder));
  const canDraft = !folder.notePath;
  const needsUpdate = folder.notePath && (folder.state === 'stale' || folder.state === 'drifting' || folder.unmentioned.length > 0);
  const label = (change: string) => (change === 'added' ? 'added' : change === 'deleted' ? 'deleted' : 'changed');

  return (
    <section className="card fn-detail">
      <div className="fn-header">
        <h2 className="grow lock-path">{folder.path === '' ? 'Top folder' : folderLabel(folder.path)}</h2>
        <span className={`fn-state fn-${folder.state}`}>{STATE_LABELS[folder.state]}</span>
      </div>
      {folder.reasons.length > 0 && <p className="small">{sentence(folder.reasons.join('; '))}.</p>}
      <dl className="fn-facts small">
        <dt>Weight</dt>
        <dd>
          {formatTokens(folder.tokens)} tokens in {folder.files} readable files
          {folder.ownTokens !== folder.tokens && <span className="muted"> ({formatTokens(folder.ownTokens)} not covered by notes further down)</span>}
        </dd>
        {folder.binaryFiles > 0 && (
          <>
            <dt>Binary</dt>
            <dd>
              {folder.binaryFiles} files, {formatBytes(folder.binaryBytes)}, by name only
            </dd>
          </>
        )}
        <dt>Note</dt>
        <dd>
          {folder.notePath ? (
            <>
              <code>{folder.notePath}</code>, {formatTokens(folder.noteTokens)} tokens, {committedLabel(folder.noteCommittedAt)}
            </>
          ) : (
            <span className="muted">none</span>
          )}
        </dd>
      </dl>
      {folder.noteSummary && <p className="muted small">“{folder.noteSummary}”</p>}

      <PathList title="Names paths that no longer exist" items={folder.deadReferences} />
      <PathList title="Changed since the note" items={folder.changed.map((c) => `${c.path} (${label(c.change)})`)} />
      <PathList title="Not mentioned in the note" items={folder.unmentioned} />
      {canDraft && <PathList title="Biggest files" items={folder.largest.map((f) => `${f.path} (${formatTokens(f.tokens)})`)} />}

      <div className="row">
        {folder.notePath && (
          <button className={needsUpdate ? undefined : 'secondary'} onClick={() => setPrompt(updateNotePrompt(folder))}>
            Update note
          </button>
        )}
        {canDraft && (
          <button className={folder.state === 'missing' ? undefined : 'secondary'} onClick={() => setPrompt(draftNotePrompt(folder, subfolders))}>
            Draft note
          </button>
        )}
      </div>
      {prompt !== null && (
        <PromptActions state={state} folder={folder} prompt={prompt} onChange={setPrompt} onOpenTask={onOpenTask} onOpenChat={onOpenChat} />
      )}
    </section>
  );
}

/** The ready-to-send prompt, and where it goes: an agent chat, a task, or the clipboard. */
function PromptActions({
  state,
  folder,
  prompt,
  onChange,
  onOpenTask,
  onOpenChat,
}: {
  state: AppState;
  folder: FolderInfo;
  prompt: string;
  onChange: (prompt: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenChat: (chatId: string) => void;
}) {
  const { session } = state;
  const online = session.status === 'connected';
  const [agentId, setAgentId] = useState(
    () => session.agents.find((a) => runnerOf(a, session.participants))?.id ?? session.agents[0]?.id ?? '',
  );
  const [taskId, setTaskId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const title = `${folder.notePath ? 'Update' : 'Write'} folder note for ${folder.path === '' ? 'top folder' : `${folder.path}/`}`;

  const makeTask = async () => {
    const result = await window.pct.folderNoteTask(folder.path);
    if (!result.ok) return setMessage({ ok: false, text: result.error });
    setTaskId(result.value);
    setMessage({ ok: true, text: 'Task made in Planning, scoped to the note only.' });
  };
  const sendToChat = async () => {
    const result = await window.pct.createChat({ agentId, title, taskId });
    if (!result.ok) return setMessage({ ok: false, text: result.error });
    window.pct.postChat(result.value, prompt);
    onOpenChat(result.value);
  };

  return (
    <div className="fn-section">
      <label className="field">
        <span>Prompt (edit it if you like)</span>
        <textarea className="fn-prompt" rows={12} value={prompt} onChange={(e) => onChange(e.target.value)} />
      </label>
      <label className="field">
        <span>Agent</span>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={session.agents.length === 0}>
          {session.agents.length === 0 && <option value="">Add an agent on the Agents screen first</option>}
          {session.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {describeConnection(a.connection)}
              {runnerOf(a, session.participants) ? '' : ' (not running)'}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <button disabled={!online || !agentId || !prompt.trim()} onClick={() => void sendToChat()}>
          Send to agent chat
        </button>
        {taskId ? (
          <button className="secondary" onClick={() => onOpenTask(taskId)}>
            Open task
          </button>
        ) : (
          <button className="secondary" disabled={!state.canEditTasks} onClick={() => void makeTask()}>
            Make a task
          </button>
        )}
        <button className="secondary" onClick={() => window.pct.copyText(prompt)}>
          Copy prompt
        </button>
      </div>
      {message && <p className={message.ok ? 'good small' : 'error small'}>{message.text}</p>}
      {taskId && <p className="muted small">Sending to an agent chat now links the chat to that task.</p>}
    </div>
  );
}

/**
 * Notes the notes agent drafted by itself (see project setup), waiting for a
 * person: accept writes the file into your project folder for you to commit.
 */
function NoteDrafts({ state }: { state: AppState }) {
  const agent = state.session.agents.find((a) => a.id === state.notesAgent) ?? null;
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drafts = state.noteDrafts;
  if (!agent && drafts.length === 0) return null;
  const accept = async (draft: NoteDraft) => {
    const result = await window.pct.acceptNoteDraft(draft.notePath);
    setError(result.ok ? null : result.error);
  };
  return (
    <section className="card fn-drafts">
      <div className="fn-header">
        <div className="grow">
          <h2>
            Drafted notes <span className="muted">{drafts.length === 0 ? 'none waiting' : `${drafts.length} to review`}</span>
          </h2>
          <p className="muted small">
            {agent
              ? `${agent.name} keeps folder notes up to date: when a note goes stale or a big folder has none, it drafts the note here for you to review.`
              : 'Drafts from before the notes agent was turned off.'}
          </p>
        </div>
        {agent && (
          <button className="secondary" onClick={() => window.pct.setNotesAgent(null)} title="Stop drafting notes by itself; you can turn it on again in project setup">
            Turn off
          </button>
        )}
      </div>
      {error && <p className="error small">{error}</p>}
      <ul className="fn-draft-list">
        {drafts.map((draft) => (
          <li key={draft.notePath}>
            <div className="row">
              <code className="grow">{draft.notePath}</code>
              <span className="muted small">
                {draft.previous ? 'Update' : 'First note'} by {draft.agentName}
              </span>
              <button className="link small" onClick={() => setOpen(open === draft.notePath ? null : draft.notePath)}>
                {open === draft.notePath ? 'Hide' : 'Review'}
              </button>
              <button className="small" onClick={() => void accept(draft)}>
                Accept
              </button>
              <button className="secondary small" onClick={() => window.pct.discardNoteDraft(draft.notePath)}>
                Discard
              </button>
            </div>
            <span className="muted small">{draft.reason}</span>
            {open === draft.notePath && (
              <div className="fn-draft-compare">
                {draft.previous && (
                  <div>
                    <h3 className="section-title">Now</h3>
                    <pre className="fn-prompt">{draft.previous}</pre>
                  </div>
                )}
                <div>
                  <h3 className="section-title">Draft</h3>
                  <pre className="fn-prompt">{draft.text}</pre>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

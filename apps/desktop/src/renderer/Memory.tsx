import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  MEMORY_KIND_LABELS,
  MEMORY_KIND_SINGULAR,
  MEMORY_TEXT_LIMIT,
  MemoryKind,
  filesOutsideScope,
  taskChangedFiles,
  type MemoryEntry,
  type MemorySource,
} from '@pct/shared';
import type { AppState } from '../common/api';
import { FolderNotesScreen } from './FolderNotes';
import { LiveText } from './LiveText';

// Screen 6: project memory and the bloat check. Memory is what everyone,
// people and agents, should know about the project; every agent gets it as
// context. The bloat check points at things that make the project bigger
// than it needs to be.

type Tab = MemoryKind | 'bloat' | 'folder-notes';

const HINTS: Record<MemoryKind, string> = {
  decision: 'How the project is built and why, so nobody (and no agent) undoes it by accident.',
  convention: 'How things are named, formatted and organized here.',
  issue: 'Problems everyone should know about until they are fixed.',
  plan: 'What is being worked on now and what comes next.',
};

export function MemoryScreen({ state, onOpenTask, onOpenChat }: { state: AppState; onOpenTask: (taskId: string) => void; onOpenChat: (chatId: string) => void }) {
  const [tab, setTab] = useState<Tab>('decision');
  const { memory } = state.session;

  return (
    <div className="memory-screen">
      <header className="screen-header">
        <div>
          <h1>Project memory</h1>
          <p className="muted">Shared with everyone in the session, and given to every agent with its instructions.</p>
        </div>
      </header>
      <div className="tabs">
        {MemoryKind.options.map((kind) => {
          const count = memory.filter((e) => e.kind === kind).length;
          return (
            <button key={kind} className={tab === kind ? 'nav active' : 'nav'} onClick={() => setTab(kind)}>
              {MEMORY_KIND_LABELS[kind]}
              {count > 0 && <span className="muted"> {count}</span>}
            </button>
          );
        })}
        <button className={tab === 'bloat' ? 'nav active' : 'nav'} onClick={() => setTab('bloat')}>
          Bloat check
        </button>
        <button className={tab === 'folder-notes' ? 'nav active' : 'nav'} onClick={() => setTab('folder-notes')}>
          Folder notes
        </button>
      </div>
      {tab === 'folder-notes' ? (
        <FolderNotesScreen state={state} onOpenTask={onOpenTask} onOpenChat={onOpenChat} />
      ) : tab === 'bloat' ? (
        <BloatCheck state={state} onOpenTask={onOpenTask} />
      ) : (
        <MemoryList key={tab} kind={tab} state={state} onOpenChat={onOpenChat} />
      )}
    </div>
  );
}

function MemoryList({ kind, state, onOpenChat }: { kind: MemoryKind; state: AppState; onOpenChat: (chatId: string) => void }) {
  const entries = state.session.memory.filter((e) => e.kind === kind);
  const editable = state.canEditTasks;
  const [title, setTitle] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    const id = crypto.randomUUID();
    window.pct.editMemory({ op: 'create', id, kind, title: title.trim() });
    setTitle('');
    setOpenId(id);
  };

  return (
    <section className="memory-list">
      <p className="muted small">{HINTS[kind]}</p>
      <form className="row" onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`New ${MEMORY_KIND_SINGULAR[kind].toLowerCase()}`} maxLength={200} disabled={!editable} />
        <button type="submit" disabled={!editable || !title.trim()}>
          Add
        </button>
      </form>
      {entries.length === 0 && <p className="muted">Nothing here yet.</p>}
      <ul>
        {[...entries].reverse().map((entry) => (
          <MemoryCard
            key={entry.id}
            entry={entry}
            open={entry.id === openId}
            editable={editable}
            textEdits={state.textEdits}
            chatExists={entry.source?.kind === 'chat' && state.session.chats.some((c) => c.id === entry.source!.id)}
            onToggle={() => setOpenId(entry.id === openId ? null : entry.id)}
            onOpenChat={onOpenChat}
          />
        ))}
      </ul>
    </section>
  );
}

function MemoryCard({
  entry,
  open,
  editable,
  textEdits,
  chatExists,
  onToggle,
  onOpenChat,
}: {
  entry: MemoryEntry;
  open: boolean;
  editable: boolean;
  textEdits: number;
  chatExists: boolean;
  onToggle: () => void;
  onOpenChat: (chatId: string) => void;
}) {
  const [title, setTitle] = useState(entry.title);
  useEffect(() => setTitle(entry.title), [entry.title]);
  const saveTitle = () => {
    const next = title.trim();
    if (next && next !== entry.title) window.pct.editMemory({ op: 'set', id: entry.id, title: next });
    else setTitle(entry.title);
  };

  return (
    <li className="card memory-card">
      {open ? (
        <>
          <div className="row">
            <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} disabled={!editable} maxLength={200} />
            <select value={entry.kind} disabled={!editable} onChange={(e) => window.pct.editMemory({ op: 'set', id: entry.id, kind: e.target.value as MemoryKind })}>
              {MemoryKind.options.map((k) => (
                <option key={k} value={k}>
                  {MEMORY_KIND_SINGULAR[k]}
                </option>
              ))}
            </select>
          </div>
          <LiveText
            value={entry.body}
            applied={textEdits}
            onEdit={(value, base) => window.pct.editMemory({ op: 'text', id: entry.id, value, base })}
            rows={Math.min(14, Math.max(4, entry.body.split('\n').length + 1))}
            maxLength={MEMORY_TEXT_LIMIT}
            disabled={!editable}
            placeholder="Details: what, why, and anything to watch out for"
            autoFocus={!entry.body}
          />
        </>
      ) : (
        <button className="memory-summary" onClick={onToggle}>
          <strong>{entry.title}</strong>
          {entry.body.trim() && <span className="muted">{entry.body.trim().split('\n')[0]}</span>}
        </button>
      )}
      <p className="muted small memory-meta">
        {entry.createdBy}, {new Date(entry.updatedAt).toLocaleDateString()}
        <Source source={entry.source} chatExists={chatExists} onOpenChat={onOpenChat} />
        {open && (
          <>
            {' · '}
            <button className="link small" onClick={onToggle}>
              Done
            </button>
            {editable && (
              <>
                {' · '}
                <button
                  className="link small bad"
                  onClick={() => confirm(`Remove "${entry.title}" from project memory?`) && window.pct.editMemory({ op: 'delete', id: entry.id })}
                >
                  Remove
                </button>
              </>
            )}
          </>
        )}
      </p>
    </li>
  );
}

function Source({ source, chatExists, onOpenChat }: { source: MemorySource | null; chatExists: boolean; onOpenChat: (chatId: string) => void }) {
  if (!source) return null;
  if (source.kind === 'bloat') return <> · from the bloat check</>;
  return (
    <>
      {' · from the chat '}
      {chatExists && source.id ? (
        <button className="link small" onClick={() => onOpenChat(source.id!)}>
          {source.title}
        </button>
      ) : (
        `“${source.title}”`
      )}
    </>
  );
}

function BloatCheck({ state, onOpenTask }: { state: AppState; onOpenTask: (taskId: string) => void }) {
  const { session } = state;
  const report = session.bloat;
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noted, setNoted] = useState<Set<string>>(new Set());
  const canRun = session.status === 'connected' && !!state.workspace?.folder && !state.workspace.error;

  // Changes outside a task's paths, live from workspaces, branches and pull requests.
  const outside = useMemo(
    () =>
      session.tasks.flatMap((task) => {
        const files = filesOutsideScope(taskChangedFiles(task, session.workspaces, session.github), task.scope);
        return files.length ? [{ task, files }] : [];
      }),
    [session.tasks, session.workspaces, session.github],
  );

  const run = async () => {
    setRunning(true);
    setError(null);
    const result = await window.pct.runBloatCheck();
    setRunning(false);
    if (!result.ok) setError(result.error);
  };

  const note = (key: string, title: string, body: string) => {
    window.pct.editMemory({
      op: 'create',
      id: crypto.randomUUID(),
      kind: 'issue',
      title: title.slice(0, 200),
      body,
      source: { kind: 'bloat', id: null, title: 'Bloat check' },
    });
    setNoted(new Set(noted).add(key));
  };
  const noteButton = (id: string, title: string, body: string) =>
    noted.has(id) ? (
      <span className="muted small">Noted</span>
    ) : (
      <button className="link small" disabled={!state.canEditTasks} onClick={() => note(id, title, body)}>
        Note as known issue
      </button>
    );

  return (
    <section className="bloat">
      <div className="card bloat-run">
        <div className="grow">
          {report ? (
            <p className="small">
              Last run by {report.ranBy} {report.branch ? `on ${report.branch} ` : ''}
              {new Date(report.ranAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}, {report.scanned.toLocaleString()} files
              {report.truncated && ' (the project has more; only the first ones were checked)'}.
            </p>
          ) : (
            <p className="small">Not run yet in this session.</p>
          )}
          <p className="muted small">
            Reads your project folder (files git ignores are left out). Findings are hints for a person to look at; nothing is changed or
            deleted.
          </p>
        </div>
        <button onClick={() => void run()} disabled={!canRun || running}>
          {running ? 'Checking…' : 'Run bloat check'}
        </button>
      </div>
      {!state.workspace?.folder && <p className="muted small">Choose your project folder (bottom left) to run the check.</p>}
      {error && <p className="error small">{error}</p>}

      <BloatSection title="Changes outside the task" count={outside.length} empty="Every task's changes are inside its allowed paths.">
        {outside.map(({ task, files }) => (
          <li key={task.id}>
            <button className="link" onClick={() => onOpenTask(task.id)}>
              {task.title}
            </button>
            <span className="muted small"> changes {files.length} {files.length === 1 ? 'file' : 'files'} outside its paths: </span>
            <code className="small">{files.slice(0, 5).join(', ')}</code>
            {files.length > 5 && <span className="muted small"> and {files.length - 5} more</span>}
          </li>
        ))}
      </BloatSection>

      {report && (
        <>
          <BloatSection
            title="Duplicate systems"
            count={report.duplicates.length}
            empty="No copied files or code files with the same name in different folders."
          >
            {report.duplicates.map((d) => {
              const id = `dup:${d.paths.join('|')}`;
              const what = d.reason === 'identical' ? 'Identical files' : 'Same name in different folders';
              return (
                <li key={id}>
                  <span className="small">{what}: </span>
                  <code className="small">{d.paths.join(', ')}</code>{' '}
                  {noteButton(id, `${what}: ${d.paths.map((p) => p.split('/').pop()).join(', ')}`, d.paths.join('\n'))}
                </li>
              );
            })}
          </BloatSection>
          <BloatSection title="Assets nothing refers to" count={report.unusedAssets.length} empty="Every image, sound, model and font is referred to somewhere.">
            {report.unusedAssets.map((path) => (
              <li key={path}>
                <code className="small">{path}</code> {noteButton(`asset:${path}`, `Possibly unused asset: ${path}`, path)}
              </li>
            ))}
          </BloatSection>
          <BloatSection
            title="Dependencies nothing uses"
            count={report.unusedDependencies.length}
            empty="Every package dependency is imported or run somewhere."
          >
            {report.unusedDependencies.map((d) => (
              <li key={`${d.manifest}:${d.name}`}>
                <code className="small">{d.name}</code>
                <span className="muted small">
                  {' '}
                  in {d.manifest}
                  {d.dev ? ' (dev)' : ''}{' '}
                </span>
                {noteButton(`dep:${d.manifest}:${d.name}`, `Possibly unnecessary dependency: ${d.name}`, `Declared in ${d.manifest}.`)}
              </li>
            ))}
          </BloatSection>
          <p className="muted small">
            Assets are matched by file name in code, scenes and configs; Unreal’s binary assets are not checked yet. A dependency counts as
            used when it is imported or run from a script.
          </p>
        </>
      )}
    </section>
  );
}

function BloatSection({ title, count, empty, children }: { title: string; count: number; empty: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2>
        {title} {count > 0 && <span className="badge badge-warn">{count}</span>}
      </h2>
      {count === 0 ? <p className="muted small">{empty}</p> : <ul className="bloat-list">{children}</ul>}
    </section>
  );
}

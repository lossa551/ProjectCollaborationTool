import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  MEMORY_KIND_LABELS,
  MEMORY_KIND_SINGULAR,
  MEMORY_TEXT_LIMIT,
  MEMORY_TOKEN_BUDGET,
  MemoryKind,
  estimateTokens,
  formatTokens,
  memoryEntryTokens,
  renderMemory,
  filesOutsideScope,
  taskChangedFiles,
  duplicateKey,
  type BloatTrigger,
  type MemoryEntry,
  type MemorySource,
} from '@pct/shared';
import type { AppState } from '../common/api';
import { folderLabel } from '../common/folder-notes';
import { FolderNotesScreen } from './FolderNotes';
import { LiveText } from './LiveText';
import { ask } from './Dialog';

// Screen 6: project memory and the bloat check. Memory is what everyone,
// people and agents, should know about the project; every agent gets it as
// context. The bloat check points at things that make the project bigger
// than it needs to be.

type Tab = MemoryKind | 'archived' | 'bloat' | 'folder-notes';

const HINTS: Record<MemoryKind, string> = {
  decision: 'How the project is built and why, so nobody (and no agent) undoes it by accident.',
  convention: 'How things are named, formatted and organized here.',
  issue: 'Problems everyone should know about until they are fixed.',
  plan: 'What is being worked on now and what comes next.',
};

const ARCHIVED_HINT =
  'Entries kept for the record but no longer given to agents, such as finished plans and fixed issues. They stay in the exported file, and agents can still look them up.';

export function MemoryScreen({ state, onOpenTask, onOpenChat }: { state: AppState; onOpenTask: (taskId: string) => void; onOpenChat: (chatId: string) => void }) {
  const [tab, setTab] = useState<Tab>('decision');
  const { memory } = state.session;
  // What an agent with no task carries; a chat's own order can differ a little (see memoryOrder).
  const given = useMemo(() => renderMemory(memory), [memory]);
  const titleOnly = useMemo(() => new Set(given.listed.map((e) => e.id)), [given]);
  const archivedCount = memory.filter((e) => e.archived).length;

  return (
    <div className="memory-screen">
      <header className="screen-header">
        <div>
          <h1>Project memory</h1>
          <p className="muted">Shared with everyone in the session, and given to every agent with its instructions.</p>
          {given.text && (
            <p className="muted small memory-tokens">
              Every agent call carries about <strong>{formatTokens(estimateTokens(given.text))} tokens</strong> of memory (budget{' '}
              {formatTokens(MEMORY_TOKEN_BUDGET)}).
              {given.listed.length > 0 &&
                ` ${given.listed.length} ${given.listed.length === 1 ? 'entry goes' : 'entries go'} by title only past it; agents read ${given.listed.length === 1 ? 'it' : 'them'} when needed.`}
              {' '}Archive what agents no longer need.
            </p>
          )}
        </div>
        <MemoryExport state={state} />
      </header>
      <div className="tabs">
        {MemoryKind.options.map((kind) => {
          const count = memory.filter((e) => e.kind === kind && !e.archived).length;
          return (
            <button key={kind} className={tab === kind ? 'nav active' : 'nav'} onClick={() => setTab(kind)}>
              {MEMORY_KIND_LABELS[kind]}
              {count > 0 && <span className="muted"> {count}</span>}
            </button>
          );
        })}
        <button className={tab === 'archived' ? 'nav active' : 'nav'} onClick={() => setTab('archived')}>
          Archived
          {archivedCount > 0 && <span className="muted"> {archivedCount}</span>}
        </button>
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
        <MemoryList key={tab} kind={tab} state={state} titleOnly={titleOnly} onOpenChat={onOpenChat} />
      )}
    </div>
  );
}

/** Writing project memory to docs/project-memory.md in your project folder. */
function MemoryExport({ state }: { state: AppState }) {
  const [error, setError] = useState<string | null>(null);
  const info = state.memoryExport;
  if (!info) return null;
  const write = async () => {
    const result = await window.pct.exportMemory();
    setError(result.ok ? null : result.error);
  };
  const shown = error ?? info.error;
  return (
    <div className="memory-export small">
      <button type="button" className="secondary" onClick={() => void write()} title={`Write every entry to ${info.path} in your project folder, for git and for agents that read repo files`}>
        Write to {info.path}
      </button>
      <label className="check muted" title="Rewrite the file in your project folder whenever an entry changes">
        <input type="checkbox" checked={info.auto} onChange={(e) => window.pct.setMemoryAutoExport(e.target.checked)} />
        Keep it up to date
      </label>
      {shown && <span className="error">{shown}</span>}
    </div>
  );
}

function MemoryList({
  kind,
  state,
  titleOnly,
  onOpenChat,
}: {
  kind: MemoryKind | 'archived';
  state: AppState;
  titleOnly: Set<string>;
  onOpenChat: (chatId: string) => void;
}) {
  const archived = kind === 'archived';
  const entries = state.session.memory.filter((e) => (archived ? e.archived : e.kind === kind && !e.archived));
  const editable = state.canEditTasks;
  const [title, setTitle] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (archived || !title.trim()) return;
    const id = crypto.randomUUID();
    window.pct.editMemory({ op: 'create', id, kind, title: title.trim() });
    setTitle('');
    setOpenId(id);
  };

  return (
    <section className="memory-list">
      <p className="muted small">{archived ? ARCHIVED_HINT : HINTS[kind]}</p>
      {!archived && (
        <form className="row" onSubmit={add}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`New ${MEMORY_KIND_SINGULAR[kind].toLowerCase()}`} maxLength={200} disabled={!editable} />
          <button type="submit" disabled={!editable || !title.trim()}>
            Add
          </button>
        </form>
      )}
      {entries.length === 0 && <p className="muted">Nothing here yet.</p>}
      <ul>
        {[...entries].reverse().map((entry) => (
          <MemoryCard
            key={entry.id}
            entry={entry}
            open={entry.id === openId}
            editable={editable}
            titleOnly={titleOnly.has(entry.id)}
            showKind={archived}
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
  titleOnly,
  showKind,
  textEdits,
  chatExists,
  onToggle,
  onOpenChat,
}: {
  entry: MemoryEntry;
  open: boolean;
  editable: boolean;
  titleOnly: boolean;
  showKind: boolean;
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
        {showKind && `${MEMORY_KIND_SINGULAR[entry.kind]} · `}
        {entry.createdBy}, {new Date(entry.updatedAt).toLocaleDateString()}
        <Source source={entry.source} chatExists={chatExists} onOpenChat={onOpenChat} />
        {!entry.archived && (
          <span title={titleOnly ? 'Past the memory budget: agents get its title and read the rest when they need it' : 'What this entry adds to every agent call'}>
            {' · '}
            {titleOnly ? 'title only for agents' : `${formatTokens(memoryEntryTokens(entry))} tokens`}
          </span>
        )}
        {editable && (
          <>
            {' · '}
            <button
              className="link small"
              title={entry.archived ? 'Give it to agents again' : 'Keep it in the record, but stop giving it to agents with every call'}
              onClick={() => window.pct.editMemory({ op: 'set', id: entry.id, archived: !entry.archived })}
            >
              {entry.archived ? 'Restore' : 'Archive'}
            </button>
          </>
        )}
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
                  onClick={async () =>
                    (await ask(`Remove "${entry.title}" from project memory?`, { confirm: 'Remove', danger: true })) && window.pct.editMemory({ op: 'delete', id: entry.id })
                  }
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
        const files = filesOutsideScope(taskChangedFiles(task, session.workspaces, session.github, session.chats), task.scope);
        return files.length ? [{ task, files }] : [];
      }),
    [session.tasks, session.workspaces, session.github, session.chats],
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
  const noteTask = async (key: string, folder: string) => {
    const result = await window.pct.folderNoteTask(folder);
    if (result.ok) {
      setNoted(new Set(noted).add(key));
      onOpenTask(result.value);
    } else setError(result.error);
  };
  const fresh = new Set(report?.newKeys ?? []);
  const newBadge = (key: string) => (fresh.has(key) ? <span className="badge badge-new">New</span> : null);
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
              Last run {TRIGGER_TEXT[report.trigger]}by {report.ranBy} {report.branch ? `on ${report.branch} ` : ''}
              {new Date(report.ranAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}, {report.scanned.toLocaleString()} files
              {report.truncated && ' (the project has more; only the first ones were checked)'}.
              {report.previousAt !== null && (
                <>
                  {' '}
                  {report.newKeys.length === 0
                    ? 'Nothing new since the scan before.'
                    : `${report.newKeys.length} new since the scan of ${new Date(report.previousAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}.`}
                </>
              )}
            </p>
          ) : (
            <p className="small">Not run yet in this session.</p>
          )}
          <p className="muted small">
            Reads your project folder (files git ignores are left out). It also runs by itself when main or beta gets new commits in your
            folder, and once a day while the folder is open. Findings are hints for a person to look at; nothing is changed or deleted.
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
            empty="No copied files, mostly-alike code, or code files with the same name in different folders."
          >
            {report.duplicates.map((d) => {
              const id = duplicateKey(d);
              const what =
                d.reason === 'identical'
                  ? 'Identical files'
                  : d.reason === 'similar'
                    ? `Mostly the same code (${Math.round((d.similarity ?? 0) * 100)}% in common)`
                    : 'Same name in different folders';
              return (
                <li key={id}>
                  {newBadge(id)}
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
                {newBadge(`asset:${path}`)}
                <code className="small">{path}</code> {noteButton(`asset:${path}`, `Possibly unused asset: ${path}`, path)}
              </li>
            ))}
          </BloatSection>
          {report.unusedGameFiles.length > 0 && (
            <BloatSection
              title={report.unusedGameFiles.some((p) => /\.uasset$/i.test(p)) ? 'Unreal assets no level, config or code uses' : 'Godot files the game never loads'}
              count={report.unusedGameFiles.length}
              empty=""
            >
              {report.unusedGameFiles.map((path) => (
                <li key={path}>
                  {newBadge(`game:${path}`)}
                  <code className="small">{path}</code> {noteButton(`game:${path}`, `Possibly unused: ${path}`, path)}
                </li>
              ))}
            </BloatSection>
          )}
          {report.epicLayout.length > 0 && (
            <BloatSection title="Unreal assets not where Epic says, or not named by Epic’s conventions" count={report.epicLayout.length} empty="">
              {report.epicLayout.map((item) => (
                <li key={item.path}>
                  {newBadge(`epic:${item.path}`)}
                  <code className="small">{item.path}</code> <span className="muted small">{item.problem}</span>{' '}
                  {noteButton(`epic:${item.path}`, `Not by Epic's layout: ${item.path}`, `${item.path}: ${item.problem}`)}
                </li>
              ))}
            </BloatSection>
          )}
          <BloatSection
            title="Dependencies nothing uses"
            count={report.unusedDependencies.length}
            empty="Every package dependency is imported or run somewhere."
          >
            {report.unusedDependencies.map((d) => (
              <li key={`${d.manifest}:${d.name}`}>
                {newBadge(`dep:${d.manifest}:${d.name}`)}
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
          {report.unusedPlugins.length > 0 && (
            <BloatSection title="Add-ons and plugins nothing uses" count={report.unusedPlugins.length} empty="">
              {report.unusedPlugins.map((p) => (
                <li key={p.path}>
                  {newBadge(`plugin:${p.path}`)}
                  <code className="small">{p.path}</code>
                  <span className="muted small"> · {p.engine === 'godot' ? 'Godot add-on' : 'Unreal plugin'} · {p.detail} </span>
                  {noteButton(`plugin:${p.path}`, `Possibly unused ${p.engine === 'godot' ? 'add-on' : 'plugin'}: ${p.name}`, `${p.path}: ${p.detail}.`)}
                </li>
              ))}
            </BloatSection>
          )}
          <BloatSection
            title="Folder notes and large files"
            count={report.folderNotes.length}
            empty="Every folder note matches its folder, big folders have one, and no text file is huge."
          >
            {report.folderNotes.map((f) => {
              const id = `notes:${f.kind}:${f.path}`;
              const folder = f.kind === 'stale-note' ? f.path.slice(0, Math.max(0, f.path.lastIndexOf('/'))) : f.path;
              const what =
                f.kind === 'stale-note' ? 'Out-of-date folder note' : f.kind === 'missing-note' ? 'Folder with no note' : 'Very large text file';
              return (
                <li key={id}>
                  {newBadge(id)}
                  <span className="small">{what}: </span>
                  <code className="small">{f.kind === 'missing-note' ? folderLabel(f.path) : f.path}</code>
                  <span className="muted small"> · {f.detail} </span>
                  {f.kind === 'large-file' ? (
                    noteButton(id, `${what}: ${f.path}`, `${f.path}: ${f.detail}. Agents should search it rather than read it whole.`)
                  ) : (
                    <button className="link small" disabled={!state.canEditTasks || noted.has(id)} onClick={() => void noteTask(id, folder)}>
                      {noted.has(id) ? 'Task made' : 'Make a task'}
                    </button>
                  )}
                </li>
              );
            })}
          </BloatSection>
          {(report.notPulledCount > 0 || report.skipped.length > 0) && (
            <section className="card">
              <h2>Not checked</h2>
              {report.skipped.map((line) => (
                <p key={line} className="warning small">
                  {line}
                </p>
              ))}
              {report.notPulledCount > 0 && (
                <>
                  <p className="small">
                    {report.notPulledCount.toLocaleString()} {report.notPulledCount === 1 ? 'file is a Git LFS pointer' : 'files are Git LFS pointers'}: not
                    pulled on the PC that ran the check, so nothing about {report.notPulledCount === 1 ? 'it' : 'them'} was checked.
                  </p>
                  <ul className="bloat-list">
                    {report.notPulled.map((path) => (
                      <li key={path}>
                        <code className="small">{path}</code>
                      </li>
                    ))}
                    {report.notPulledCount > report.notPulled.length && (
                      <li className="muted small">and {(report.notPulledCount - report.notPulled.length).toLocaleString()} more</li>
                    )}
                  </ul>
                </>
              )}
            </section>
          )}
          <p className="muted small">
            Outside Godot and Unreal projects, assets are matched by file name in code, scenes and configs. Mostly-alike code is compared with
            comments, strings and numbers left out. A dependency counts as used when it is imported or run from a script.
          </p>
        </>
      )}
    </section>
  );
}

const TRIGGER_TEXT: Record<BloatTrigger, string> = {
  manual: '',
  merge: 'after new commits ',
  daily: 'as the daily check ',
};

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

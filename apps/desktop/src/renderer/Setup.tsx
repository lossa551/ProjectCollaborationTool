import { useEffect, useState } from 'react';
import { ENGINE_LABELS, Engine, todo, type SetupItem, type SetupItemId } from '@pct/shared';
import type { AppState, SetupOutcome, SetupPlan } from '../common/api';
import { formatTokens } from '../common/folder-notes';
import { draftProblem } from './GitHub';

// Project setup (#46), the "Add project" wizard. Make the project with the
// engine first; this screen then looks at the folder, shows the preset for
// its engine item by item (each with the file it writes), has an agent draft
// the first folder notes, and commits it all as one commit. Running it again
// shows only what is missing or out of date.

const STATE_LABELS: Record<SetupItem['state'], string> = {
  missing: 'New',
  drifted: 'Update',
  done: 'Done',
  unavailable: 'Needs Git LFS',
};

export function SetupScreen({ state, onDone }: { state: AppState; onDone: () => void }) {
  const local = state.workspace;
  const [engine, setEngine] = useState<Engine | null>(null);
  const [plan, setPlan] = useState<SetupPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<SetupItemId>>(new Set());
  const [folders, setFolders] = useState<Set<string>>(new Set());
  const [agentId, setAgentId] = useState<string | null>(null);
  const [keepNotes, setKeepNotes] = useState(true);
  const [commit, setCommit] = useState(true);
  const [open, setOpen] = useState<SetupItemId | null>(null);
  const [outcome, setOutcome] = useState<SetupOutcome | null>(null);

  const usable = state.session.agents.filter((a) => draftProblem(a, state) === null);
  const agent = usable.find((a) => a.id === agentId) ?? usable.find((a) => a.id === state.notesAgent) ?? usable[0] ?? null;

  const load = async (pick: Engine | null) => {
    const result = await window.pct.readSetup(pick);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setPlan(result.value);
    // Everything that can be done starts ticked.
    setChosen(new Set(todo(result.value.items).map((i) => i.id)));
    setFolders(new Set(result.value.noteFolders.map((f) => f.path)));
  };
  useEffect(() => {
    if (local?.folder) void load(engine);
  }, [local?.folder, engine]);

  if (!local) {
    return (
      <section className="card">
        <h2>Set up project</h2>
        <p className="muted">Choose your project folder at the bottom left first. Make the project with its engine before that, then set it up here.</p>
      </section>
    );
  }

  const running = state.setupProgress;
  const items = plan?.items ?? [];
  const left = todo(items);
  const notes = agent ? [...folders] : [];
  const nothing = left.every((i) => !chosen.has(i.id)) && notes.length === 0;
  const toggle = <T,>(set: Set<T>, value: T, update: (next: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    update(next);
  };

  const run = async () => {
    if (!plan) return;
    setOutcome(null);
    setError(null);
    const result = await window.pct.runSetup({
      engine: plan.engine,
      items: left.filter((i) => chosen.has(i.id)).map((i) => i.id),
      notesAgent: agent?.id ?? null,
      noteFolders: notes,
      keepNotes: keepNotes && !!agent,
      commit,
    });
    if (result.ok) setOutcome(result.value);
    else setError(result.error);
    await load(plan.engine);
  };

  const detected = plan?.detected;
  return (
    <div className="setup-screen">
      <header className="screen-header">
        <div>
          <h1>Set up project</h1>
          <p className="muted">
            Make the project with its engine (the Unreal launcher, Godot or the <code>summer</code> CLI) first. Setup then adds what working on it
            together needs, and commits it as one commit you can review and undo.
          </p>
        </div>
      </header>

      <section className="card">
        <h2>Project</h2>
        {detected ? (
          <p>
            {detected.engine === 'generic' ? (
              <>No game engine project found in <code>{plan.root}</code>.</>
            ) : (
              <>
                Found {detected.name ? <strong>{detected.name}</strong> : 'a project'}: {ENGINE_LABELS[detected.engine]}
                {detected.version ? ` ${detected.version}` : ''} <span className="muted">({detected.marker})</span>
              </>
            )}
          </p>
        ) : (
          !error && <p className="muted">Reading {local.folder}…</p>
        )}
        <label className="field setup-engine">
          <span className="muted small">Preset</span>
          <select value={plan?.engine ?? ''} disabled={!plan || !!running} onChange={(e) => setEngine(Engine.parse(e.target.value))}>
            {Engine.options.map((e) => (
              <option key={e} value={e}>
                {ENGINE_LABELS[e]}
                {detected?.engine === e ? ' (detected)' : ''}
              </option>
            ))}
          </select>
        </label>
        {plan?.engine === 'godot' && <p className="muted small">A Summer Engine project looks like a Godot one: pick Summer Engine if it is one.</p>}
        {plan?.firstCommit && <p className="muted small">This repository has no commit yet. Setup makes the first one.</p>}
        {plan?.reminders.map((r) => (
          <p key={r} className="warning small">
            {r}
          </p>
        ))}
      </section>

      {plan && (
        <section className="card">
          <h2>
            Preset <span className="muted">{left.length === 0 ? 'everything is set up' : `${left.length} of ${items.length} to do`}</span>
          </h2>
          <ul className="setup-items">
            {items.map((item) => {
              const can = item.state === 'missing' || item.state === 'drifted';
              return (
                <li key={item.id} className={`setup-item setup-${item.state}`}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={can && chosen.has(item.id)}
                      disabled={!can || !!running}
                      onChange={() => toggle(chosen, item.id, setChosen)}
                    />
                    <span className="grow">
                      <strong>{item.label}</strong> <span className={`badge setup-badge-${item.state}`}>{STATE_LABELS[item.state]}</span>
                      <br />
                      <span className="muted small">
                        {item.file ? <code>{item.file}</code> : 'Session lock rules'} · {item.detail}
                      </span>
                    </span>
                  </label>
                  {item.preview && (
                    <button className="link small" onClick={() => setOpen(open === item.id ? null : item.id)}>
                      {open === item.id ? 'Hide' : can ? 'Show what is added' : 'Show'}
                    </button>
                  )}
                  {open === item.id && <pre className="fn-prompt setup-preview">{item.preview}</pre>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {plan && (
        <section className="card">
          <h2>Folder notes</h2>
          <p className="muted small">
            An agent drafts a short <code>AGENTS.md</code> for each main folder, so other agents read less to find their way. The drafts go into the
            setup commit for you to review. Nobody writes notes by hand.
          </p>
          {usable.length === 0 ? (
            <p className="muted">{state.session.agents.length === 0 ? 'Add an agent in Settings to have it draft the notes.' : 'None of the agents can run on this PC.'}</p>
          ) : (
            <>
              <label className="field">
                <span className="muted small">Agent</span>
                <select value={agent?.id ?? ''} disabled={!!running} onChange={(e) => setAgentId(e.target.value)}>
                  {usable.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              {plan.noteFolders.length === 0 ? (
                <p className="muted small">
                  {plan.firstCommit ? 'Folders are offered once the project has a commit; run setup again after this one.' : 'No big folder is missing a note.'}
                </p>
              ) : (
                <ul className="setup-folders">
                  {plan.noteFolders.map((f) => (
                    <li key={f.path}>
                      <label className="check">
                        <input type="checkbox" checked={folders.has(f.path)} disabled={!!running} onChange={() => toggle(folders, f.path, setFolders)} />
                        <code>{f.path}/</code>
                        <span className="muted small">
                          {f.files} files, {formatTokens(f.tokens)} tokens
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <label className="check">
                <input type="checkbox" checked={keepNotes} disabled={!!running} onChange={(e) => setKeepNotes(e.target.checked)} />
                Keep notes up to date: when a note goes stale or a big folder has none, {agent?.name ?? 'the agent'} drafts it and you review it on the
                Folder notes tab
              </label>
            </>
          )}
        </section>
      )}

      {plan && (
        <section className="card">
          <label className="check">
            <input type="checkbox" checked={commit} disabled={!!running} onChange={(e) => setCommit(e.target.checked)} />
            Commit it all as one commit, "Set up project for collab tool" (other changes you have are left out of it)
          </label>
          {running ? (
            <div className="setup-running">
              <span className="grow">
                {running.step}… <span className="muted small">step {running.done + 1} of {running.total}</span>
              </span>
              <button className="secondary" onClick={() => window.pct.cancelSetup()}>
                Stop
              </button>
            </div>
          ) : (
            <div className="row">
              <button disabled={nothing} onClick={() => void run()}>
                {left.length === 0 && notes.length === 0 ? 'Nothing to do' : 'Set up project'}
              </button>
              <button className="secondary" onClick={onDone}>
                Back to Home
              </button>
            </div>
          )}
          {error && <p className="error small">{error}</p>}
          {outcome && <OutcomeNote outcome={outcome} committed={commit} />}
        </section>
      )}
      {!plan && error && <p className="error">{error}</p>}
    </div>
  );
}

function OutcomeNote({ outcome, committed }: { outcome: SetupOutcome; committed: boolean }) {
  return (
    <div className="setup-outcome">
      <p className="good">
        {outcome.written.length === 0
          ? 'Nothing needed changing.'
          : outcome.commit
            ? `Committed ${outcome.written.length} ${outcome.written.length === 1 ? 'file' : 'files'} as ${outcome.commit}. Review it on Code > GitHub, and push to share it.`
            : `Wrote ${outcome.written.length} ${outcome.written.length === 1 ? 'file' : 'files'}${committed ? '' : '; commit them from Code > GitHub'}.`}
      </p>
      {outcome.written.length > 0 && (
        <ul className="fn-paths">
          {outcome.written.map((p) => (
            <li key={p}>
              <code>{p}</code>
            </li>
          ))}
        </ul>
      )}
      {outcome.failedNotes.map((f) => (
        <p key={f.folder} className="warning small">
          No note for {f.folder}/: {f.error}
        </p>
      ))}
    </div>
  );
}

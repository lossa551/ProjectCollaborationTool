import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  CRITERION_STATE_LABELS,
  FEATURE_STATE_LABELS,
  PLAN_KIND_LABELS,
  PLAN_TEXT_LIMIT,
  PlanKind,
  STAGE_LABELS,
  TaskStage,
  featureDependencies,
  featureStatus,
  planLines,
  plannedTasks,
  renderPlan,
  type FeatureStatus,
  type PlanItem,
  type PlanTextField,
  type Task,
} from '@pct/shared';
import type { AppState } from '../common/api';
import { LiveText } from './LiveText';

// Screen 4: the planning space. Features, ideas and notes that everyone edits
// live. A feature is written up together, then approved: that creates its
// tasks on the board, and from then on the feature follows its tasks through
// implementation, review and testing to done.

const SECTIONS: { kind: PlanKind; title: string; empty: string }[] = [
  { kind: 'feature', title: 'Features', empty: 'No features yet.' },
  { kind: 'idea', title: 'Ideas', empty: 'No ideas yet.' },
  { kind: 'note', title: 'Notes', empty: 'No notes yet.' },
];

export function PlanningScreen({
  state,
  onOpenTask,
  onOpenChat,
}: {
  state: AppState;
  onOpenTask: (taskId: string) => void;
  onOpenChat: (chatId: string) => void;
}) {
  const { session } = state;
  const items = session.planning;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const editable = state.canEditTasks;

  // Something to look at straight away: the most recently changed item.
  useEffect(() => {
    if (!selected && items.length > 0) setSelectedId([...items].sort((a, b) => b.updatedAt - a.updatedAt)[0]!.id);
  }, [selected, items]);

  return (
    <div className="planning-screen">
      <aside className="plan-list">
        <NewItem editable={editable} onCreated={setSelectedId} />
        {SECTIONS.map((section) => {
          const own = items.filter((i) => i.kind === section.kind);
          return (
            <section key={section.kind}>
              <h3 className="section-title">{section.title}</h3>
              {own.length === 0 && <p className="muted small">{section.empty}</p>}
              <ul>
                {own.map((item) => (
                  <li key={item.id}>
                    <button className={item.id === selectedId ? 'plan-item active' : 'plan-item'} onClick={() => setSelectedId(item.id)}>
                      <span className="plan-item-title">{item.title}</span>
                      {item.kind === 'feature' && <FeatureBadge status={featureStatus(item, items, session.tasks)} />}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </aside>
      {selected ? (
        <PlanEditor key={selected.id} item={selected} state={state} onOpenTask={onOpenTask} onOpenChat={onOpenChat} onDeleted={() => setSelectedId(null)} />
      ) : (
        <section className="plan-editor card">
          <h1>Planning space</h1>
          <p className="muted">
            Write up features together before anyone builds them: what and why, requirements, what it depends on, how you will know it
            works, and the tasks it takes. Both of you can type in the same feature at once. Approving a feature puts its tasks on the
            board.
          </p>
        </section>
      )}
    </div>
  );
}

function NewItem({ editable, onCreated }: { editable: boolean; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<PlanKind>('feature');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    const id = crypto.randomUUID();
    window.pct.editPlanning({ op: 'create', id, kind, title: title.trim() });
    setTitle('');
    onCreated(id);
  };
  return (
    <form className="plan-new" onSubmit={submit}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New feature, idea or note" maxLength={200} disabled={!editable} />
      <div className="row tight">
        <select value={kind} onChange={(e) => setKind(e.target.value as PlanKind)} disabled={!editable}>
          {PlanKind.options.map((k) => (
            <option key={k} value={k}>
              {PLAN_KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <button type="submit" disabled={!editable || !title.trim()}>
          Add
        </button>
      </div>
    </form>
  );
}

export function FeatureBadge({ status }: { status: FeatureStatus }) {
  return (
    <span className={`feature-badge feature-${status.state}`} title={status.reason ?? undefined}>
      {FEATURE_STATE_LABELS[status.state]}
    </span>
  );
}

const FIELDS: { field: PlanTextField; label: string; hint: string; rows: number; featureOnly: boolean }[] = [
  { field: 'body', label: 'Description', hint: 'What it is and why it matters.', rows: 6, featureOnly: false },
  { field: 'requirements', label: 'Requirements', hint: 'One per line.', rows: 4, featureOnly: true },
  { field: 'dependencies', label: 'Dependencies', hint: 'One per line. Name another feature to link it; shared systems or assets it relies on.', rows: 3, featureOnly: true },
  { field: 'criteria', label: 'Acceptance criteria', hint: 'One per line: how you will know it works. They go onto the tasks with a test result each.', rows: 4, featureOnly: true },
  {
    field: 'tasks',
    label: 'Implementation tasks',
    hint: 'One per line. Add "|" and paths to set what a task may change, e.g. Movement script | scripts/player/**',
    rows: 4,
    featureOnly: true,
  },
];

function PlanEditor({
  item,
  state,
  onOpenTask,
  onOpenChat,
  onDeleted,
}: {
  item: PlanItem;
  state: AppState;
  onOpenTask: (taskId: string) => void;
  onOpenChat: (chatId: string) => void;
  onDeleted: () => void;
}) {
  const { session } = state;
  const editable = state.canEditTasks;
  const [title, setTitle] = useState(item.title);
  useEffect(() => setTitle(item.title), [item.title]);
  const [approving, setApproving] = useState(false);
  const isFeature = item.kind === 'feature';
  const status = isFeature ? featureStatus(item, session.planning, session.tasks) : null;
  const linked = featureDependencies(item, session.planning);

  const saveTitle = () => {
    const next = title.trim();
    if (next && next !== item.title) window.pct.editPlanning({ op: 'set', id: item.id, title: next });
    else setTitle(item.title);
  };
  const editText = (field: PlanTextField) => (value: string, base: string) =>
    window.pct.editPlanning({ op: 'text', id: item.id, field, value, base });

  return (
    <section className="plan-editor">
      <header className="plan-head">
        <input
          className="plan-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          disabled={!editable}
          maxLength={200}
        />
        <select value={item.kind} onChange={(e) => window.pct.editPlanning({ op: 'set', id: item.id, kind: e.target.value as PlanKind })} disabled={!editable}>
          {PlanKind.options.map((k) => (
            <option key={k} value={k}>
              {PLAN_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </header>
      <p className="muted small">
        Added by {item.createdBy} · changed {new Date(item.updatedAt).toLocaleString()}
        {item.approvedAt && ` · plan approved by ${item.approvedBy}`}
      </p>

      {status && <StageTracker status={status} />}
      {status && <FeatureTasks tasks={status.tasks} onOpenTask={onOpenTask} />}

      {FIELDS.filter((f) => isFeature || !f.featureOnly).map((f) => (
        <label key={f.field} className="field">
          <span>
            {f.label} <span className="muted">· {f.hint}</span>
          </span>
          <LiveText value={item[f.field]} applied={state.textEdits} onEdit={editText(f.field)} rows={f.rows} disabled={!editable} maxLength={PLAN_TEXT_LIMIT} spellCheck={f.field !== 'tasks'} />
          {f.field === 'dependencies' && linked.length > 0 && (
            <span className="small">
              Linked:{' '}
              {linked.map((dep, i) => (
                <span key={dep.id}>
                  {i > 0 && ', '}
                  {dep.title} <FeatureBadge status={featureStatus(dep, session.planning, session.tasks)} />
                </span>
              ))}
            </span>
          )}
        </label>
      ))}

      {!isFeature && (
        <button className="secondary" disabled={!editable} onClick={() => window.pct.editPlanning({ op: 'set', id: item.id, kind: 'feature' })}>
          Turn into a feature
        </button>
      )}

      {status && (
        <>
          {approving ? (
            <ApproveForm item={item} existing={status.tasks} onDone={() => setApproving(false)} />
          ) : (
            <div className="row">
              <button disabled={!editable || plannedTasks(item.tasks).length === 0} onClick={() => setApproving(true)}>
                {item.approvedAt ? 'Create tasks for new lines' : 'Approve plan and create tasks'}
              </button>
              {plannedTasks(item.tasks).length === 0 && <span className="muted small">Write the implementation tasks first.</span>}
            </div>
          )}
          <DiscussWithAgent item={item} state={state} onOpenChat={onOpenChat} />
        </>
      )}

      <button
        className="danger"
        disabled={!editable}
        onClick={() => {
          if (!confirm(`Delete "${item.title}" for everyone? Its tasks stay on the board.`)) return;
          window.pct.editPlanning({ op: 'delete', id: item.id });
          onDeleted();
        }}
      >
        Delete
      </button>
    </section>
  );
}

function StageTracker({ status }: { status: FeatureStatus }) {
  const order = TaskStage.options;
  const at = order.indexOf(status.stage);
  return (
    <div className="stage-tracker">
      <ol>
        {order.map((stage, i) => (
          <li key={stage} className={i < at || (i === at && status.state === 'ready') ? 'done' : i === at ? 'current' : undefined}>
            {STAGE_LABELS[stage]}
          </li>
        ))}
      </ol>
      <p className="small">
        {status.state !== 'planning' && <FeatureBadge status={status} />}
        {status.reason && <span className="muted"> {status.reason}</span>}
        {status.tasks.length > 0 && (
          <span className="muted">
            {' '}
            · {status.verified} verified, {status.failing} failing, {status.untested} not tested
          </span>
        )}
      </p>
    </div>
  );
}

function FeatureTasks({ tasks, onOpenTask }: { tasks: Task[]; onOpenTask: (taskId: string) => void }) {
  if (tasks.length === 0) return null;
  return (
    <section>
      <h3 className="section-title">Tasks</h3>
      <ul className="feature-tasks">
        {tasks.map((t) => (
          <li key={t.id}>
            <button className="link" onClick={() => onOpenTask(t.id)}>
              {t.title}
            </button>
            <span className="muted small">
              {STAGE_LABELS[t.stage]}
              {t.owner && ` · ${t.owner.name}`}
            </span>
            <CriteriaSummary task={t} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CriteriaSummary({ task }: { task: Task }) {
  if (task.criteria.length === 0) return null;
  const failing = task.criteria.filter((c) => c.state === 'failing').length;
  const verified = task.criteria.filter((c) => c.state === 'verified').length;
  const title = task.criteria.map((c) => `${CRITERION_STATE_LABELS[c.state]}: ${c.text}`).join('\n');
  if (failing > 0) {
    return (
      <span className="bad small" title={title}>
        {failing} failing
      </span>
    );
  }
  return (
    <span className={verified === task.criteria.length ? 'good small' : 'muted small'} title={title}>
      {verified}/{task.criteria.length} verified
    </span>
  );
}

/** Picks which tasks to create and which task each acceptance criterion goes to. */
function ApproveForm({ item, existing, onDone }: { item: PlanItem; existing: Task[]; onDone: () => void }) {
  const taken = new Set(existing.map((t) => t.title.trim().toLowerCase()));
  const planned = useMemo(() => plannedTasks(item.tasks).filter((t) => !taken.has(t.title.toLowerCase())), [item.tasks]);
  const criteria = useMemo(() => planLines(item.criteria), [item.criteria]);
  const [chosen, setChosen] = useState(() => planned.map(() => true));
  // Criteria go to the last task by default: usually the one that brings the pieces together.
  const [target, setTarget] = useState(() => criteria.map(() => Math.max(planned.length - 1, 0)));
  const [error, setError] = useState<string | null>(null);

  if (planned.length === 0) {
    return (
      <div className="approve-form card">
        <p className="muted">Every task line already has a task. Add lines to create more.</p>
        <button className="secondary" onClick={onDone}>
          Close
        </button>
      </div>
    );
  }

  const submit = async () => {
    const tasks = planned.flatMap((t, i) =>
      chosen[i] ? [{ title: t.title, scope: t.scope, criteria: criteria.filter((_, c) => target[c] === i) }] : [],
    );
    const result = await window.pct.approvePlan({ featureId: item.id, tasks });
    if (result.ok) onDone();
    else setError(result.error);
  };

  return (
    <div className="approve-form card">
      <h3>Create tasks</h3>
      <ul className="approve-list">
        {planned.map((t, i) => (
          <li key={i}>
            <label className="check">
              <input type="checkbox" checked={chosen[i]} onChange={(e) => setChosen(chosen.map((c, j) => (j === i ? e.target.checked : c)))} />
              {t.title}
            </label>
            {t.scope.length > 0 && <span className="muted small"> · {t.scope.join(', ')}</span>}
          </li>
        ))}
      </ul>
      {criteria.length > 0 && (
        <>
          <h3>Acceptance criteria go to</h3>
          <ul className="approve-list">
            {criteria.map((c, i) => (
              <li key={i} className="approve-criterion">
                <span className="grow">{c}</span>
                <select value={target[i]} onChange={(e) => setTarget(target.map((t, j) => (j === i ? Number(e.target.value) : t)))}>
                  {planned.map((t, j) => (
                    <option key={j} value={j} disabled={!chosen[j]}>
                      {t.title}
                    </option>
                  ))}
                  <option value={-1}>No task</option>
                </select>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p className="error small">{error}</p>}
      <div className="row">
        <button disabled={!chosen.some(Boolean)} onClick={() => void submit()}>
          Create {chosen.filter(Boolean).length} {chosen.filter(Boolean).length === 1 ? 'task' : 'tasks'}
        </button>
        <button className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Starts an agent chat that has the whole plan, to refine it or break it down. */
function DiscussWithAgent({ item, state, onOpenChat }: { item: PlanItem; state: AppState; onOpenChat: (chatId: string) => void }) {
  const { agents, status } = state.session;
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  if (agents.length === 0) return null;

  const start = async () => {
    setError(null);
    const result = await window.pct.handOff({
      fromChatId: null,
      taskId: null,
      agentId,
      title: `Plan: ${item.title}`.slice(0, 200),
      handoff: {
        stage: null,
        plan: renderPlan(item).slice(0, 20000),
        decisions: [],
        criteria: planLines(item.criteria).slice(0, 50).map((c) => c.slice(0, 1000)),
        scope: [],
        notes: 'This is a plan in the planning space. Help refine it: point out gaps, risks and missing acceptance criteria, and suggest how to split it into tasks.',
      },
    });
    if (result.ok) onOpenChat(result.value);
    else setError(result.error);
  };

  return (
    <div className="row discuss">
      <span className="muted small">Discuss this plan with</span>
      <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <button className="secondary" disabled={status !== 'connected' || !agentId} onClick={() => void start()}>
        Start chat
      </button>
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

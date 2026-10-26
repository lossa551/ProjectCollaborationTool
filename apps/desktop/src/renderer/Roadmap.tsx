import { useMemo, useState, type DragEvent, type FormEvent } from 'react';
import {
  AssignStage,
  FEATURE_STATE_LABELS,
  STAGE_LABELS,
  TaskStage,
  describeDaysLeft,
  featureDependencies,
  featureStage,
  moveFeature,
  plannedTasks,
  renderPlan,
  roadmap,
  type Assignee,
  type FeatureState,
  type Milestone,
  type RoadmapFeature,
  type RoadmapLane,
} from '@pct/shared';
import type { AppState } from '../common/api';
import { PullBadge } from './GitHub';
import { ApproveForm, FeatureBadge } from './Planning';

// The Roadmap view (issue #42), the first view of the Planning screen: one
// lane per milestone, features in priority order, and how far each one is
// without opening it. Drag a feature to reorder it or move it to another
// milestone. Approving a plan, picking who does each stage and starting an
// agent on the next task all happen here, without going to the board.

/** The stage pipeline as it reads on a roadmap row. */
const PIPELINE: { stage: TaskStage; label: string }[] = [
  { stage: 'planning', label: 'Plan' },
  { stage: 'implementing', label: 'Build' },
  { stage: 'review', label: 'Review' },
  { stage: 'testing', label: 'Test' },
  { stage: 'done', label: 'Done' },
];

const PIPELINE_LABEL = Object.fromEntries(PIPELINE.map((p) => [p.stage, p.label])) as Record<TaskStage, string>;

interface Drop {
  milestoneId: string;
  /** Insert before this feature; null is the end of the lane. */
  beforeId: string | null;
}

export function RoadmapView({
  state,
  filter,
  onOpenFeature,
  onOpenTask,
  onOpenChat,
}: {
  state: AppState;
  /** Only show features in this state (from the counts on Home). */
  filter: FeatureState | null;
  onOpenFeature: (id: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenChat: (chatId: string) => void;
}) {
  const { session } = state;
  const editable = state.canEditTasks;
  const lanes = useMemo(() => roadmap(session), [session.planning, session.milestones, session.tasks, session.github, session.chats, session.agents]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const finishDrop = (event: DragEvent) => {
    event.preventDefault();
    const id = dragging ?? event.dataTransfer.getData('text/plain');
    if (id && drop && id !== drop.beforeId) {
      window.pct.editPlanning(moveFeature(session.planning, session.milestones, id, drop.milestoneId, drop.beforeId));
    }
    setDragging(null);
    setDrop(null);
  };

  return (
    <div className="roadmap" onDragEnd={() => (setDragging(null), setDrop(null))}>
      {lanes.map((lane, index) => {
        const shown = lane.features.filter((f) => !filter || f.status.state === filter);
        return (
          <section
            key={lane.milestone.id}
            className={`roadmap-lane card${drop?.milestoneId === lane.milestone.id && drop.beforeId === null ? ' drop-end' : ''}`}
            onDragOver={(e) => {
              if (!editable || !dragging) return;
              e.preventDefault();
              if (drop?.milestoneId !== lane.milestone.id || drop.beforeId !== null) setDrop({ milestoneId: lane.milestone.id, beforeId: null });
            }}
            onDrop={finishDrop}
          >
            <MilestoneHeader lane={lane} index={index} milestones={session.milestones} editable={editable} />
            {shown.length === 0 ? (
              <p className="muted small roadmap-empty">
                {lane.features.length > 0 ? `No ${FEATURE_STATE_LABELS[filter!].toLowerCase()} features here.` : 'No features yet. Drag one here or add one below.'}
              </p>
            ) : (
              <ol className="roadmap-rows">
                {shown.map((feature, i) => (
                  <FeatureRow
                    key={feature.item.id}
                    feature={feature}
                    lane={lane}
                    state={state}
                    open={open === feature.item.id}
                    onToggle={() => setOpen(open === feature.item.id ? null : feature.item.id)}
                    dropBefore={drop?.milestoneId === lane.milestone.id && drop.beforeId === feature.item.id}
                    dragging={dragging === feature.item.id}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', feature.item.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDragging(feature.item.id);
                    }}
                    onDragOver={(e) => {
                      if (!editable || !dragging) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const box = e.currentTarget.getBoundingClientRect();
                      const before = e.clientY < box.top + box.height / 2 ? feature.item.id : (shown[i + 1]?.item.id ?? null);
                      if (drop?.milestoneId !== lane.milestone.id || drop.beforeId !== before) setDrop({ milestoneId: lane.milestone.id, beforeId: before });
                    }}
                    onOpenFeature={onOpenFeature}
                    onOpenTask={onOpenTask}
                    onOpenChat={onOpenChat}
                  />
                ))}
              </ol>
            )}
            <AddFeature milestone={lane.milestone} state={state} />
          </section>
        );
      })}
      <AddMilestone editable={editable} count={session.milestones.length} />
    </div>
  );
}

/** Title, goal, target date and order of a milestone, with its progress. */
function MilestoneHeader({ lane, index, milestones, editable }: { lane: RoadmapLane; index: number; milestones: Milestone[]; editable: boolean }) {
  const { milestone } = lane;
  const total = lane.features.length;
  const edit = (changes: { title?: string; goal?: string; target?: string | null }) => window.pct.editPlanning({ op: 'milestone', id: milestone.id, ...changes });
  // Orders can be equal or far apart; renumber them all so the swap always shows.
  const swap = (other: number) => {
    const ids = milestones.map((m) => m.id);
    [ids[index], ids[other]] = [ids[other]!, ids[index]!];
    ids.forEach((id, order) => window.pct.editPlanning({ op: 'milestone', id, order }));
  };
  return (
    <header className="milestone-head">
      <div className="milestone-title">
        <TextOnBlur className="milestone-name" value={milestone.title} maxLength={100} disabled={!editable} onSave={(title) => title && edit({ title })} />
        <TextOnBlur
          className="milestone-goal"
          value={milestone.goal}
          placeholder="Goal, in one line"
          maxLength={300}
          disabled={!editable}
          onSave={(goal) => edit({ goal })}
        />
        <input
          type="date"
          className="milestone-date"
          value={milestone.target ?? ''}
          disabled={!editable}
          title="Target date"
          onChange={(e) => edit({ target: e.target.value || null })}
        />
        <div className="milestone-tools">
          <button className="link" disabled={!editable || index === 0} onClick={() => swap(index - 1)} title="Move milestone up" aria-label="Move milestone up">
            ▲
          </button>
          <button
            className="link"
            disabled={!editable || index === milestones.length - 1}
            onClick={() => swap(index + 1)}
            title="Move milestone down"
            aria-label="Move milestone down"
          >
            ▼
          </button>
          <button
            className="link"
            disabled={!editable || milestones.length <= 1}
            title="Delete milestone"
            aria-label="Delete milestone"
            onClick={() => {
              const to = milestones.find((m) => m.id !== milestone.id)!;
              if (!confirm(`Delete the milestone "${milestone.title}" for everyone?${total > 0 ? ` Its ${total} features move to "${to.title}".` : ''}`)) return;
              window.pct.editPlanning({ op: 'milestone-delete', id: milestone.id });
            }}
          >
            ✕
          </button>
        </div>
      </div>
      {total > 0 && (
        <div className="milestone-progress">
          <div className="progress" title={`${lane.done} of ${total} features done`}>
            <span style={{ width: `${(lane.done / total) * 100}%` }} />
          </div>
          <span className="small">
            {lane.done} of {total} done
            {lane.blocked > 0 && <span className="bad"> · {lane.blocked} blocked</span>}
            {lane.unverified > 0 && <span className="warning"> · {lane.unverified} not verified</span>}
            {lane.daysLeft !== null && <span className="muted"> · {describeDaysLeft(lane.daysLeft)}</span>}
          </span>
          <RiskBadge lane={lane} />
        </div>
      )}
    </header>
  );
}

export function RiskBadge({ lane }: { lane: Pick<RoadmapLane, 'risk' | 'blocked'> }) {
  if (!lane.risk) return null;
  return lane.risk === 'overdue' ? (
    <span className="feature-badge feature-blocked">Overdue</span>
  ) : (
    <span className="feature-badge feature-unverified" title={`${lane.blocked} blocked close to the target date`}>
      At risk
    </span>
  );
}

function FeatureRow({
  feature,
  lane,
  state,
  open,
  onToggle,
  dropBefore,
  dragging,
  onDragStart,
  onDragOver,
  onOpenFeature,
  onOpenTask,
  onOpenChat,
}: {
  feature: RoadmapFeature;
  lane: RoadmapLane;
  state: AppState;
  open: boolean;
  onToggle: () => void;
  dropBefore: boolean;
  dragging: boolean;
  onDragStart: (e: DragEvent<HTMLLIElement>) => void;
  onDragOver: (e: DragEvent<HTMLLIElement>) => void;
  onOpenFeature: (id: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenChat: (chatId: string) => void;
}) {
  const { session } = state;
  const editable = state.canEditTasks;
  const { item, status } = feature;
  const deps = featureDependencies(item, session.planning);
  const planned = plannedTasks(item.tasks).length;
  const [approving, setApproving] = useState(false);
  const nextAgent = feature.next ? item.assign[feature.next.stage] : undefined;
  const startable = feature.next && nextAgent?.kind === 'agent' && session.agents.some((a) => a.id === nextAgent.id) ? nextAgent : null;
  const [error, setError] = useState<string | null>(null);

  const start = async (agentId: string) => {
    if (!feature.next) return;
    setError(null);
    const result = await startOnTask(feature, agentId);
    if (result.ok) onOpenChat(result.value);
    else setError(result.error);
  };

  const classes = ['roadmap-row', dropBefore && 'drop-before', dragging && 'dragging', open && 'open'].filter(Boolean).join(' ');
  return (
    <li className={classes} draggable={editable} onDragStart={onDragStart} onDragOver={onDragOver}>
      <div className="roadmap-line">
        <span className="drag-handle" title={editable ? 'Drag to reorder or move to another milestone' : undefined} aria-hidden>
          ⠿
        </span>
        <div className="roadmap-name">
          <button className="link" onClick={() => onOpenFeature(item.id)} title="Open the feature">
            {item.title}
          </button>
          {deps.length > 0 && (
            <span className="small">
              {deps.map((dep, i) => {
                const waiting = status.waitingOn.some((w) => w.id === dep.id);
                return (
                  <span key={dep.id} className={waiting ? 'bad' : 'muted'}>
                    {i === 0 ? (waiting ? '⚠ Waits for ' : 'After ') : ', '}
                    {dep.title}
                    {!waiting && featureStage(dep, session.tasks) === 'done' && ' ✓'}
                  </span>
                );
              })}
            </span>
          )}
        </div>
        <Pipeline feature={feature} />
        <span className="roadmap-count small" title="Tasks done">
          {status.tasks.length > 0 ? `${feature.tasksDone}/${status.tasks.length} tasks` : planned > 0 ? `${planned} planned` : 'No tasks'}
        </span>
        <span className={`roadmap-count small ${status.failing > 0 ? 'bad' : feature.criteria > 0 && status.verified === feature.criteria ? 'good' : 'muted'}`} title="Acceptance criteria verified">
          {feature.criteria > 0 ? `${status.verified}/${feature.criteria} verified` : ''}
        </span>
        <span className="roadmap-pulls">
          {feature.pulls.slice(0, 2).map((p) => (
            <PullBadge key={p.number} pull={p} />
          ))}
        </span>
        <span className="roadmap-who small">
          {feature.agents.map((a) => (
            <button key={a.chatId} className="link small" onClick={() => onOpenChat(a.chatId)} title="Open the agent's chat">
              {a.name} {a.state === 'waiting' ? 'waiting' : 'working'}
            </button>
          ))}
          {feature.owners
            .filter((o) => !feature.agents.some((a) => a.name === o.name))
            .map((o) => (
              <span key={o.id}>{o.name}</span>
            ))}
        </span>
        <span>{(status.state === 'blocked' || status.state === 'unverified' || status.state === 'ready') && <FeatureBadge status={status} />}</span>
        <div className="roadmap-act">
          {status.tasks.length === 0 && planned > 0 ? (
            <button
              className="small"
              disabled={!editable}
              onClick={() => {
                setApproving(true);
                if (!open) onToggle();
              }}
            >
              Approve plan
            </button>
          ) : startable ? (
            <button className="small" disabled={session.status !== 'connected'} onClick={() => void start(startable.id)} title={`Hand "${feature.next!.task.title}" to ${startable.name}`}>
              Start {startable.name}
            </button>
          ) : null}
          <button className="secondary small" onClick={onToggle} aria-expanded={open} title="Stages, next task and milestone">
            {open ? '▴' : '▾'}
          </button>
        </div>
      </div>
      {error && <p className="error small">{error}</p>}
      {open && (
        <FeatureActions
          feature={feature}
          lane={lane}
          state={state}
          approving={approving}
          onApproving={setApproving}
          onStart={start}
          onOpenTask={onOpenTask}
          onOpenFeature={onOpenFeature}
        />
      )}
    </li>
  );
}

function Pipeline({ feature }: { feature: RoadmapFeature }) {
  const { status } = feature;
  const at = TaskStage.options.indexOf(status.stage);
  const finished = status.state === 'ready';
  return (
    <ol className="pipeline" title={status.reason ?? FEATURE_STATE_LABELS[status.state]}>
      {PIPELINE.map((p, i) => (
        <li key={p.stage} className={i < at || (i === at && finished) ? 'done' : i === at ? `current ${status.state}` : undefined}>
          {p.label}
        </li>
      ))}
    </ol>
  );
}

/** Hands the feature's next open task to an agent, with the whole plan. */
function startOnTask(feature: RoadmapFeature, agentId: string) {
  const { task, stage } = feature.next!;
  return window.pct.handOff({
    fromChatId: null,
    taskId: task.id,
    agentId,
    handoff: {
      stage,
      plan: renderPlan(feature.item).slice(0, 20000),
      decisions: [],
      criteria: task.criteria.map((c) => c.text).slice(0, 50),
      scope: task.scope,
      readFirst: task.readFirst,
      notes: `Started from the roadmap. Work on the task "${task.title}" (${STAGE_LABELS[stage]}); the plan above is the whole feature.`,
    },
  });
}

/** Who does each stage, the next task, and where the feature sits. */
function FeatureActions({
  feature,
  lane,
  state,
  approving,
  onApproving,
  onStart,
  onOpenTask,
  onOpenFeature,
}: {
  feature: RoadmapFeature;
  lane: RoadmapLane;
  state: AppState;
  approving: boolean;
  onApproving: (on: boolean) => void;
  onStart: (agentId: string) => Promise<void>;
  onOpenTask: (taskId: string) => void;
  onOpenFeature: (id: string) => void;
}) {
  const { session } = state;
  const editable = state.canEditTasks;
  const { item, next } = feature;
  const people = session.participants.filter((p) => p.kind === 'human');
  const picked = next ? item.assign[next.stage] : undefined;
  const [agentId, setAgentId] = useState(picked?.kind === 'agent' ? picked.id : (session.agents[0]?.id ?? ''));
  const person = picked?.kind === 'human' ? people.find((p) => p.id === picked.id) : undefined;
  const ids = lane.features.map((f) => f.item.id);
  const at = ids.indexOf(item.id);
  const move = (milestoneId: string, beforeId: string | null) =>
    window.pct.editPlanning(moveFeature(session.planning, session.milestones, item.id, milestoneId, beforeId));

  const options = (stage: AssignStage) => {
    const current = item.assign[stage];
    const list: Assignee[] = [
      ...people.map((p) => ({ kind: 'human' as const, id: p.id, name: p.name })),
      ...session.agents.map((a) => ({ kind: 'agent' as const, id: a.id, name: a.name })),
    ];
    // Keep a pick that is offline or gone, so the select still shows it.
    if (current && !list.some((a) => a.kind === current.kind && a.id === current.id)) list.push(current);
    return list;
  };

  return (
    <div className="roadmap-more">
      <div className="stage-picks">
        {AssignStage.options.map((stage) => {
          const current = item.assign[stage];
          return (
            <label key={stage} className="field">
              <span className="small muted">{PIPELINE_LABEL[stage]}</span>
              <select
                value={current ? `${current.kind}:${current.id}` : ''}
                disabled={!editable}
                onChange={(e) => {
                  const who = options(stage).find((a) => `${a.kind}:${a.id}` === e.target.value) ?? null;
                  window.pct.editPlanning({ op: 'assign', id: item.id, stage, who });
                }}
              >
                <option value="">Anyone</option>
                {options(stage).map((a) => (
                  <option key={`${a.kind}:${a.id}`} value={`${a.kind}:${a.id}`}>
                    {a.name}
                    {a.kind === 'agent' ? ' (agent)' : ''}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>

      {next && (
        <div className="row roadmap-next">
          <span className="small">
            Next:{' '}
            <button className="link" onClick={() => onOpenTask(next.task.id)}>
              {next.task.title}
            </button>{' '}
            <span className="muted">· {STAGE_LABELS[next.stage]}</span>
          </span>
          {person && next.task.owner?.id !== person.id && (
            <button className="secondary small" disabled={!editable} onClick={() => window.pct.updateTask(next.task.id, { ownerId: person.id })}>
              Give to {person.name}
            </button>
          )}
          {session.agents.length > 0 && (
            <>
              <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                {session.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button className="small" disabled={session.status !== 'connected' || !agentId} onClick={() => void onStart(agentId)}>
                Start agent
              </button>
            </>
          )}
        </div>
      )}

      {approving && <ApproveForm item={item} existing={feature.status.tasks} onDone={() => onApproving(false)} />}

      <div className="row roadmap-place">
        <span className="small muted">Milestone</span>
        <select value={lane.milestone.id} disabled={!editable} onChange={(e) => move(e.target.value, null)}>
          {session.milestones.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}
            </option>
          ))}
        </select>
        <button className="secondary small" disabled={!editable || at <= 0} onClick={() => move(lane.milestone.id, ids[at - 1]!)}>
          Move up
        </button>
        <button className="secondary small" disabled={!editable || at === ids.length - 1} onClick={() => move(lane.milestone.id, ids[at + 2] ?? null)}>
          Move down
        </button>
        <span className="grow" />
        <button className="link small" onClick={() => onOpenFeature(item.id)}>
          Open feature
        </button>
      </div>
    </div>
  );
}

function AddFeature({ milestone, state }: { milestone: Milestone; state: AppState }) {
  const [title, setTitle] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    const id = crypto.randomUUID();
    window.pct.editPlanning({ op: 'create', id, kind: 'feature', title: title.trim() });
    window.pct.editPlanning(moveFeature(state.session.planning, state.session.milestones, id, milestone.id, null));
    setTitle('');
  };
  return (
    <form className="roadmap-add" onSubmit={submit}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`Add a feature to ${milestone.title}`} maxLength={200} disabled={!state.canEditTasks} />
    </form>
  );
}

function AddMilestone({ editable, count }: { editable: boolean; count: number }) {
  const [title, setTitle] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    window.pct.editPlanning({ op: 'milestone', id: crypto.randomUUID(), title: title.trim() });
    setTitle('');
  };
  return (
    <form className="roadmap-add-milestone row" onSubmit={submit}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New milestone, e.g. Demo build" maxLength={100} disabled={!editable || count >= 30} />
      <button type="submit" className="secondary" disabled={!editable || !title.trim()}>
        Add milestone
      </button>
    </form>
  );
}

/** A text field that saves when you leave it (or press Enter), not on every key. */
function TextOnBlur({
  value,
  onSave,
  ...props
}: { value: string; onSave: (value: string) => void; className?: string; placeholder?: string; maxLength?: number; disabled?: boolean }) {
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  const shown = editing ? text : value;
  return (
    <input
      {...props}
      value={shown}
      onFocus={() => (setText(value), setEditing(true))}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const next = text.trim();
        if (next !== value) onSave(next);
      }}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}

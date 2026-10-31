import {
  byDraftCost,
  cheapestAgent,
  describeConnection,
  draftCost,
  draftCostWarning,
  draftRows,
  dollars,
  onClaudePlan,
  totalUsage,
  usageDay,
  weekStart,
  type AgentProfile,
  type DraftKind,
} from '@pct/shared';
import type { AppState } from '../common/api';
import { CostShort } from './Cost';
import { draftProblem } from './GitHub';

// The notes agent (#94): it drafts folder notes by itself every 15 minutes
// while notes are stale, so it should be the cheapest model there is. The
// pickers list agents cheapest first and start on the cheapest; the notes
// agent's own cost is shown apart from its chats and commit drafts.

/** Agents that can draft from this PC, cheapest first. */
export function draftAgents(state: AppState): AgentProfile[] {
  return byDraftCost(
    state.session.agents.filter((a) => draftProblem(a, state) === null),
    state.session.prices,
  );
}

/** The agent a draft picker starts on: the cheapest that can run here. */
export const cheapestDraftAgent = (state: AppState) => cheapestAgent(draftAgents(state), state.session.prices);

/** e.g. "Notes · Claude · claude-haiku-5-5 · about $0.0015 per note (cheapest)". */
export function draftAgentLabel(agent: AgentProfile, state: AppState, cheapest: AgentProfile | undefined): string {
  const cost = draftCost(agent, state.session.prices);
  const price = onClaudePlan(agent.connection)
    ? 'on your Claude plan'
    : cost === null
      ? 'price unknown'
      : cost === 0
        ? 'free (local)'
        : `about ${dollars(cost)} per note`;
  return `${agent.name} · ${describeConnection(agent.connection)} · ${price}${agent.id === cheapest?.id ? ' (cheapest)' : ''}`;
}

/** Why the cheapest agent is the default, for under a picker. */
export const CHEAPEST_WHY =
  'It starts on the cheapest agent: notes are short and drafted by themselves all day, so a small model such as Haiku 5.5 or a local Ollama model does them well for a fraction of the cost.';

/** Today and this week for an agent's drafts of one kind. */
export function draftTotals(state: AppState, kind: DraftKind, agentId: string, now = Date.now()) {
  const { usage, prices } = state.session;
  const rows = draftRows(usage, kind, agentId);
  const today = usageDay(now);
  const monday = weekStart(now);
  return {
    today: totalUsage(rows.filter((r) => r.day === today), prices),
    week: totalUsage(rows.filter((r) => r.day >= monday), prices),
  };
}

/** "Today $0.01 · This week $0.07" for the notes agent's drafts. */
export function NotesSpend({ state, agent }: { state: AppState; agent: AgentProfile }) {
  const { today, week } = draftTotals(state, 'notes', agent.id);
  return (
    <span className="small notes-spend">
      Notes cost today <CostShort total={today} /> · this week <CostShort total={week} />
    </span>
  );
}

/** A warning when the notes agent is an expensive model. */
export function NotesCostWarning({ state, agent }: { state: AppState; agent: AgentProfile }) {
  const warning = draftCostWarning(agent, draftAgents(state), state.session.prices);
  return warning ? <p className="warning small">{warning}</p> : null;
}

/**
 * Settings, Agents: which agent keeps the folder notes up to date, with what
 * it costs. Off stops it drafting by itself.
 */
export function NotesAgentSettings({ state }: { state: AppState }) {
  const usable = draftAgents(state);
  const cheapest = usable[0];
  const current = state.session.agents.find((a) => a.id === state.notesAgent) ?? null;
  const choices = current && !usable.includes(current) ? [current, ...usable] : usable;
  if (!state.session.session || choices.length === 0) return null;
  return (
    <section className="card notes-agent">
      <h2>Folder notes agent</h2>
      <p className="muted small">
        Drafts a folder's <code>AGENTS.md</code> when it goes stale or a big folder has none, every 15 minutes, for you to review on the Folder
        notes tab. {CHEAPEST_WHY}
      </p>
      <div className="row">
        <select value={current?.id ?? ''} onChange={(e) => window.pct.setNotesAgent(e.target.value || null)}>
          <option value="">Off</option>
          {choices.map((a) => (
            <option key={a.id} value={a.id}>
              {draftAgentLabel(a, state, cheapest)}
            </option>
          ))}
        </select>
        {!current && cheapest && (
          <button className="secondary" onClick={() => window.pct.setNotesAgent(cheapest.id)}>
            Use {cheapest.name}
          </button>
        )}
      </div>
      {current && <NotesSpend state={state} agent={current} />}
      {current && <NotesCostWarning state={state} agent={current} />}
    </section>
  );
}

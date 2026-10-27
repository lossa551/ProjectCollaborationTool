import type { SessionState } from '@pct/shared';

// Closing the window while hosting, or while agents run on this PC, keeps the
// app running in the tray (issue #60). Quitting or stopping hosting asks first
// when someone or something would be cut off.

export interface CutOff {
  /** People connected to the session this PC hosts. */
  people: string[];
  /** Agents running on this PC that are in the middle of a turn. */
  agents: string[];
}

/**
 * Who stopping now would cut off: when hosting, everyone else connected; and
 * the agents on this PC that are working.
 */
export function whoWouldBeCutOff(session: SessionState, localAgentIds: string[], hosting: boolean): CutOff {
  const youId = session.you?.id ?? null;
  const people = hosting ? session.participants.filter((p) => p.kind === 'human' && p.id !== youId).map((p) => p.name) : [];
  const busy = session.chats.filter((c) => c.state === 'working' && localAgentIds.includes(c.agentId)).map((c) => c.agentId);
  const agents = busy.map((id) => session.agents.find((a) => a.id === id)?.name ?? 'An agent');
  return { people: [...new Set(people)], agents: [...new Set(agents)] };
}

const list = (names: string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** "Lina is connected and Builder is working.", or null when nobody would notice. */
export function cutOffSentence({ people, agents }: CutOff): string | null {
  const parts = [
    people.length > 0 ? `${list(people)} ${people.length === 1 ? 'is' : 'are'} connected` : null,
    agents.length > 0 ? `${list(agents)} ${agents.length === 1 ? 'is' : 'are'} working` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(' and ')}.` : null;
}

/** What the confirm box says before quitting, leaving or stopping hosting. */
export function stopConfirmDetail(cut: CutOff, hosting: boolean): string {
  const effects = [
    cut.people.length > 0 ? `${list(cut.people)} ${cut.people.length === 1 ? 'is' : 'are'} disconnected until you host again` : null,
    cut.agents.length > 0 ? `${cut.agents.length === 1 ? 'the agent stops' : 'the agents stop'} in the middle of ${cut.agents.length === 1 ? 'its' : 'their'} turn` : null,
  ].filter(Boolean);
  const keep = hosting ? ' To keep the session going, close the window instead: the app keeps running in the tray.' : '';
  return `If you stop now, ${effects.join(' and ')}.${keep}`;
}

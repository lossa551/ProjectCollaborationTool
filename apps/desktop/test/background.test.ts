import { describe, expect, it } from 'vitest';
import type { SessionState } from '@pct/shared';
import { cutOffSentence, stopConfirmDetail, whoWouldBeCutOff } from '../src/common/background';

const person = (id: string, name: string, kind: 'human' | 'agent' = 'human') => ({ id, name, kind, status: 'active', focus: null, connectedAt: 0, agent: null });

function session(chats: { agentId: string; state: 'idle' | 'working' | 'waiting' }[]): SessionState {
  return {
    you: person('me', 'Martin'),
    participants: [person('me', 'Martin'), person('lina', 'Lina'), person('bot', 'Builder', 'agent')],
    agents: [
      { id: 'builder', name: 'Builder' },
      { id: 'reviewer', name: 'Reviewer' },
    ],
    chats,
  } as unknown as SessionState;
}

describe('stopping while others depend on this PC', () => {
  it('names the friend and the working agents on this PC', () => {
    const state = session([
      { agentId: 'builder', state: 'working' },
      { agentId: 'reviewer', state: 'working' },
      { agentId: 'builder', state: 'idle' },
    ]);
    // Reviewer works on Lina's PC, so stopping here does not touch it.
    const cut = whoWouldBeCutOff(state, ['builder'], true);
    expect(cut).toEqual({ people: ['Lina'], agents: ['Builder'] });
    expect(cutOffSentence(cut)).toBe('Lina is connected and Builder is working.');
    expect(stopConfirmDetail(cut, true)).toMatch(/Lina is disconnected until you host again and the agent stops in the middle of its turn\. To keep the session going, close the window/);
  });

  it('leaves out people when only joined, and asks nothing when nobody would notice', () => {
    const idle = whoWouldBeCutOff(session([{ agentId: 'builder', state: 'waiting' }]), ['builder'], false);
    expect(idle).toEqual({ people: [], agents: [] });
    expect(cutOffSentence(idle)).toBeNull();
  });

  it('lists several names', () => {
    expect(cutOffSentence({ people: ['Lina', 'Sam'], agents: ['Builder', 'Tester', 'Reviewer'] })).toBe(
      'Lina and Sam are connected and Builder, Tester and Reviewer are working.',
    );
  });
});

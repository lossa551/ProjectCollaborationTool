import { describe, expect, it } from 'vitest';
import { Y, applyMemoryOp, applyPlanOp, featureStatus, planLines, plannedTasks, readMemory, readPlanning, renderMemory, setText, type Task } from '@pct/shared';

const task = (id: string, featureId: string | null, stage: Task['stage'], states: Task['criteria'][number]['state'][] = []): Task => ({
  id,
  title: id,
  stage,
  owner: null,
  scope: [],
  readFirst: [],
  branch: null,
  featureId,
  criteria: states.map((state, i) => ({ id: `${id}-${i}`, text: `c${i}`, state, evidence: '', by: null, at: null })),
  budget: null,
  createdAt: 0,
  updatedAt: 0,
  version: 1,
});

describe('planning space', () => {
  it('reads plan lines and implementation tasks', () => {
    expect(planLines('- Jump\n\n* [ ] Land\n2. Fall  \n')).toEqual(['Jump', 'Land', 'Fall']);
    expect(plannedTasks('Movement script | scripts/player/**, scenes/player.tscn | scripts/player/AGENTS.md\nAnimations\n | nothing')).toEqual([
      { title: 'Movement script', scope: ['scripts/player/**', 'scenes/player.tscn'], readFirst: ['scripts/player/AGENTS.md'] },
      { title: 'Animations', scope: [], readFirst: [] },
    ]);
  });

  it('edits text with the smallest change, so concurrent edits survive', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    setText(a.getText('t'), 'hello world');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    setText(a.getText('t'), 'hello big world');
    setText(b.getText('t'), 'hello world!');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(a.getText('t').toString()).toBe('hello big world!');
    expect(b.getText('t').toString()).toBe('hello big world!');
  });

  it('moves an edit made against an older text around changes that arrived since', () => {
    const doc = new Y.Doc();
    const text = doc.getText('t');
    setText(text, 'jump high');
    // Someone else's change lands first; the editor still shows "jump high".
    setText(text, 'Players jump high');
    setText(text, 'jump very high', 'jump high');
    expect(text.toString()).toBe('Players jump very high');
    setText(text, 'Players jump very high!', 'Players jump very high');
    setText(text, 'Players can jump very high', 'Players jump very high');
    expect(text.toString()).toBe('Players can jump very high!');
  });

  it('applies plan changes and refuses items that are gone', () => {
    const doc = new Y.Doc();
    applyPlanOp(doc, { op: 'create', id: 'feature-1', kind: 'idea', title: 'Grapple' }, 'Martin', 5);
    applyPlanOp(doc, { op: 'set', id: 'feature-1', kind: 'feature' }, 'Friend', 6);
    applyPlanOp(doc, { op: 'approve', id: 'feature-1' }, 'Friend', 7);
    expect(readPlanning(doc)).toMatchObject([{ kind: 'feature', title: 'Grapple', createdBy: 'Martin', approvedBy: 'Friend', approvedAt: 7 }]);
    applyPlanOp(doc, { op: 'delete', id: 'feature-1' }, 'Martin');
    expect(applyPlanOp(doc, { op: 'text', id: 'feature-1', field: 'body', value: 'x' }, 'Martin')).toBe(false);
    expect(readPlanning(doc)).toEqual([]);
  });

  it('follows a feature from planning to ready through its tasks', () => {
    const doc = new Y.Doc();
    applyPlanOp(doc, { op: 'create', id: 'feature-a', kind: 'feature', title: 'Movement' }, 'M');
    applyPlanOp(doc, { op: 'create', id: 'feature-b', kind: 'feature', title: 'Double jump' }, 'M');
    applyPlanOp(doc, { op: 'text', id: 'feature-b', field: 'dependencies', value: '- movement\nInput remapping' }, 'M');
    const [movement, jump] = readPlanning(doc);

    expect(featureStatus(movement!, readPlanning(doc), []).state).toBe('planning');
    expect(featureStatus(jump!, readPlanning(doc), [task('t1', 'feature-b', 'planning')])).toMatchObject({
      state: 'blocked',
      reason: 'Waiting on Movement',
    });

    const done = [task('m1', 'feature-a', 'done', ['verified'])];
    expect(featureStatus(movement!, readPlanning(doc), done).state).toBe('ready');
    expect(featureStatus(jump!, readPlanning(doc), [...done, task('t1', 'feature-b', 'implementing'), task('t2', 'feature-b', 'testing')])).toMatchObject({
      state: 'in-progress',
      stage: 'implementing',
    });
    expect(featureStatus(jump!, readPlanning(doc), [...done, task('t1', 'feature-b', 'testing', ['verified', 'untested'])])).toMatchObject({
      state: 'unverified',
      verified: 1,
      untested: 1,
    });
    expect(featureStatus(jump!, readPlanning(doc), [...done, task('t1', 'feature-b', 'done', ['failing'])]).state).toBe('blocked');
  });
});

describe('project memory', () => {
  it('keeps entries and renders them for agents', () => {
    const doc = new Y.Doc();
    applyMemoryOp(doc, { op: 'create', id: 'memory-1', kind: 'issue', title: 'Menu flickers', source: { kind: 'chat', id: 'chat-1', title: 'Menu bug' } }, 'M', 1);
    applyMemoryOp(doc, { op: 'create', id: 'memory-2', kind: 'decision', title: 'Signals over polling', body: 'Use signals\nfor UI.' }, 'M', 2);
    applyMemoryOp(doc, { op: 'text', id: 'memory-1', value: 'Only on Windows.' }, 'F', 3);
    expect(readMemory(doc)).toMatchObject([
      { title: 'Menu flickers', body: 'Only on Windows.', source: { kind: 'chat', id: 'chat-1' }, updatedAt: 3 },
      { title: 'Signals over polling', source: null },
    ]);
    expect(renderMemory(readMemory(doc)).text).toBe(
      'Architecture decisions:\n- Signals over polling\n  Use signals\n  for UI.\n\nKnown issues:\n- Menu flickers\n  Only on Windows.',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { duplicateQuestionPrompt, orderNotes, parseDuplicateAnswer } from '@pct/shared';

const notes = [
  { path: 'AGENTS.md', text: 'Game project. Read the folder notes first.' },
  { path: 'scripts/player/AGENTS.md', text: 'Player code. Inventory lives in inventory.gd (class Inventory).' },
  { path: 'scripts/world/AGENTS.md', text: 'World objects: doors, chests.' },
  { path: 'tools/AGENTS.md', text: 'Build scripts.' },
];

describe('review-time duplicate question', () => {
  it('puts the notes nearest the change first', () => {
    expect(orderNotes(notes, ['scripts/world/chest_storage.gd']).map((n) => n.path)).toEqual([
      'AGENTS.md',
      'scripts/world/AGENTS.md',
      'tools/AGENTS.md',
      'scripts/player/AGENTS.md',
    ]);
  });

  it('asks one question with the task, the files, the notes and the change', () => {
    const prompt = duplicateQuestionPrompt({
      task: { title: 'Chest storage', scope: ['scripts/world/**'], criteria: [{ id: 'c', text: 'Chests hold items', state: 'untested', evidence: '', by: null, at: null }] },
      files: ['scripts/world/chest_storage.gd'],
      diff: 'diff --git a/scripts/world/chest_storage.gd b/scripts/world/chest_storage.gd\n+class_name ChestStorage\n',
      notes,
    });
    expect(prompt).toContain('Does this change add a system, helper or asset that the folder notes below say already exists');
    expect(prompt).toContain('VERDICT: duplicate');
    expect(prompt).toContain('Task: Chest storage');
    expect(prompt).toContain('- Chests hold items');
    expect(prompt).toContain('- scripts/world/chest_storage.gd');
    expect(prompt).toContain('Inventory lives in inventory.gd');
    expect(prompt).toContain('+class_name ChestStorage');
  });

  it('reads the verdict and the explanation', () => {
    expect(parseDuplicateAnswer('VERDICT: duplicate\nChestStorage repeats Inventory (scripts/player/inventory.gd).')).toEqual({
      verdict: 'duplicate',
      answer: 'ChestStorage repeats Inventory (scripts/player/inventory.gd).',
    });
    expect(parseDuplicateAnswer('```\n**Verdict:** Clear\nIt uses the existing Inventory.\n```')).toEqual({ verdict: 'clear', answer: 'It uses the existing Inventory.' });
    expect(parseDuplicateAnswer('I think it is fine.')).toEqual({ verdict: 'unsure', answer: 'I think it is fine.' });
  });
});

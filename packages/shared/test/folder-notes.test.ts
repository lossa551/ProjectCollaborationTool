import { describe, expect, it } from 'vitest';
import { coveringNote, notesForPaths, notesToUpdate, patternFolder, renderFolderNotes } from '@pct/shared';

const notes = ['AGENTS.md', 'scripts/AGENTS.md', 'scripts/player/AGENTS.md', 'scripts/player/ai/AGENTS.md', 'scenes/AGENTS.md'];

describe('folder notes in the agent workflow', () => {
  it('finds the folder a path or pattern points at', () => {
    expect(patternFolder('scripts/player/**')).toBe('scripts/player');
    expect(patternFolder('scripts/player/jump.gd')).toBe('scripts/player');
    expect(patternFolder('scripts/player')).toBe('scripts/player');
    expect(patternFolder('scripts/*/jump.gd')).toBe('scripts');
    expect(patternFolder('*.psd')).toBe('');
  });

  it('picks the notes of a task’s folders, the folders above and the folders inside', () => {
    expect(notesForPaths(notes, ['scripts/player/**'])).toEqual(['AGENTS.md', 'scripts/AGENTS.md', 'scripts/player/AGENTS.md', 'scripts/player/ai/AGENTS.md']);
    expect(notesForPaths(notes, ['Scenes/main.tscn'])).toEqual(['AGENTS.md', 'scenes/AGENTS.md']);
    expect(notesForPaths(notes, [])).toEqual(['AGENTS.md']);
    expect(notesForPaths(['scripts/AGENTS.md'], ['art/**'])).toEqual([]);
  });

  it('flags notes whose files changed when the note did not', () => {
    expect(coveringNote('scripts/player/ai/brain.gd', notes)).toBe('scripts/player/ai/AGENTS.md');
    expect(coveringNote('art/hero.png', ['scripts/AGENTS.md'])).toBeNull();
    expect(notesToUpdate(['scripts/player/jump.gd', 'scripts/player/run.gd', 'scenes/main.tscn', 'scenes/AGENTS.md', 'README.md'], notes)).toEqual([
      { note: 'AGENTS.md', files: ['README.md'] },
      { note: 'scripts/player/AGENTS.md', files: ['scripts/player/jump.gd', 'scripts/player/run.gd'] },
    ]);
  });

  it('keeps the notes within the token budget and names the rest', () => {
    const rendered = renderFolderNotes(
      [
        { path: 'AGENTS.md', text: 'Top folder.' },
        { path: 'scripts/AGENTS.md', text: 'x'.repeat(400) },
        { path: 'scenes/AGENTS.md', text: 'Scenes.' },
      ],
      50,
    );
    expect(rendered.included.map((n) => n.path)).toEqual(['AGENTS.md', 'scenes/AGENTS.md']);
    expect(rendered.skipped).toEqual(['scripts/AGENTS.md']);
    expect(rendered.text).toContain('--- scenes/AGENTS.md ---\nScenes.');
    expect(rendered.text).toContain('- scripts/AGENTS.md');
    expect(renderFolderNotes([]).text).toBe('');
  });
});

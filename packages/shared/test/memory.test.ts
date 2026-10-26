import { describe, expect, it } from 'vitest';
import { memoryMarkdown, type MemoryEntry } from '../src/index.js';

const entry = (id: string, kind: MemoryEntry['kind'], title: string, body = '', createdAt = 1_761_480_000_000): MemoryEntry => ({
  id,
  kind,
  title,
  body,
  createdBy: 'Martin',
  createdAt,
  updatedAt: createdAt,
  source: null,
});

describe('memoryMarkdown', () => {
  it('lists every entry under its kind, oldest first, with empty kinds marked', () => {
    const text = memoryMarkdown([
      entry('b', 'decision', 'Use SQLite on the host', 'One file per session.\n\nMoves to Postgres later.', 2_000_000_000_000),
      entry('a', 'decision', 'Electron + TypeScript'),
      { ...entry('c', 'issue', 'Locks stay after a crash'), source: { kind: 'chat', id: 'x', title: 'Lock review' } },
    ]);
    expect(text).toContain('# Project memory');
    expect(text.indexOf('### Electron + TypeScript')).toBeLessThan(text.indexOf('### Use SQLite on the host'));
    expect(text).toContain('One file per session.\n\nMoves to Postgres later.');
    expect(text).toMatch(/## Conventions\n\n_None yet._/);
    expect(text).toContain('_Martin, 2025-10-26 · from agent chat "Lock review"_');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('comes out the same whatever order the entries arrive in', () => {
    const entries = [entry('a', 'plan', 'One'), entry('b', 'plan', 'Two', 'x', 5), entry('c', 'convention', 'Three')];
    expect(memoryMarkdown([...entries].reverse())).toBe(memoryMarkdown(entries));
  });
});

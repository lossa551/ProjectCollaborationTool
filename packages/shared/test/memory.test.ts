import { describe, expect, it } from 'vitest';
import { MEMORY_TOKEN_BUDGET, Y, applyMemoryOp, findMemory, memoryMarkdown, readMemory, renderMemory, type MemoryEntry } from '../src/index.js';

const entry = (id: string, kind: MemoryEntry['kind'], title: string, body = '', createdAt = 1_761_480_000_000): MemoryEntry => ({
  id,
  kind,
  title,
  body,
  createdBy: 'Martin',
  createdAt,
  updatedAt: createdAt,
  source: null,
  archived: false,
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

  it('puts archived entries under their own heading, not under their kind', () => {
    const text = memoryMarkdown([entry('a', 'plan', 'Ship 0.2'), { ...entry('b', 'plan', 'Old save format', 'JSON'), archived: true }]);
    expect(text.indexOf('### Old save format')).toBeGreaterThan(text.indexOf('## Archived'));
    expect(text.indexOf('### Ship 0.2')).toBeLessThan(text.indexOf('## Archived'));
    expect(text).toContain('_Plan · Martin, 2025-10-26_');
    expect(memoryMarkdown([entry('a', 'plan', 'Ship 0.2')])).not.toContain('## Archived');
  });
});

describe('renderMemory', () => {
  it('gives conventions and decisions first, newest first within a kind, and leaves archived entries out', () => {
    const rendered = renderMemory([
      entry('p', 'plan', 'Next: menus'),
      entry('i', 'issue', 'Menu flickers'),
      entry('d1', 'decision', 'Old decision', '', 1),
      entry('d2', 'decision', 'New decision', '', 2),
      entry('c', 'convention', 'Tabs'),
      { ...entry('x', 'issue', 'Fixed crash'), archived: true },
    ]);
    expect(rendered.included.map((e) => e.id)).toEqual(['c', 'd2', 'd1', 'i', 'p']);
    expect(rendered.archived).toBe(1);
    expect(rendered.text).not.toContain('Fixed crash');
    expect(rendered.text.startsWith('Conventions:\n- Tabs\n\nArchitecture decisions:\n- New decision\n- Old decision')).toBe(true);
  });

  it('lists entries past the budget by title, keeping the ones linked to the chat', () => {
    const big = 'x'.repeat(MEMORY_TOKEN_BUDGET * 8); // twice the budget in tokens
    const entries = [
      entry('a', 'issue', 'Newest issue', big, 3),
      entry('b', 'issue', 'Jump bug', `In src/player/jump.gd. ${big}`, 1),
      { ...entry('c', 'issue', 'From the jump chat', 'Short.', 2), source: { kind: 'chat' as const, id: 'chat-2', title: 'Jump' } },
    ];
    const plain = renderMemory(entries, { budget: MEMORY_TOKEN_BUDGET * 3, readHint: 'use read_memory' });
    expect(plain.included.map((e) => e.id)).toEqual(['a', 'c']);
    expect(plain.text).toContain('More entries, by title only (use read_memory):\n- Known issue: Jump bug');

    const focused = renderMemory(entries, { budget: MEMORY_TOKEN_BUDGET * 3, focus: { chatIds: ['chat-2'], paths: ['src/player/**'] } });
    expect(focused.included.map((e) => e.id)).toEqual(['c', 'b']);
    expect(focused.listed.map((e) => e.id)).toEqual(['a']);
  });

  it('finds an entry by its title, archived ones too', () => {
    const entries = [entry('a', 'plan', 'Old save format'), { ...entry('b', 'issue', 'Save crash'), archived: true }];
    expect(findMemory(entries, '  old SAVE format ').map((e) => e.id)).toEqual(['a']);
    expect(findMemory(entries, 'crash').map((e) => e.id)).toEqual(['b']);
    expect(findMemory(entries, 'nothing')).toEqual([]);
  });

  it('archives and restores an entry', () => {
    const doc = new Y.Doc();
    applyMemoryOp(doc, { op: 'create', id: 'memory-1', kind: 'plan', title: 'Ship 0.2' }, 'M', 1);
    expect(readMemory(doc)[0]!.archived).toBe(false);
    applyMemoryOp(doc, { op: 'set', id: 'memory-1', archived: true }, 'M', 2);
    expect(readMemory(doc)[0]).toMatchObject({ archived: true, updatedAt: 2 });
    applyMemoryOp(doc, { op: 'set', id: 'memory-1', archived: false }, 'M', 3);
    expect(readMemory(doc)[0]!.archived).toBe(false);
  });
});

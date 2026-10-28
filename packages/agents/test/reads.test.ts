import { describe, expect, it } from 'vitest';
import { ReadMemo, changedRegion } from '@pct/agents';

const file = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

describe('repeated file reads', () => {
  it('answers a second read of an unchanged file briefly while the first copy is still in the conversation', () => {
    const memo = new ReadMemo();
    const shown = new Set<string>();
    const visible = (id: string) => shown.has(id);
    const text = file(50).join('\n');
    expect(memo.read('src/a.gd', text, 'c1', visible)).toMatch(/^ {4}1 {2}line 1\n/);
    shown.add('c1');
    expect(memo.read('src/a.gd', text, 'c2', visible)).toBe(
      'src/a.gd is unchanged since you read it (50 lines); the copy earlier in this conversation is current.',
    );
    expect(memo.saved).toBe(1);
    // A different part is read whole.
    expect(memo.read('src/a.gd', text, 'c3', visible, 10, 5)).toMatch(/^ {3}10 {2}line 10\n/);
    expect(memo.saved).toBe(1);
  });

  it('reads the file whole again once the earlier copy was cleared from the conversation', () => {
    const memo = new ReadMemo();
    const text = file(20).join('\n');
    memo.read('src/a.gd', text, 'c1', () => true);
    expect(memo.read('src/a.gd', text, 'c2', () => false)).toMatch(/^ {4}1 {2}line 1\n/);
    expect(memo.saved).toBe(0);
  });

  it('sends only the changed lines after an edit, and the whole file when most of it changed', () => {
    const memo = new ReadMemo();
    const visible = () => true;
    const before = file(100);
    memo.read('src/a.gd', before.join('\n'), 'c1', visible);
    const after = [...before];
    after.splice(49, 1, 'changed 50', 'added 50b');
    const answer = memo.read('src/a.gd', after.join('\n'), 'c2', visible);
    expect(answer).toContain('src/a.gd changed since you read it (now 101 lines, was 100): lines 50-51 are new, replacing old lines 50-50.');
    expect(answer).toContain('Lines after it moved down by 1.');
    expect(answer.split('\n').slice(1)).toEqual([
      '   47  line 47',
      '   48  line 48',
      '   49  line 49',
      '   50  changed 50',
      '   51  added 50b',
      '   52  line 51',
      '   53  line 52',
      '   54  line 53',
    ]);
    expect(memo.saved).toBe(1);
    // Building on that: unchanged again.
    expect(memo.read('src/a.gd', after.join('\n'), 'c3', visible)).toContain('unchanged since you read it (101 lines)');
    // Most of it rewritten: sent whole.
    const rewritten = after.map((l, i) => (i < 80 ? `new ${l}` : l));
    expect(memo.read('src/a.gd', rewritten.join('\n'), 'c4', visible)).toMatch(/^ {4}1 {2}new line 1\n/);
  });

  it('says which lines were removed', () => {
    const before = file(30);
    const after = [...before.slice(0, 10), ...before.slice(12)];
    const answer = changedRegion('a.txt', before, after)!;
    expect(answer).toContain('old lines 11-12 were removed');
    expect(answer).toContain('Lines after it moved up by 2.');
    expect(answer.split('\n').slice(1)).toEqual(['    8  line 8', '    9  line 9', '   10  line 10', '   11  line 13', '   12  line 14', '   13  line 15']);
  });

  it('sends long files 400 lines at a time and says where the rest starts', () => {
    const memo = new ReadMemo();
    const answer = memo.read('src/long.gd', file(1000).join('\n'), 'c1', () => true);
    expect(answer.split('\n')).toHaveLength(401);
    expect(answer).toMatch(/… 600 more lines; read them with offset 401$/);
  });
});

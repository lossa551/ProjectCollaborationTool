import { describe, expect, it } from 'vitest';
import { summarizeResult, trimHistory, type LoopMessage } from '@pct/agents';

const big = (lines: number) => Array.from({ length: lines }, (_, i) => `${i + 1}\tline ${i + 1} of the file`).join('\n');

/** One step: the model reads a file, the tool answers with its lines. */
function readStep(id: string, path: string, lines: number): LoopMessage[] {
  return [
    { role: 'assistant', text: '', toolCalls: [{ id, name: 'read_file', input: { path } }] },
    { role: 'tool', results: [{ id, content: big(lines), isError: false }] },
  ];
}

describe('trimming old tool results', () => {
  it('keeps the last steps whole and waits for a batch before clearing older ones', () => {
    const history: LoopMessage[] = [{ role: 'user', text: 'Martin: fix the jump' }];
    for (let i = 1; i <= 7; i++) history.push(...readStep(`t${i}`, `src/f${i}.gd`, 100));
    // 7 steps, 6 kept: only one is old, fewer than a batch, so nothing changes.
    const before = JSON.stringify(history);
    expect(trimHistory(history, 6, 3)).toBe(0);
    expect(JSON.stringify(history)).toBe(before);

    history.push(...readStep('t8', 'src/f8.gd', 100), ...readStep('t9', 'src/f9.gd', 420));
    expect(trimHistory(history, 6, 3)).toBe(3);
    const results = history.flatMap((m) => (m.role === 'tool' ? m.results : []));
    expect(results[0]!.content).toBe('[Old result cleared to keep the context small: read src/f1.gd, 100 lines. Run the tool again if you need it.]');
    expect(results[2]!.content).toContain('read src/f3.gd, 100 lines');
    // The last six are untouched.
    expect(results.slice(3).every((r) => r.content.startsWith('1\tline 1'))).toBe(true);
    // Cleared results are not counted again, so the history stays the same until a new batch is due.
    const after = JSON.stringify(history);
    expect(trimHistory(history, 6, 3)).toBe(0);
    expect(JSON.stringify(history)).toBe(after);
  });

  it('keeps the app’s notes on old results', () => {
    const history: LoopMessage[] = [{ role: 'user', text: 'Martin: fix the jump' }];
    for (let i = 1; i <= 4; i++) history.push(...readStep(`t${i}`, `src/f${i}.gd`, 100));
    history[2] = { ...(history[2] as Extract<LoopMessage, { role: 'tool' }>), note: 'Task changed.' };
    expect(trimHistory(history, 2, 2)).toBe(2);
    expect(history[2]).toMatchObject({ role: 'tool', note: 'Task changed.' });
  });

  it('shortens big inputs of old calls, in the provider’s own blocks too, and leaves short results alone', () => {
    const content = big(300);
    const history: LoopMessage[] = [
      { role: 'user', text: 'Martin: write the player' },
      {
        role: 'assistant',
        text: 'Writing it.',
        toolCalls: [{ id: 'w1', name: 'write_file', input: { path: 'src/player.gd', content } }],
        raw: [
          { type: 'thinking', thinking: 'plan', signature: 'sig' },
          { type: 'tool_use', id: 'w1', name: 'write_file', input: { path: 'src/player.gd', content } },
        ],
      },
      { role: 'tool', results: [{ id: 'w1', content: 'Wrote src/player.gd (300 lines).', isError: false }] },
      ...readStep('r1', 'src/enemy.gd', 50),
    ];
    expect(trimHistory(history, 1, 1)).toBe(1);
    const call = history[1] as Extract<LoopMessage, { role: 'assistant' }>;
    expect(call.toolCalls[0]!.input).toEqual({ path: 'src/player.gd', content: '[300 lines cleared from the context]' });
    expect((call.raw as unknown[])[0]).toEqual({ type: 'thinking', thinking: 'plan', signature: 'sig' });
    expect((call.raw as { input: unknown }[])[1]!.input).toEqual({ path: 'src/player.gd', content: '[300 lines cleared from the context]' });
    expect((history[2] as Extract<LoopMessage, { role: 'tool' }>).results[0]!.content).toBe('Wrote src/player.gd (300 lines).');
    // The last step is kept whole.
    expect((history[4] as Extract<LoopMessage, { role: 'tool' }>).results[0]!.content).toBe(big(50));
  });

  it('says what each kind of result was, and keeps the end of a failure', () => {
    const output = `${'x'.repeat(2000)}\nError: player.gd:12 unexpected token\n(exit code 1)`;
    expect(summarizeResult({ id: 'c', name: 'run_command', input: { command: 'npm test' } }, { id: 'c', content: output, isError: true })).toBe(
      '[Old result cleared to keep the context small: ran npm test, exit code 1, 3 lines of output. Run the tool again if you need it.]\n' +
        `Last lines: ${output.slice(-300).trim()}`,
    );
    expect(summarizeResult({ id: 's', name: 'search', input: { pattern: 'jump', path: 'src' } }, { id: 's', content: 'a\nb', isError: false })).toContain(
      'searched for "jump" in src, 2 lines of matches',
    );
    expect(summarizeResult({ id: 'l', name: 'list_files', input: {} }, { id: 'l', content: 'a', isError: false })).toContain('listed the project, 1 entry');
    expect(summarizeResult(undefined, { id: 'x', content: 'a\nb\nc', isError: false })).toContain('tool, 3 lines of output');
  });
});

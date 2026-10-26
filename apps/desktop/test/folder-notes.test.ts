import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { draftNotePrompt, rootIndex, summarizeNote, updateNotePrompt } from '../src/common/folder-notes';
import { isIgnored, noteReferences, parseLog, scanFolderNotes } from '../src/main/folder-notes';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** A repository whose commits are a minute apart, so "changed since the note" is clear. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'pct-notes-'));
  dirs.push(dir);
  let clock = Date.UTC(2026, 0, 1) / 1000;
  const git = (...args: string[]) => {
    const date = `${clock} +0000`;
    return execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }).toString();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (message: string) => {
    clock += 60;
    git('add', '-A');
    git('commit', '-qm', message);
  };
  return { dir, write, commit, remove: (path: string) => unlinkSync(join(dir, path)) };
}

const folder = (report: Awaited<ReturnType<typeof scanFolderNotes>>, path: string) => {
  const found = report.folders.find((f) => f.path === path);
  if (!found) throw new Error(`no folder ${path}`);
  return found;
};

describe('folder notes scan', () => {
  it('weighs folders, skips ignored and binary files, and finds notes', async () => {
    const { dir, write, commit } = repo();
    write('.gitignore', 'secret/\n');
    write('src/player.gd', 'x'.repeat(4000));
    write('src/AGENTS.md', '# Player\nThe player controller lives in `player.gd`.\n');
    write('art/hero.png', 'binary');
    write('node_modules/lib/index.js', 'y'.repeat(9000));
    write('secret/keys.txt', 'z'.repeat(9000));
    commit('start');

    const report = await scanFolderNotes(dir);
    const src = folder(report, 'src');
    expect(src.notePath).toBe('src/AGENTS.md');
    expect(src.state).toBe('fresh');
    expect(src.tokens).toBeGreaterThanOrEqual(1000);
    expect(src.noteSummary).toBe('The player controller lives in `player.gd`.');
    expect(folder(report, 'art').binaryFiles).toBe(1);
    expect(folder(report, 'art').tokens).toBe(0);
    expect(report.folders.some((f) => f.path.startsWith('node_modules') || f.path.startsWith('secret'))).toBe(false);
    expect(report.totals.ignoredFiles).toBe(1);
    expect(report.totals.notes).toBe(1);
    expect(rootIndex(report)).toContain('- `src/AGENTS.md`');
  });

  it('goes from fresh to drifting to stale as the folder moves on', async () => {
    const { dir, write, commit, remove } = repo();
    write('src/AGENTS.md', 'Read `a.ts` first, then `b.ts`.\n');
    write('src/a.ts', 'a');
    write('src/b.ts', 'b');
    commit('start');
    expect(folder(await scanFolderNotes(dir), 'src').state).toBe('fresh');

    write('src/a.ts', 'a2');
    commit('change a');
    let src = folder(await scanFolderNotes(dir), 'src');
    expect(src.state).toBe('drifting');
    expect(src.changed).toEqual([{ path: 'src/a.ts', change: 'modified' }]);

    // Not committed yet counts too.
    write('src/c.ts', 'c');
    src = folder(await scanFolderNotes(dir), 'src');
    expect(src.changed).toContainEqual({ path: 'src/c.ts', change: 'added' });
    expect(src.unmentioned).toEqual(['src/c.ts']);

    // The note names a file that is gone.
    remove('src/b.ts');
    commit('drop b');
    src = folder(await scanFolderNotes(dir), 'src');
    expect(src.state).toBe('stale');
    expect(src.deadReferences).toEqual(['b.ts']);
    expect(src.changed).toContainEqual({ path: 'src/b.ts', change: 'deleted' });

    // Updating the note makes it fresh again.
    write('src/AGENTS.md', 'Read `a.ts` first. `c.ts` holds the rest.\n');
    commit('update note');
    src = folder(await scanFolderNotes(dir), 'src');
    expect(src.state).toBe('fresh');
    expect(src.changed).toEqual([]);
  });

  it('a note being edited counts as up to date', async () => {
    const { dir, write, commit } = repo();
    write('src/AGENTS.md', 'Old.\n');
    write('src/a.ts', 'a');
    commit('start');
    write('src/a.ts', 'a2');
    commit('change');
    write('src/AGENTS.md', 'New, mentions `a.ts`.\n');
    const src = folder(await scanFolderNotes(dir), 'src');
    expect(src.state).toBe('fresh');
    expect(src.noteCommittedAt).toBeNull();
  });

  it('flags big folders without a note as missing, and subfolder notes take their files', async () => {
    const { dir, write, commit } = repo();
    for (let i = 0; i < 30; i++) write(`game/scripts/s${i}.gd`, 'extends Node\n');
    write('game/ui/AGENTS.md', 'UI.\n');
    write('game/ui/menu.gd', 'm'.repeat(200_000));
    write('tools/a.py', 'print(1)\n');
    commit('start');
    const report = await scanFolderNotes(dir);
    expect(folder(report, 'game/scripts').state).toBe('missing');
    expect(folder(report, 'tools').state).toBe('not-needed');
    // game/ is just a way into game/scripts/, so the note belongs there.
    expect(folder(report, 'game').state).toBe('not-needed');
    // The UI folder's weight belongs to its own note, not to game/.
    expect(folder(report, 'game').tokens).toBeGreaterThan(50_000);
    expect(folder(report, 'game').ownTokens).toBeLessThan(1000);
    const scripts = folder(report, 'game/scripts');
    const prompt = draftNotePrompt(scripts, []);
    expect(prompt).toContain('Write a folder note, game/scripts/AGENTS.md');
    expect(prompt).toContain('Only create game/scripts/AGENTS.md.');
  });

  it('works in a repository with no commits yet', async () => {
    const { dir, write } = repo();
    write('a.txt', 'hello');
    const report = await scanFolderNotes(dir);
    expect(report.totals.files).toBe(1);
  });
});

describe('folder notes helpers', () => {
  it('finds path references in a note', () => {
    const refs = noteReferences(
      [
        'Start with `scenes/main.tscn` and `player.gd:12`.',
        'Skip `addons/`. See [the guide](../docs/guide.md#setup) and https://example.com/x.md.',
        'Calls `move_and_slide()` and uses `*.tres`, `npm run build` and `v1.2`.',
      ].join('\n'),
    );
    expect(refs.sort()).toEqual(['../docs/guide.md', 'addons', 'player.gd', 'scenes/main.tscn']);
  });

  it('reads the newest commit per path from git log', () => {
    const history = parseLog(['@@200', '', 'M\ta.ts', 'D\told.ts', '@@100', '', 'A\ta.ts', 'A\told.ts', 'A\t"we\\"ird.ts"'].join('\n'));
    expect(history.get('a.ts')).toEqual({ at: 200_000, change: 'modified' });
    expect(history.get('old.ts')).toEqual({ at: 200_000, change: 'deleted' });
    expect(history.get('we"ird.ts')).toEqual({ at: 100_000, change: 'added' });
  });

  it('ignores build and engine folders', () => {
    expect(isIgnored('Saved/Logs/x.log')).toBe(true);
    expect(isIgnored('game/.godot/cache.bin')).toBe(true);
    expect(isIgnored('package-lock.json')).toBe(true);
    expect(isIgnored('icon.png.import')).toBe(true);
    expect(isIgnored('src/build.ts')).toBe(false);
  });

  it('builds an update prompt naming what changed', () => {
    const prompt = updateNotePrompt({
      path: 'src',
      depth: 1,
      notePath: 'src/AGENTS.md',
      state: 'stale',
      tokens: 10,
      ownTokens: 10,
      ownFiles: 2,
      files: 2,
      binaryFiles: 0,
      binaryBytes: 0,
      noteTokens: 5,
      noteSummary: null,
      noteCommittedAt: 0,
      changed: [
        { path: 'src/new.ts', change: 'added' },
        { path: 'src/gone.ts', change: 'deleted' },
      ],
      deadReferences: ['gone.ts'],
      unmentioned: ['src/new.ts'],
      largest: [],
      reasons: [],
    });
    expect(prompt).toContain('Update the folder note src/AGENTS.md');
    expect(prompt).toMatch(/Added:\n- src\/new\.ts/);
    expect(prompt).toMatch(/Deleted:\n- src\/gone\.ts/);
    expect(prompt).toContain('- gone.ts');
    expect(prompt).toContain('Only change src/AGENTS.md.');
  });

  it('summarizes a note by its first line of text', () => {
    expect(summarizeNote('# Title\n\n<!-- x -->\n- Holds the save system.\nMore.')).toBe('Holds the save system.');
  });
});

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RULES_START, SETUP_COMMIT_MESSAGE, detectProject, setupFiles } from '@pct/shared';
import { runBloatCheck } from '../src/main/bloat';
import { scanFolderNotes } from '../src/main/folder-notes';
import { commitPaths, hasCommit } from '../src/main/git';
import { noteCandidates, noteDraftInput, readProjectFacts, writeProjectFiles } from '../src/main/setup';
import { cleanNote, noteDraftPrompt } from '../src/common/folder-notes';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

function project() {
  const root = mkdtempSync(join(tmpdir(), 'pct-setup-'));
  dirs.push(root);
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 'test@example.com');
  sh(root, 'config', 'user.name', 'Test');
  const write = (path: string, content: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  return { root, write };
}

describe('project setup in a folder', () => {
  it('detects a new Unreal project, writes the preset and commits only its own files', async () => {
    const { root, write } = project();
    write('Shooter.uproject', JSON.stringify({ FileVersion: 3, EngineAssociation: '5.8' }));
    write('.gitignore', 'Saved/\n');
    write('Source/Shooter/Shooter.cpp', '// game\n');
    write('notes.txt', 'mine, not committed by setup\n');
    expect(await hasCommit(root)).toBe(false);

    const facts = await readProjectFacts(root);
    expect(facts.topFiles).toContain('Source/');
    const detected = detectProject(facts);
    expect(detected).toMatchObject({ engine: 'unreal', version: '5.8', name: 'Shooter' });

    const written = writeProjectFiles(root, setupFiles('unreal', facts, ['gitignore', 'bloat', 'agents', 'claude']));
    expect(written.sort()).toEqual(['.collab-tool.json', '.gitignore', 'AGENTS.md', 'CLAUDE.md']);
    // Writing the same again changes nothing.
    expect(writeProjectFiles(root, setupFiles('unreal', await readProjectFacts(root), ['gitignore', 'bloat', 'agents', 'claude']))).toEqual([]);
    const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(gitignore.startsWith('Saved/\n')).toBe(true);
    expect(gitignore.match(/Saved\//g)).toHaveLength(1);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8').startsWith(RULES_START)).toBe(true);

    const commit = await commitPaths(root, written, SETUP_COMMIT_MESSAGE);
    expect(commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(sh(root, 'log', '--format=%s')).toBe(SETUP_COMMIT_MESSAGE);
    expect(sh(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(written.sort());
    expect(sh(root, 'status', '--porcelain')).toContain('?? notes.txt');
    // Nothing changed since: no empty commit.
    expect(await commitPaths(root, written, SETUP_COMMIT_MESSAGE)).toBeNull();
  });

  it('lets the bloat check skip the files the setup file lists', async () => {
    const { root, write } = project();
    write('.collab-tool.json', JSON.stringify({ engine: 'godot', bloatSkip: ['vendor/**'] }));
    write('art/a.png', 'x'.repeat(200));
    write('vendor/copy.png', 'x'.repeat(200));
    const report = await runBloatCheck(root, 'Martin', 'main');
    expect(report.duplicates).toEqual([]);
    expect(report.unusedAssets).toEqual(['art/a.png']);
  });

  it('offers first notes for big folders and gives the agent their files', async () => {
    const { root, write } = project();
    write('AGENTS.md', `${RULES_START}\nrules\n`);
    for (let i = 0; i < 30; i++) write(`scripts/player/part${i}.gd`, `extends Node\n# part ${i}\n${'var x = 1\n'.repeat(400)}`);
    write('README.md', 'Game\n');
    sh(root, 'add', '.');
    sh(root, 'commit', '-qm', 'start');
    const report = await scanFolderNotes(root);
    const candidates = noteCandidates(report);
    expect(candidates.map((f) => f.path)).toContain('scripts/player');
    expect(candidates.some((f) => f.path === '')).toBe(false);

    const folder = candidates.find((f) => f.path === 'scripts/player')!;
    const input = await noteDraftInput(root, folder, report);
    expect(input.existing).toBeNull();
    expect(input.listing).toHaveLength(30);
    expect(input.files.length).toBeGreaterThan(0);
    expect(input.files[0]!.text.length).toBeLessThanOrEqual(4000);
    const prompt = noteDraftPrompt(folder, input);
    expect(prompt).toContain('Write a first folder note, scripts/player/AGENTS.md');
    expect(prompt).toContain('- scripts/player/part0.gd');
    expect(prompt).toContain('no code fence');
  });
});

describe('writeProjectFiles', () => {
  it('keeps Windows line endings in a file that had them', () => {
    const { root, write } = project();
    write('.gitignore', 'Saved/\r\n');
    expect(writeProjectFiles(root, { '.gitignore': 'Saved/\n\n# Added\nBinaries/\n' })).toEqual(['.gitignore']);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('Saved/\r\n\r\n# Added\r\nBinaries/\r\n');
    expect(writeProjectFiles(root, { '.gitignore': 'Saved/\n\n# Added\nBinaries/\n' })).toEqual([]);
  });
});

describe('cleanNote', () => {
  it('takes a code fence off the answer', () => {
    expect(cleanNote('```markdown\n# Player\n\nMovement.\n```')).toBe('# Player\n\nMovement.\n');
    expect(cleanNote('  # Player  \n')).toBe('# Player\n');
    expect(cleanNote('   ')).toBe('');
  });
});

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runBloatCheck } from '../src/main/bloat';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('bloat check on a project folder', () => {
  it('reads the files git knows about and leaves ignored ones out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pct-bloat-'));
    dirs.push(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const write = (path: string, content: string | Buffer) => {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    };
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), Buffer.alloc(200, 7)]);
    write('.gitignore', '.godot/\n');
    write('art/hero.png', png);
    write('art/hero copy.png', png);
    write('art/unused.png', Buffer.concat([png, Buffer.from([1])]));
    write('.godot/imported/cache.png', png);
    write('scenes/main.tscn', '[ext_resource path="res://art/hero.png"]\n[ext_resource path="res://art/hero copy.png"]\n');
    write('package.json', JSON.stringify({ dependencies: { lodash: '1' } }));
    write('data/levels.json', JSON.stringify({ levels: 'tile '.repeat(25_000) }));

    const report = await runBloatCheck(root, 'Martin', 'main');
    expect(report.scanned).toBe(7);
    expect(report.duplicates).toEqual([{ reason: 'identical', paths: ['art/hero copy.png', 'art/hero.png'] }]);
    expect(report.unusedAssets).toEqual(['art/unused.png']);
    expect(report.unusedDependencies).toEqual([{ manifest: 'package.json', name: 'lodash', dev: false }]);
    // Folder notes: the big data folder has no note, and its file is too large to read whole.
    expect(report.folderNotes.map((f) => [f.kind, f.path])).toEqual([
      ['missing-note', 'data'],
      ['large-file', 'data/levels.json'],
    ]);
    expect(report).toMatchObject({ ranBy: 'Martin', branch: 'main', truncated: false });
  });

  it('lists Git LFS pointers as not pulled and records the commit and trigger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pct-bloat-'));
    dirs.push(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(join(root, 'Content/Maps'), { recursive: true });
    writeFileSync(join(root, 'Game.uproject'), '{}');
    writeFileSync(join(root, 'Content/Maps/L_Main.umap'), 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123456\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'start'], { cwd: root });

    const report = await runBloatCheck(root, 'Martin', 'main', 'merge');
    expect(report.notPulled).toEqual(['Content/Maps/L_Main.umap']);
    expect(report.trigger).toBe('merge');
    expect(report.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(report.skipped[0]).toContain('Git LFS pointer');
  });
});

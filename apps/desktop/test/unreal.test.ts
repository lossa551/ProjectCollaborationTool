import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ENGINEWIRE_COMMIT_MESSAGE, ENGINEWIRE_VERSION, addEngineWire, engineWireIgnore } from '../src/main/unreal';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pct-ew-'));
  dirs.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const init = (dir: string) => {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
};

// Git starts slowly on Windows, and the first test runs it a dozen times.
describe('adding EngineWire', { timeout: 30_000 }, () => {
  it('copies the pinned plugin into Plugins/ and keeps it out of git', async () => {
    // A stand-in for ChiR24/Unreal_mcp with the release tag.
    const upstream = temp();
    init(upstream);
    mkdirSync(join(upstream, 'plugins', 'EngineWire', 'Source'), { recursive: true });
    writeFileSync(join(upstream, 'plugins', 'EngineWire', 'EngineWire.uplugin'), '{"VersionName":"0.6.0"}');
    writeFileSync(join(upstream, 'plugins', 'EngineWire', 'Source', 'A.cpp'), '// a');
    writeFileSync(join(upstream, 'README.md'), 'not copied');
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-qm', 'release');
    git(upstream, 'tag', `v${ENGINEWIRE_VERSION}`);

    const project = temp();
    init(project);
    writeFileSync(join(project, 'Shooter.uproject'), '{}');
    writeFileSync(join(project, '.gitignore'), 'Saved/\n');
    git(project, 'add', '.');
    git(project, 'commit', '-qm', 'start');

    await addEngineWire(project, 'Shooter.uproject', pathToFileURL(upstream).href);
    expect(readFileSync(join(project, 'Plugins', 'EngineWire', 'EngineWire.uplugin'), 'utf8')).toContain('0.6.0');
    expect(existsSync(join(project, 'Plugins', 'EngineWire', 'Source', 'A.cpp'))).toBe(true);
    expect(existsSync(join(project, 'Plugins', 'README.md'))).toBe(false);
    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toContain('Plugins/EngineWire/');
    expect(git(project, 'log', '-1', '--format=%s').trim()).toBe(ENGINEWIRE_COMMIT_MESSAGE);
    expect(git(project, 'status', '--porcelain')).toBe('');

    // Again: replaced, and nothing more to commit.
    await addEngineWire(project, 'Shooter.uproject', pathToFileURL(upstream).href);
    expect(git(project, 'log', '--format=%s').trim().split('\n')).toHaveLength(2);
  });

  it('ignores the plugin where the .uproject is', () => {
    expect(engineWireIgnore('Shooter.uproject')).toBe('Plugins/EngineWire/');
    expect(engineWireIgnore('Game/Shooter.uproject')).toBe('Game/Plugins/EngineWire/');
  });
});

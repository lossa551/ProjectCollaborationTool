import { describe, expect, it } from 'vitest';
import { betaVersion, readTags, stableVersion } from '../../../.github/scripts/release-version.mjs';
import { buildKind, compareVersions, defaultChannel, newestRelease } from '../src/main/update-channel';

describe('build kinds', () => {
  it('tells releases, published betas and CI test builds apart', () => {
    expect(buildKind('0.1.36')).toBe('release');
    expect(buildKind('0.2.0-beta.41')).toBe('beta');
    expect(buildKind('0.1.0-ci.212')).toBe('test');
  });

  it('keeps a published beta on the beta channel until you choose', () => {
    expect(defaultChannel('0.2.0-beta.41')).toBe('beta');
    expect(defaultChannel('0.1.36')).toBe('stable');
    expect(defaultChannel('0.1.0-ci.212')).toBe('stable');
  });
});

describe('version order', () => {
  it('puts a beta of the next minor above the current stable and below its release', () => {
    expect(compareVersions('0.2.0-beta.40', '0.1.36')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0-beta.40', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('0.2.0-beta.40', '0.2.41')).toBeLessThan(0);
  });

  it('orders betas by number, not as text', () => {
    expect(compareVersions('0.2.0-beta.100', '0.2.0-beta.99')).toBeGreaterThan(0);
    expect(compareVersions('v0.1.10', '0.1.9')).toBeGreaterThan(0);
  });
});

describe('newest release for the beta channel', () => {
  const release = (tag_name: string, draft = false, assets = ['latest.yml']) => ({ tag_name, draft, assets: assets.map((name) => ({ name })) });

  it('picks the highest version, beta or stable', () => {
    expect(newestRelease([release('v0.1.40'), release('v0.2.0-beta.38'), release('v0.1.36')])).toBe('v0.2.0-beta.38');
    // After beta is promoted, the release outranks every beta of it.
    expect(newestRelease([release('v0.2.45'), release('v0.2.0-beta.44')])).toBe('v0.2.45');
  });

  it('skips drafts and releases still uploading', () => {
    expect(newestRelease([release('v0.2.0-beta.50', true), release('v0.2.0-beta.49', false, ['Foreus-Setup.exe']), release('v0.2.0-beta.48')])).toBe(
      'v0.2.0-beta.48',
    );
    expect(newestRelease([])).toBeNull();
  });
});

// What the repo had published when the patch started counting from 0 per minor.
const published = readTags(
  ['v0.1.3', 'v0.1.29', 'v0.1.36', 'v0.2.0-beta.37', 'v0.2.0-beta.38', 'v0.2.39'].map((tag) => `abc123\trefs/tags/${tag}`).join('\n'),
);

describe('stable release versions', () => {
  it('carries on from the releases already out in the current minor', () => {
    expect(stableVersion('0.2.0', published)).toBe('0.2.40');
    expect(stableVersion('0.2.0', readTags('v0.2.0\nv0.2.1'))).toBe('0.2.2');
  });

  it('starts the patch at 0 when the minor is bumped', () => {
    expect(stableVersion('0.3.0', published)).toBe('0.3.0');
    expect(stableVersion('1.0.0', published)).toBe('1.0.0');
    expect(stableVersion('0.1.0', [])).toBe('0.1.0');
  });

  it('is always newer than what installed apps already have', () => {
    for (const installed of ['0.1.36', '0.2.39', '0.2.0-beta.38']) {
      expect(compareVersions(stableVersion('0.2.0', published), installed)).toBeGreaterThan(0);
      expect(compareVersions(stableVersion('0.3.0', published), installed)).toBeGreaterThan(0);
    }
  });

  it('refuses to go backwards when package.json names an older minor', () => {
    expect(() => stableVersion('0.1.0', published)).toThrow(/not be newer/);
  });

  it('reads ls-remote output, peeled tags included, and ignores other tags', () => {
    expect(readTags('a\trefs/tags/v0.2.39\nb\trefs/tags/v0.2.39^{}\nc\trefs/tags/v0.2.0-ci.4\nd\trefs/tags/vnext')).toHaveLength(2);
  });
});

describe('beta release versions', () => {
  it('previews the minor after the current stable, counting from beta.1', () => {
    expect(betaVersion('0.2.0', published)).toBe('0.3.0-beta.1');
    expect(betaVersion('0.2.0', readTags('v0.2.40\nv0.3.0-beta.1\nv0.3.0-beta.2'))).toBe('0.3.0-beta.3');
    expect(betaVersion('0.1.0', readTags('v0.1.36'))).toBe('0.2.0-beta.1');
  });

  it('uses beta’s own minor when it is already ahead', () => {
    expect(betaVersion('0.2.0', readTags('v0.1.36\nv0.2.0-beta.37\nv0.2.0-beta.38'))).toBe('0.2.0-beta.39');
    expect(betaVersion('0.4.0', readTags('v0.2.50'))).toBe('0.4.0-beta.1');
  });

  it('sorts above the current stable and below the release that ships it', () => {
    const beta = betaVersion('0.2.0', published);
    expect(compareVersions(beta, '0.2.39')).toBeGreaterThan(0);
    expect(compareVersions(beta, '0.2.0-beta.38')).toBeGreaterThan(0);
    expect(compareVersions(beta, stableVersion('0.3.0', [...published, ...readTags(`v${beta}`)]))).toBeLessThan(0);
  });

  it('works before the first stable release', () => {
    expect(betaVersion('0.1.0', [])).toBe('0.2.0-beta.1');
  });
});

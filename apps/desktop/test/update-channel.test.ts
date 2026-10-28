import { describe, expect, it } from 'vitest';
import { betaVersion } from '../../../.github/scripts/beta-version.mjs';
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

  it('orders betas by run number, not as text', () => {
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

describe('beta release versions', () => {
  it('previews the minor after the current stable', () => {
    expect(betaVersion('0.1.0', 'v0.1.36', '41')).toBe('0.2.0-beta.41');
    expect(betaVersion('0.2.0', 'v0.2.50', '51')).toBe('0.3.0-beta.51');
  });

  it('uses beta’s own minor when it is already ahead', () => {
    expect(betaVersion('0.2.0', 'v0.1.36', '41')).toBe('0.2.0-beta.41');
    expect(betaVersion('0.4.0', 'v0.2.50', '51')).toBe('0.4.0-beta.51');
  });

  it('works before the first stable release', () => {
    expect(betaVersion('0.1.0', '', '3')).toBe('0.2.0-beta.3');
  });
});

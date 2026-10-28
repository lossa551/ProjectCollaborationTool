import type { UpdateChannel } from '../common/api';

// Which releases an installed app follows. Stable gets the releases from main
// (0.MINOR.PATCH). Beta also gets the prereleases built from the beta branch
// (0.NEXT.0-beta.N), whichever of the two is newer. See docs/releasing.md.

/**
 * What kind of build is running: a release from main, a beta published from
 * the beta branch, or a test installer from CI (0.x.0-ci.N) that stays as it
 * is until you press Update.
 */
export function buildKind(version: string): 'release' | 'beta' | 'test' {
  if (!version.includes('-')) return 'release';
  return /-beta\.\d+$/.test(version) ? 'beta' : 'test';
}

/** The channel to follow until you choose one: a published beta stays on beta. */
export function defaultChannel(version: string): UpdateChannel {
  return buildKind(version) === 'beta' ? 'beta' : 'stable';
}

const parse = (version: string) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4]?.split('.') ?? [] };
};

/** Semver order: negative when a is older. A prerelease sorts below its release (0.2.0-beta.9 < 0.2.0). */
export function compareVersions(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** A release as GitHub's list releases API returns it (the fields used here). */
export interface ReleaseEntry {
  tag_name: string;
  draft: boolean;
  assets?: { name: string }[];
}

/**
 * The newest release the beta channel can install: the highest version among
 * the published releases and prereleases that carry the updater's latest.yml.
 */
export function newestRelease(releases: ReleaseEntry[]): string | null {
  return releases
    .filter((r) => !r.draft && parse(r.tag_name) && (r.assets ?? []).some((a) => a.name === 'latest.yml'))
    .map((r) => r.tag_name)
    .reduce<string | null>((best, tag) => (best === null || compareVersions(tag, best) > 0 ? tag : best), null);
}

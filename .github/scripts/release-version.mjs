// Works out the version of the next release from the tags already published.
//
// Stable releases from main are MAJOR.MINOR.PATCH, with MAJOR.MINOR from
// apps/desktop/package.json. PATCH starts at 0 when MINOR is bumped and goes
// up by one per release (0.3.0, 0.3.1, ...): it is the highest published
// patch of that minor plus one, so a minor that already has releases carries
// on from them (0.2.39 is followed by 0.2.40).
//
// Betas from the beta branch preview the next MINOR, so they always sort above
// the current stable release and below the release that ships them: with
// stable at 0.2.40, betas are 0.3.0-beta.1, 0.3.0-beta.2, ..., and 0.3.0 from
// main later outranks them. If beta's package.json already names a higher
// minor, that one is used.
//
// Neither ever goes backwards: the script fails rather than print a version at
// or below a release that is already out.
//
// Usage: git ls-remote --tags origin 'v*' | node release-version.mjs <stable|beta> <package.json version>
// See docs/releasing.md.

const parse = (tag) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(tag.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), beta: match[4] === undefined ? null : Number(match[4]) };
};

const compare = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch || (a.beta ?? Infinity) - (b.beta ?? Infinity);

/** The release tags in `git ls-remote --tags` output (or plain tag names), parsed. */
export function readTags(text) {
  return text
    .split('\n')
    .map((line) => line.split('\t').pop().replace(/^refs\/tags\//, '').replace(/\^\{\}$/, ''))
    .map(parse)
    .filter(Boolean);
}

const highest = (versions) => versions.reduce((top, v) => (!top || compare(v, top) > 0 ? v : top), null);

const format = (v) => `${v.major}.${v.minor}.${v.patch}${v.beta === null ? '' : `-beta.${v.beta}`}`;

const mustBeNewest = (next, tags) => {
  const top = highest(tags);
  if (top && compare(next, top) <= 0) throw new Error(`${format(next)} would not be newer than the published ${format(top)}`);
  return format(next);
};

/** The next stable release: package.json's major.minor, patch 0 for a new minor, else one past the highest. */
export function stableVersion(packageVersion, tags) {
  const [major, minor] = packageVersion.split('.').map(Number);
  const top = highest(tags.filter((t) => t.beta === null && t.major === major && t.minor === minor));
  const next = { major, minor, patch: top ? top.patch + 1 : 0, beta: null };
  return mustBeNewest(next, tags.filter((t) => t.beta === null));
}

/** The next beta: a preview of the minor after the current stable (or beta's own, if higher), counting from beta.1. */
export function betaVersion(packageVersion, tags) {
  const [pkgMajor, pkgMinor] = packageVersion.split('.').map(Number);
  const stable = highest(tags.filter((t) => t.beta === null));
  let major = pkgMajor;
  let minor = pkgMinor;
  if (!stable) minor = pkgMinor + 1;
  // Not ahead of stable yet: preview the minor after it.
  else if (pkgMajor < stable.major || (pkgMajor === stable.major && pkgMinor <= stable.minor)) {
    major = stable.major;
    minor = stable.minor + 1;
  }
  const top = highest(tags.filter((t) => t.beta !== null && t.major === major && t.minor === minor && t.patch === 0));
  const next = { major, minor, patch: 0, beta: top ? top.beta + 1 : 1 };
  return mustBeNewest(next, tags);
}

if (process.argv[1]?.endsWith('release-version.mjs')) {
  const [kind, packageVersion] = process.argv.slice(2);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const tags = readTags(Buffer.concat(chunks).toString());
  console.log(kind === 'beta' ? betaVersion(packageVersion, tags) : stableVersion(packageVersion, tags));
}

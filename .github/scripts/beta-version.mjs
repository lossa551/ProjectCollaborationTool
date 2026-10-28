// Works out the version of a beta release built from the beta branch.
// Betas are previews of the next MINOR, so they always sort above the current
// stable release and below the release that ships them: with stable at
// 0.1.36, betas are 0.2.0-beta.N, and 0.2.x from main later outranks them.
// If beta's package.json already names a higher minor, that one is used.
// Usage: node beta-version.mjs <package.json version> <latest stable tag or ""> <run number>
// See docs/releasing.md.

export function betaVersion(packageVersion, stableTag, run) {
  const [pkgMajor, pkgMinor] = packageVersion.split('.').map(Number);
  const stable = /^v?(\d+)\.(\d+)\./.exec(stableTag ?? '');
  let major = pkgMajor;
  let minor = pkgMinor;
  if (stable) {
    const [stableMajor, stableMinor] = [Number(stable[1]), Number(stable[2])];
    // Not ahead of stable yet: preview the minor after it.
    if (pkgMajor < stableMajor || (pkgMajor === stableMajor && pkgMinor <= stableMinor)) {
      major = stableMajor;
      minor = stableMinor + 1;
    }
  } else {
    minor = pkgMinor + 1;
  }
  return `${major}.${minor}.0-beta.${run}`;
}

if (process.argv[1]?.endsWith('beta-version.mjs')) {
  const [packageVersion, stableTag, run] = process.argv.slice(2);
  console.log(betaVersion(packageVersion, stableTag, run));
}

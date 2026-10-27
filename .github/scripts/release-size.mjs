// Judges how big a release is from what changed since the last one, and
// prints a short Markdown summary for the top of the GitHub release notes.
// Input: the JSON of GitHub's compare API (previous release tag...this commit).
// Usage: node release-size.mjs compare.json
// See docs/releasing.md for what small, medium and large mean.
import { readFileSync } from 'node:fs';

// Generated files would make every dependency bump look large.
const IGNORED = [/(^|\/)package-lock\.json$/, /\.(png|jpe?g|gif|ico|svg)$/i];

export function releaseSize(compare) {
  const files = (compare.files ?? []).filter((f) => !IGNORED.some((re) => re.test(f.filename)));
  const lines = files.reduce((sum, f) => sum + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  // Merge commits name the PR on the first line and carry its title after a blank line.
  const prs = (compare.commits ?? [])
    .map((c) => c.commit.message.match(/^Merge pull request #(\d+)[^\n]*\n\n([^\n]*)/))
    .filter(Boolean)
    .map(([, number, title]) => ({ number: Number(number), title }));
  const fixes = prs.filter((pr) => /^fix/i.test(pr.title)).length;
  const features = prs.length - fixes;
  // Mostly by lines changed; many feature PRs at once count as large too.
  const size = lines >= 2000 || features >= 3 ? 'large' : lines >= 300 ? 'medium' : 'small';
  return { size, lines, files: files.length, prs: prs.length, features, fixes };
}

export function summary({ size, lines, files, prs, features, fixes }) {
  const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
  const what = prs === 0 ? 'no merged pull requests' : `${plural(prs, 'pull request')}: ${plural(features, 'feature or change', 'features or changes')}, ${plural(fixes, 'fix', 'fixes')}`;
  return `**Release size: ${size}** (${plural(lines, 'line')} changed in ${plural(files, 'file')}; ${what})\n`;
}

if (process.argv[2]) {
  process.stdout.write(summary(releaseSize(JSON.parse(readFileSync(process.argv[2], 'utf8')))));
}

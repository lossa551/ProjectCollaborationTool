# Releasing

Every merge to `main` that touches code ships a release. The Release workflow
(`.github/workflows/release.yml`) runs the tests on Windows, builds the
installer, and publishes it as a GitHub Release. Installed apps find it there
and offer the update. Changes to docs only (`docs/**`, `*.md`) do not release.

If the workflow fails (say, a test), nothing is published. The next release
that passes includes everything merged since the last published one.

## Version numbers

Versions look like `0.MINOR.PATCH`.

- **PATCH is automatic.** It is the Release workflow's run number, so it always
  goes up and nobody edits it. Failed runs use up a number, so gaps are normal.
- **MINOR is bumped by hand, once per finished Roadmap milestone.** Change the
  `version` in `apps/desktop/package.json` (only major and minor count there) in
  the PR that finishes the milestone.
- **1.0 is kept for the first real game project made with the app.** Until
  then we stay on 0.x.

Planned next bump: **0.2.0 when game engine support lands**, starting with
Godot and Summer Engine (#10). Not before.

## Beta branch

Work that cannot be tested yet (first: Unreal Engine support, #11) goes to the
long-lived `beta` branch instead of `main` (Martin, 2026-10-28). Its pull
requests target `beta`.

- **Nothing on `beta` is released.** The Release workflow only runs on pushes
  to `main`, so installed apps never see beta work. Do not start the Release
  workflow by hand on `beta`. CI still runs on every pull request, `beta`
  ones included.
- **Keep it current.** Merge `main` into `beta` (a merge, not a rebase) when
  `main` moves, so promotion stays a clean merge.
- **Promote** once the beta work has been tested: open a pull request from
  `beta` to `main` and merge it. That push to `main` ships it as a normal
  release; bump MINOR in the same PR if it finishes a milestone.

There is no beta channel in the app's updates: everyone gets every release
from `main`. To try `beta` on your PC, use one of these.

**Beta installer (no tools needed).** Every push to `beta` and every pull
request builds a Windows installer. On GitHub open Actions → CI, pick the
latest run on `beta`, and download `windows-installer` under Artifacts (you
must be signed in). Unzip it and run it. It installs over Foreus and uses the
same data folder, so your sessions and settings carry over. Its version reads
`0.x.0-beta.N` in Settings → Versions. A beta build does not update itself;
press Update when you want the released version back.

**From the clone (for quick changes).** Quit Foreus first (tray icon → Quit):
both use the same data folder and only one can run at a time.

```
cd C:\Users\lossa\ProjectCollaborationTool
git fetch origin
git checkout beta
git pull
npm ci
npm run desktop
```

Go back with `git checkout main` and start the installed Foreus again.

Beta and released builds can be mixed in one session as long as the protocol
version (Settings → Versions) is the same on both PCs.

## Release notes

GitHub writes the notes from the merged pull requests (`--generate-notes`), so
a clear PR title is the release note. The workflow adds one line on top with
the release's size.

### Release size

The size line is worked out by `.github/scripts/release-size.mjs` from what
changed since the last published release (lockfiles and images left out):

| Size   | Lines changed       | Typical content                      |
| ------ | ------------------- | ------------------------------------ |
| small  | under 300           | a fix or a small tweak               |
| medium | 300 to 2,000        | one feature or a handful of fixes    |
| large  | 2,000 or more       | a big feature, or several at once    |

Three or more pull requests that are not fixes in one release also count as
large. A pull request counts as a fix when its title starts with "Fix".

Size helps, but it does not decide the MINOR bump on its own: the milestone
does. Use it as a check. A string of large releases with no milestone finished
may mean the milestone is too big and should be split; a milestone that only
ever produced small releases may not deserve its own MINOR. Claude can also
judge a release by reading its PRs and the issues they close, which catches
what line counts miss (a one-line fix to sync can matter more than a new
screen).

## Versions inside the app

Settings shows three numbers under **Versions**:

- **App**: the installed release, as above.
- **Protocol** (`PROTOCOL_VERSION` in `packages/shared/src/protocol.ts`): what
  the app speaks to the session host. Both PCs must have the same one, or the
  host turns the other away with "Update the app". Bump it whenever a change to
  the messages would confuse an older app.
- **Database** (`SCHEMA_VERSION` in `packages/server/src/sqlite.ts`): the layout
  of the session file. Bump it with a migration step whenever the stored data
  changes; older files are upgraded when the host opens them, and a newer file
  refuses to open in an older app.

Protocol and database numbers move independently of the app version.

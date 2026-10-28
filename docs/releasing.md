# Releasing

Every merge to `main` that touches code ships a release. The Release workflow
(`.github/workflows/release.yml`) runs the tests on Windows, builds the
installer, and publishes it as a GitHub Release. Installed apps find it there
and offer the update. Changes to docs only (`docs/**`, `*.md`) do not release.

Every push to `beta` that touches code ships a **beta release** the same way,
published as a GitHub prerelease. Only apps on the Beta update channel take it
(see [Update channels](#update-channels)).

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

- **Every push to `beta` publishes a beta release**, a GitHub prerelease that
  is never marked as GitHub's latest release, so apps on Stable never see it.
  If its tests fail, nothing is published. Starting the Release workflow by
  hand on `beta` publishes a beta too.
- **Keep it current.** Merge `main` into `beta` (a merge, not a rebase) when
  `main` moves, so promotion stays a clean merge. This is also how beta
  testers get fixes from `main`: a stable release sorts below the current
  beta, so they only see it once it is merged into `beta` and a new beta ships.
- **Promote** once the beta work has been tested: open a pull request from
  `beta` to `main` and merge it. That push to `main` ships it as a normal
  release. **Bump MINOR in that PR** to the minor the betas previewed (0.2
  for 0.2.0-beta.N): then the release (say 0.2.40) outranks every beta of it,
  beta testers get it too, and the next betas move on to 0.3.0-beta.N.
  Without the bump the release would be 0.1.x, below the betas, and beta
  testers would stay on the last beta.

## Update channels

Settings → Versions → **Update channel** picks which releases this PC gets.
It is kept per PC.

- **Stable** (the default): releases from `main` only.
- **Beta**: the newest of all releases, beta or stable, by version. The app
  reads GitHub's release list for this, because GitHub's own feed would only
  offer whichever release was published last.

Switching to Beta asks first and then looks for the newest beta at once.
Switching back to Stable from a beta build goes back down to the latest
stable release (downloaded in the background; restart to install). A session
hosted on a beta may use a newer database layout that stable cannot open
until stable catches up, and both PCs in a session still need the same
protocol, so a friend joining a beta host may need Beta too.

An app installed from a beta release starts on Beta; any other starts on
Stable.

## Trying beta without updating

**Test installer (no tools needed).** Every pull request and every push to
`beta` also builds a Windows installer in CI. On GitHub open Actions → CI, pick
the run, and download `windows-installer` under Artifacts (you must be signed
in). Unzip it and run it. It installs over Foreus and uses the same data
folder, so your sessions and settings carry over. Its version reads
`0.x.0-ci.N` in Settings → Versions. A test build does not update itself;
press Update when you want the newest version of your update channel back.

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

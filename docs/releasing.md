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

- **PATCH is automatic and restarts at 0 with each MINOR.** The first release
  of a minor is `0.3.0`, then `0.3.1`, `0.3.2`, ... one per published release,
  with no gaps (a run that fails publishes nothing and uses up no number).
  The Release workflow works it out from the release tags already on GitHub
  (`.github/scripts/release-version.mjs`): the highest patch of the current
  minor plus one, or 0 if the minor has none yet. Nobody edits it.
- **MINOR is bumped by hand, once per finished Roadmap milestone.** Change the
  `version` in `apps/desktop/package.json` (only major and minor count there) in
  the PR that finishes the milestone.
- **1.0 is kept for the first real game project made with the app.** Until
  then we stay on 0.x.

**0.2 is game engine support**: Godot and Summer Engine (#10) plus Unreal
(#11), promoted from `beta` in PR #79.

**0.3 is token spend and bloat control** (#88-#94): context trimming and
continuing in a new chat, the memory token budget, a fixed system prompt per
turn, shorter repeated file reads, the prompt cache share per chat, the wider
bloat check and the cheapest-model notes agent. Promoted from `beta`; the next
bump is 0.4.0.

### Why 0.2 starts at 0.2.39

Until 2026-10-28 the patch was the Release workflow's run number, which only
ever went up across minors (0.1.36, then 0.2.39). 0.2.39 is already out, so
0.2 carries on from it: the next stable release is 0.2.40, then 0.2.41, and so
on. Restarting at 0.2.1 would sort below 0.2.39, so apps on 0.2.39 would never
update. Published releases are never deleted or renumbered. The clean scheme
shows from the next minor: 0.3.0, 0.3.1, ...

The version can never go backwards: the workflow refuses to publish a
version at or below the newest stable release already out (say, if
`package.json` names an older minor by mistake), and fails instead.

## Beta branch

Work that cannot be tested yet (first: Unreal Engine support, #11) goes to the
long-lived `beta` branch instead of `main` (Martin, 2026-10-28). Its pull
requests target `beta`.

- **Every push to `beta` publishes a beta release**, a GitHub prerelease that
  is never marked as GitHub's latest release, so apps on Stable never see it.
  Betas preview the next minor and count from 1: with stable at 0.2.x they are
  0.3.0-beta.1, 0.3.0-beta.2, ... They sort above every 0.2.x and below
  0.3.0. (The two betas before this scheme were 0.2.0-beta.37 and -beta.38;
  0.3.0-beta.1 still sorts above them.)
  If its tests fail, nothing is published. Starting the Release workflow by
  hand on `beta` publishes a beta too.
- **Keep it current.** Merge `main` into `beta` (a merge, not a rebase) when
  `main` moves, so promotion stays a clean merge. This is also how beta
  testers get fixes from `main`: a stable release sorts below the current
  beta, so they only see it once it is merged into `beta` and a new beta ships.
- **Promote** once the beta work has been tested: open a pull request from
  `beta` to `main` and merge it. That push to `main` ships it as a normal
  release. **Bump MINOR in that PR** to the minor the betas previewed (0.3
  for 0.3.0-beta.N): then the release (0.3.0) outranks every beta of it,
  beta testers get it too, and the next betas move on to 0.4.0-beta.1.
  Without the bump the release would be 0.2.x, below the betas, and beta
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
`0.x.0-ci.N` in Settings → Versions, where x is the minor in `package.json`
and N the CI run number; it sorts below every release of that minor, so
Update always moves it on to a real release. A test build does not update itself;
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

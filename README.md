# <img src="docs/logo.svg" width="32" height="32" alt=""> Foreus

Foreus (called Project Collaboration Tool before) is a Windows desktop app
where two developers and their AI agents work on the same project in one live
session: shared task board, locks, presence, GitHub status
and agent chat. Design notes live in [docs/design](docs/design).

## Features

### Shared session
- **Host or join** a session from the app with an invite code; it runs on the host's PC and others connect over Tailscale.
- **As many people as you like**: anyone with the invite code can join, and there is no cap on people or agents. It is built for a small team, and the tests run with up to three people at once.
- **Live presence**: Who is here shows each person and agent and what they are working on right now.
- **Home** gives the overview: who is doing what, what needs you, the current milestone, and unlinked GitHub issues.
- **Resume, backups and snapshots**: sessions are saved, backed up daily, and can be restored or snapshotted before a big change.
- **Works offline**: tasks can be edited while the host is away and sync when it is back.
- **Invites you control**: make a new invite code if one leaks, or remove someone from the session.

### Board and locks
- **Task board** with five stages, drag to move, assign to a person or an agent, and set the paths a task may touch.
- **Search and filters** (Mine, Agents, Blocked, Unverified) to find work fast.
- **File locks**: exclusive for files that cannot be merged, soft for the rest, and abandoned locks can be recovered.
- **Overlap warnings** when two people, a pull request or a lock touch the same file, or work strays outside a task's paths.

### Agents
- **Any model or CLI agent**: Claude, DeepSeek, OpenAI, local models through Ollama, any OpenAI-compatible API, Claude Code and Codex CLI.
- **Shared agent chats** where both of you talk to the same agent, and approval cards for anything that needs a person.
- **Same rules as people**: every edit and command is checked against locks, allowed paths and approval rules, and agents lock files themselves.
- **Own copy of the project** for each agent chat (a git worktree), so agents never touch your folder or each other's work.
- **Hand-offs** turn a chat into a task or pass it to another agent with the plan, decisions, paths and acceptance criteria.
- **Cost and budgets**: token and cost tracking per agent, chat and task, with budgets that ask before going further. Each chat shows per day how much of its input was uncached, read from the prompt cache or written to it, with a hint when the cache keeps breaking. Prices can have a long-prompt tier (Haiku 5.5 past 100k tokens), applied per model call.
- **Small contexts**: long agent chats shorten old tool results on their own, show how big the context is, and past 100k tokens offer to **continue in a new chat** that gets a handoff and the chat's files instead of the whole conversation. An agent's instructions stay fixed for a whole turn, so the provider's prompt cache keeps working; a task, memory or note change made meanwhile reaches the agent as a short update after its next tool results. Agents read files 400 lines at a time; reading the same part again only says it is unchanged, or shows just the lines that changed since, and the context panel counts the reads saved.

### Review and undo
- **Review an agent's changes**: see the diff, merge it into your branch, push and open a pull request, or discard it.
- **Undo an agent turn** or go back to an earlier point in the chat; every turn that changes files is a checkpoint.
- **Branch a chat** to try another direction from any message: the conversation and the agent's files both go back to that point, while the original chat keeps going.

### Planning and memory
- **Planning space** for notes, feature ideas, requirements, dependencies and tasks, tracked from plan to done.
- **Roadmap** with milestones (Now, Next, Later or your own), dates and risk warnings.
- **Acceptance criteria and test results** on each task, so you can see what is ready, blocked or still unverified.
- **Project memory** for decisions, conventions and known issues, also written to `docs/project-memory.md` for CLI agents. Agents get it within a 4k-token budget (conventions and decisions first, entries about their task before the rest); entries past it go by title and are read on demand. The Memory page shows what every agent call carries, and finished plans or fixed issues can be **archived**: kept in the record, no longer sent.
- **Folder notes** that an agent drafts and keeps up to date for you to review.
- **Bloat check** that lists duplicate files, copied-and-tweaked code (with the share in common), unused assets, unused Godot add-ons and Unreal plugins, unneeded dependencies and large files. It runs by itself when main or beta gets new commits in your folder and once a day, marks what is new since the scan before, and lists Git LFS files that are not pulled instead of skipping them silently.
- **Duplicate question at review**: when a task moves to review, its reviewing agent reads the change and the folder notes and says whether it adds a system, helper or asset that already exists; the answer shows on the task (and as "May duplicate" on its card).

### GitHub
- **Status on the cards**: branches, pull requests, checks, reviews and merge conflicts.
- **Everyday git in the app**: clone, pull, commit, push and switch branches, with locks freed after a commit. Switching asks first when you have uncommitted changes or hold locks, and branches an agent chat is working on are left out.
- **First commit for empty repositories**: a new, empty repository gets an offer (on the GitHub page, in agent chats and in setup) to make the first commit with a README, a .gitignore and setup's agent rules, and push it, so agent chats can get their own copy.
- **Commit message drafts** written by an agent from your diff and the task.
- **Issues** in the app: link them to features and tasks, make features from them, and close them when the work is done.

### Engines and project setup
- **Set up project** detects Unreal, Godot, Summer Engine or a generic project and adds `.gitignore`, Git LFS, lock rules and agent rules (`AGENTS.md`).
- **Godot and Summer Engine**: agents work in the engine through its MCP server, with scene changes going through locks and approvals.
- **Editor plugin** for Godot with a Locks dock and a warning when the scene you open is locked by someone else.
- **Engine tests**: agents run GUT or gdUnit4 tests headless and record the results on the task.
- **Unreal** (#11) is next; see `docs/design/engines.md`.

### Notifications and updates
- **Windows notifications** for approvals, finished or stuck agents, lock waits and failing checks; click one to open it, mute any kind.
- **Automatic updates** from GitHub Releases with a Restart to update button, on a Stable or Beta update channel.

## Layout

| Path | What it is |
| --- | --- |
| `packages/shared` | Data model (participants, tasks, locks), the WebSocket protocol, invite codes, and `SessionClient`, which any client (app, agent runner, test) uses to join a session. |
| `packages/server` | Session server (Node + `ws`). Runs inside the desktop app when you host, or on its own on a server. Storage sits behind an interface: in memory for now, SQLite next, Postgres when hosted. |
| `packages/agents` | Runs agents on the PC that started them: our own agent loop for model APIs, Claude Code and Codex run headless, and the guard that checks every edit and command against locks, scope and approvals. |
| `apps/desktop` | Electron app. The main process owns the connection and, when hosting, the server; the window is React, built with Vite. |

## Install

Download `Foreus-Setup-<version>.exe` from the latest
[release](https://github.com/lossa551/ProjectCollaborationTool/releases/latest)
and run it. It installs for your Windows user (no admin rights needed) and
opens the app. The installer is not code-signed yet, so Windows SmartScreen
may say it protected your PC: click **More info**, then **Run anyway**.

Everything happens in the app: **Host session** starts the session server on
your PC and shows the invite code to send; **Join session** takes a code.
Sessions you hosted or joined are listed under **Resume a session** on the
start screen: **Resume** hosts one again with its board, invite code, GitHub
link and project folder as you left them, and **Rejoin** uses the saved
invite code. Each project is its own entry, even when one PC hosts several,
and a hosted session keeps its port (7420, or the next free one) so its
invite code stays the same. Only one session is open at a time. The app warns
you when you pick a project folder another session already uses, since the
two sessions' locks don't see each other.

Sessions you host are backed up when you host them and once a day while
hosting; the last 7 daily backups are kept in the app's data folder (or a
folder you pick under the Resume list, say in OneDrive or on another drive).
**Restore…** on a hosted session lists its backups and puts the board,
planning space, project memory, agents and chats back to how they were; what
the session held before is saved as a backup first. Before a big change, the
host can click **Snapshot** at the top of the window: a named copy that is
never deleted automatically and shows up in the same Restore list, optionally
with a git tag on the commit checked out in your project folder (local; push
tags to share it). On the Project memory
page, **Write to docs/project-memory.md** puts every entry in your project
folder as Markdown, and keeps it up to date as entries change, so it goes
into git with the code and CLI agents that read repo files see it.

Updates download in the background from GitHub Releases. When one is ready,
Windows shows a notification and the button at the top of the window says
**Restart to update**; until then it
shows your version and can check again. If you are hosting, restarting ends
the session until you host again. Settings → Versions → **Update channel**
switches this PC between Stable releases and Beta previews from the `beta`
branch, and back.

## Develop

Needs Node 22.13 or newer.

```sh
npm install
npm run desktop     # app with live reload of the window
npm test            # unit and server integration tests
npm run typecheck
npm run build
```

Run a standalone server (for a hosted machine, or to test without the app):

```sh
npm run server
```

It prints an invite code. The session (board, locks, activity, who has joined)
is saved in `packages/server/data/session.sqlite`, so it and the invite code
survive restarts. Settings are environment variables: `PCT_PORT` (7420),
`PCT_HOST` (0.0.0.0), `PCT_DB` (path of the SQLite file, or `:memory:` to keep
nothing), `PCT_SECRET` (generated once and saved if unset),
`PCT_SESSION_NAME`, `PCT_PUBLIC_HOST` (address to put in the invite), and
`PCT_TLS_KEY` / `PCT_TLS_CERT` to serve `wss://`. For GitHub status it uses
`PCT_GITHUB_TOKEN` (or `GITHUB_TOKEN`, or the GitHub CLI's token if you are
signed in to `gh`); without a token it still works for public repositories but
only checks every 10 minutes.

When you host from the app instead, each session is saved in its own file in
the app's data folder (`%APPDATA%\Foreus\hosted\` on
Windows, or `%APPDATA%\Project Collaboration Tool\hosted\` for an install
from before the rename, which keeps its old data folder; a session hosted before the list existed stays in
`hosted-session.sqlite`), so resuming it brings back the same board and invite
code. The list itself is `sessions.json` in the same folder. The host's GitHub token is
set under **Locks and GitHub** and stored encrypted on that PC; the friend
needs no token, since the server sends everyone the same GitHub status. The
Git actions on that page sign in to github.com with the token saved in the app
(or the GitHub CLI's) when there is one, and otherwise with git's own sign-in
(Git Credential Manager on Windows). Pushing needs a token with write access
to contents; if GitHub refuses the token, git's own sign-in is tried. Opening
and closing issues uses the host's token too and needs "Issues: read and
write" on it; reading them needs nothing new.

## Playing together over Tailscale

1. Both install [Tailscale](https://tailscale.com) and join the same tailnet
   (the host shares their machine with the friend).
2. Host clicks **Host session**. The invite uses the host's Tailscale
   address automatically. Windows may ask to allow the app through the
   firewall; allow it on private networks.
3. Host sends the invite code privately; the friend pastes it under **Join a
   session**.

Traffic over Tailscale is already encrypted, so plain `ws://` is fine there.
Use the TLS settings when the server is reachable on the open internet. The
invite code contains the session secret: anyone with it can join. If it
leaks, **New invite code** in the Invite popover replaces it: people who
joined before stay in and their Rejoin keeps working, anyone holding only the
old code is refused. The host can also **Remove…** someone from Who is doing
what on Home: they and their agents are disconnected, their locks are freed,
and their saved invite stops working until they get a new code.

## Releasing a new version

Every push to `main` (except docs-only changes) publishes a new release: the
Release workflow builds the installer on Windows and puts it on GitHub
Releases. Installed apps check every 15 minutes, download it, show a Windows
notification and turn the button into **Restart to update**. Every push to
`beta` publishes a prerelease (`0.NEXT.0-beta.N`) that only apps on the Beta
channel take; see [docs/releasing.md](docs/releasing.md).

The version is the major.minor from `apps/desktop/package.json` plus a patch
that starts at 0 for each new minor and counts up by one per release, for
example `0.3.0`, `0.3.1`. Change major or minor there when you want a bigger
step; the last number counts up on its own.

Every PR also builds the installer; download it from the CI run's artifacts to
try a change before merging. To build one locally on Windows:
`npm run package -w @pct/desktop` (output in `apps/desktop/release`).

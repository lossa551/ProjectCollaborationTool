# <img src="docs/logo.svg" width="32" height="32" alt=""> Foreus

Foreus (called Project Collaboration Tool before) is a Windows desktop app
where two developers and their AI agents work on the same project in one live
session: shared task board, locks, presence, GitHub status
and agent chat. Design notes live in [docs/design](docs/design).

Working so far: hosting a session on your PC or joining one by invite code,
live presence, a shared task board (five stages, drag to move, assign to a
person or agent, allowed paths, activity feed, search with Mine / Agents /
Blocked / Unverified filters; empty columns shrink), and file locks (exclusive for
files matching the lock rules, soft for the rest, abandoned locks can be
recovered). Sessions are saved, everyone keeps the same identity across
reconnects, and tasks can be edited while the host is offline (changes sync
when it is back). GitHub status: link the repository and see branches, pull
requests, checks, reviews and merge conflicts on the task cards; each person
picks their project folder so others see their branch and changed files,
whether those stay inside the task's allowed paths, and where two people (or a
pull request or a lock) touch the same file. The GitHub page also runs
everyday git for your own copy with the git on your PC: clone the linked
repository into a folder (it becomes your project folder), pull, commit, push,
and switch or create branches. After a commit it offers to release your locks
on files with nothing left to commit, and frees the committed files' locks of
idle agents on your PC that work in your project folder. Draft it next to
the commit message has an agent you pick write the message from your
uncommitted diff and the branch's task; you edit it and commit yourself, and
the call counts in the agent's and the task's cost. Issues: the repository's open issues show on
the Code screen's Issues tab, filtered by label and assignee; link one to a
feature or task (or write `#123` in its text), make a feature from an issue, or
open an issue from a feature. When a linked feature is done the app offers to
close the issue with a comment naming its pull requests, and only closes it
once you confirm. Home lists issues nobody has linked or triaged. Agents: set up agents for a model
API (Claude, DeepSeek, OpenAI, a local model through Ollama, or any
OpenAI-compatible API) or a command-line agent (Claude Code, Codex CLI), start
them on your PC, and chat with them together in shared agent chats. Every edit
and command an agent makes is checked against locks, its allowed paths, the
task's paths and its approval rules; anything that needs a person shows an
approval card in the chat. Agents lock each file themselves before their first
edit (tagged with the chat and task), wait when someone else holds a file they
need, free locks on files they did not change when a turn ends, and free a
task's locks when it is done; people can release an agent's lock any time.
Each agent chat works in its own copy of the project (a git worktree on an
`agent/...` branch, in a `<project>-agents` folder next to yours), so an agent's
edits never touch your own folder or another agent's copy. The chat shows what
the copy changed; on the PC that holds it you can review the diff, merge it
into your branch, push it and open a pull request, or discard it.
What each agent is doing right now shows under Who is here, on its task card
and at the top of its chat. Chats can become tasks and hand work to another
agent with the plan, decisions, paths and acceptance criteria. Project
setup: make the project with its engine first (Unreal launcher, Godot or the
`summer` CLI), then Set up project (bottom left, or the Home checklist) detects
Unreal, Godot (Summer Engine projects are Godot projects) or a generic project and offers its preset item by item:
`.gitignore` lines, Git LFS in `.gitattributes`, engine lock rules for the
session, bloat check skips in `.collab-tool.json`, a starter project memory
entry with `docs/project-memory.md` kept up to date, the agent rules in a
marked block of the root `AGENTS.md` (the Unreal preset names Epic's UE 5.8
folder structure, asset naming, coding standard and source control pages as
the source of truth) and a `CLAUDE.md` that imports it. An agent drafts the
first folder notes, and everything goes into one commit. Running it again only
shows what is missing or out of date. From then on that agent keeps folder
notes up to date by itself: stale or missing notes are drafted for people to
review on the Folder notes tab. For Godot and Summer Engine projects, setup
can also add the app's editor plugin: a Locks dock in the editor, a warning
when the scene you open is locked by someone else, and Lock this scene.
Agents act in the engine through the Godot MCP server (headless Godot on
their own copy) or Summer Engine's (the editor that has your project open),
picked on their own: Summer's while Summer Engine is open, Godot's otherwise
(Settings, Game engine, to choose yourself). Home shows when Godot or Summer
Engine has your project open, warns when the scene you opened is locked by
someone else, finds Godot from the editor you run, and adds the Locks plugin
in one click. The app runs that server itself and checks every
call: scene and resource changes take locks and follow task paths and
approvals like file edits, playing the game asks like a command, and Summer's
stale overwrite refusals show in the chat. With Godot's path set and GUT or
gdUnit4 in the project, agents run the tests headless and record the results
on the task's acceptance criteria. The bloat check follows what a Godot game
loads (`res://`, `uid://`, `class_name`) and lists scenes, scripts and assets
nothing reaches. Unreal (#11) is next; see `docs/design/engines.md`.

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
invite code.

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
the session until you host again.

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
notification and turn the button into **Restart to update**.

The version is the major.minor from `apps/desktop/package.json` plus the
workflow's run number, for example `0.1.12`. Change major or minor there when
you want a bigger step; the last number counts up on its own.

Every PR also builds the installer; download it from the CI run's artifacts to
try a change before merging. To build one locally on Windows:
`npm run package -w @pct/desktop` (output in `apps/desktop/release`).

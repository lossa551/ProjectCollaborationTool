# Project Collaboration Tool

A Windows desktop app where two developers and their AI agents work on the same
project in one live session: shared task board, locks, presence, GitHub status
and agent chat. Design notes live in [docs/design](docs/design).

Working so far: hosting a session on your PC or joining one by invite code,
live presence, a shared task board (five stages, drag to move, assign to a
person or agent, allowed paths, activity feed), and file locks (exclusive for
files matching the lock rules, soft for the rest, abandoned locks can be
recovered). Sessions are saved, everyone keeps the same identity across
reconnects, and tasks can be edited while the host is offline (changes sync
when it is back). GitHub, agents and engine integrations come next; see the
GitHub issues.

## Layout

| Path | What it is |
| --- | --- |
| `packages/shared` | Data model (participants, tasks, locks), the WebSocket protocol, invite codes, and `SessionClient`, which any client (app, agent runner, test) uses to join a session. |
| `packages/server` | Session server (Node + `ws`). Runs inside the desktop app when you host, or on its own on a server. Storage sits behind an interface: in memory for now, SQLite next, Postgres when hosted. |
| `apps/desktop` | Electron app. The main process owns the connection and, when hosting, the server; the window is React, built with Vite. |

## Install

Download `ProjectCollaborationTool-Setup-<version>.exe` from the latest
[release](https://github.com/lossa551/ProjectCollaborationTool/releases/latest)
and run it. It installs for your Windows user (no admin rights needed) and
opens the app. The installer is not code-signed yet, so Windows SmartScreen
may say it protected your PC: click **More info**, then **Run anyway**.

Everything happens in the app: **Host session** starts the session server on
your PC and shows the invite code to send; **Join session** takes a code.

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
`PCT_TLS_KEY` / `PCT_TLS_CERT` to serve `wss://`.

When you host from the app instead, the session is saved in the app's data
folder (`%APPDATA%\Project Collaboration Tool\hosted-session.sqlite` on Windows), so hosting
again brings back the same board and invite code.

## Playing together over Tailscale

1. Both install [Tailscale](https://tailscale.com) and join the same tailnet
   (the host shares their machine with the friend).
2. Host clicks **Host on this PC**. The invite uses the host's Tailscale
   address automatically. Windows may ask to allow the app through the
   firewall; allow it on private networks.
3. Host sends the invite code privately; the friend pastes it under **Join a
   session**.

Traffic over Tailscale is already encrypted, so plain `ws://` is fine there.
Use the TLS settings when the server is reachable on the open internet. The
invite code contains the session secret: anyone with it can join.

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

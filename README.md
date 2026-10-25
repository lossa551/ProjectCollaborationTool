# Project Collaboration Tool

A Windows desktop app where two developers and their AI agents work on the same
project in one live session: shared task board, locks, presence, GitHub status
and agent chat. Design notes live in [docs/design](docs/design).

This is the starting code (step 1 of the plan): the app, the session server and
the shared package, with hosting, joining by invite code and live presence
working end to end. Tasks, locks, GitHub, agents and engine integrations come
next; see the GitHub issues.

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
the button at the top of the window says **Restart to update**; until then it
shows your version and can check again. If you are hosting, restarting ends
the session until you host again.

## Develop

Needs Node 22.12 or newer.

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

It prints an invite code. Settings are environment variables: `PCT_PORT`
(7420), `PCT_HOST` (0.0.0.0), `PCT_SECRET` (generated each start if unset),
`PCT_SESSION_NAME`, `PCT_PUBLIC_HOST` (address to put in the invite), and
`PCT_TLS_KEY` / `PCT_TLS_CERT` to serve `wss://`.

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

1. Bump `version` in `apps/desktop/package.json` (for example to `0.2.0`) and
   merge that to `main`.
2. Tag the commit and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.

The Release workflow builds the installer on Windows and publishes it as a
GitHub Release, which installed apps pick up. Every PR also builds the
installer; download it from the CI run's artifacts to try a change before
releasing. To build one locally on Windows: `npm run package -w @pct/desktop`
(output in `apps/desktop/release`).

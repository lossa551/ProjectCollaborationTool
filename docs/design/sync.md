# Live sync, first sketch

Decided 2026-10-25: everything goes through a server. For now Martin runs the
server on his own PC; it must also run unchanged on a hosted machine later.

## Pieces

- **Session server** (Node + TypeScript, one process). Holds the shared state,
  hands out locks, talks to GitHub, and relays events. Started either by the
  desktop app ("Host on this PC") or on its own on a server (`npm start` or a
  Docker image). Same code both ways; only the address and config differ.
- **Desktop app** (Electron + TypeScript). Always a client of a server, even
  when that server runs on the same PC. Keeps a local cache so it stays usable
  for a short disconnect.
- **Agent runners.** Each agent (API, CLI tool, local model) runs on the PC of
  the person who started it, inside that person's app, and joins the session as
  its own participant with its own identity and permissions. API keys stay on
  that PC and never go to the server.

## What syncs and how

| Data | How | Why |
| --- | --- | --- |
| Planning docs, notes, project memory | CRDT documents (Yjs) over WebSocket | Two people can type in the same doc at once and merge cleanly |
| Tasks, stages, criteria, test results | Server-owned records, changes sent as events | One source of truth, easy to audit and undo |
| Locks | Server only, with heartbeats | A lock must never be granted twice; stale heartbeats allow recovery |
| Presence (who is on what) | Ephemeral messages, not stored | Changes constantly, no history needed |
| Code and assets | Git and GitHub, not the sync server | Each person and agent works in its own branch or worktree |

The server stores its state in SQLite to start with, behind a small storage
interface so it can move to Postgres on a hosted server.

## Connecting

- Host: app starts the server, shows an invite code (address plus a session
  secret). Friend pastes it in their app.
- Hosting from a home PC needs the friend to reach it: either port forwarding,
  or a tunnel/overlay network such as Tailscale. Tailscale is the simplest
  option to try first.
- All traffic over TLS (WebSocket `wss://`). Each participant, people and
  agents, gets its own token so the server can enforce scope and approvals.

## Moving to a real server later

Run the same server package on a VPS or container, point both apps at its
address. Nothing in the app changes. Things to add then: backups, real accounts
instead of invite secrets, and running agents server-side if wanted.

## Still open

- Whether the friend reaching Martin's PC through Tailscale is OK, or port
  forwarding is preferred.
- What happens when Martin's PC (the host) is off: friend works offline and
  syncs later, or the session is simply unavailable.

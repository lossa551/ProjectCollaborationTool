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

## Decided 2026-10-25

- **Reaching the host:** Tailscale. The friend joins Martin's tailnet and
  connects to the server's Tailscale address. No router port forwarding.
- **Host offline:** clients keep working from their local cache and sync when
  the server is back.
  - Planning docs and memory: edited offline in the local Yjs copy, merged
    automatically on reconnect.
  - Tasks and comments: queued as events, sent in order on reconnect; the
    server rejects or flags any that conflict (e.g. a task moved by both).
  - Locks: cannot be granted offline. Soft locks are recorded locally and
    checked on reconnect; editing a binary asset that needs an exclusive lock
    is blocked (or warned, with a clear "unlocked edit" flag) until the server
    confirms the lock.
  - Git work is unaffected; it goes to GitHub directly.
  - The title bar shows "Offline, N changes waiting to sync".

## Offline, as built (2026-10-25)

- The app caches each joined session (board, locks, rules, activity) and the
  changes it has not sent yet, so the board shows and stays editable when the
  host is off, even after restarting the app.
- Offline you can add, rename, move and delete tasks and change their paths.
  Owners and locks wait for the server.
- On reconnect the queued changes go out in order. Each update carries the
  values the client saw; if someone else changed that field meanwhile, the
  server keeps their value and tells you which change was not applied.
  Creates carry a client-made id, so a replayed create never doubles a task.
- Soft locks recorded offline are not built yet; locking needs the server.

## GitHub status, as built (2026-10-26)

- The session links to one GitHub repository (anyone can link or unlink it;
  the link is saved with the session).
- The server polls the GitHub REST API: every 60 s with a token, every 10
  minutes without one (public repositories only, since GitHub allows 60
  anonymous requests an hour). Answers are cached by ETag, and a pull
  request's reviews and files are only fetched again when it changes. GitHub
  GraphQL was not used because it always needs a token.
- Only the host needs a token: saved in the app (encrypted with the OS key
  store), else `PCT_GITHUB_TOKEN`, else the GitHub CLI's token. Everyone gets
  the same status from the server, including in the offline cache.
- Tasks have a branch; the card shows that branch's pull request (open one
  first, else the latest closed one). Ahead/behind and changed files are only
  worked out for branches linked to a task.
- Each person's app watches the project folder they picked with git (every
  4 s): current branch, and files changed since the branch left the default
  branch, committed or not, plus untracked files. It is shared with the
  session while they are connected and dropped when they leave.
- Overlaps: the same file in two pieces of work, where a piece of work is a
  workspace, a pull request, a pushed branch, or a lock. Sources on the same
  branch (other than the default branch) or from the same person count as one.
  Overlaps between different files that depend on each other need to know the
  engine's file formats, so they come with the engine integrations.
- PR events (opened, checks failed or passed, conflicts, approved, changes
  requested, merged, closed) go into the activity feed, linked to the task
  whose branch it is.

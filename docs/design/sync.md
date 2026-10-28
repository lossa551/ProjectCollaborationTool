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
interface so it can move to Postgres on a hosted server. The host app backs
the file up with `VACUUM INTO` (a consistent copy while the server runs, after
an integrity check) on host start and once a day, keeping the last 7, and can
restore one from the start screen. Project memory is also written to
`docs/project-memory.md` in each person's project folder, rendered only from
the entries (dates in UTC) so both copies are identical and never conflict.

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
address. Nothing in the app changes. Things to add then: server-side backups, real accounts
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

## Agents and agent chat, as built (2026-10-26)

- **Agent profiles** (name, connection, responsibilities, allowed paths,
  approval rules) are stored by the server and shared, so both people see
  what every agent may do. API keys are not part of a profile: each PC keeps
  its own, encrypted with the OS key store, or reads the provider's usual
  environment variable.
- **Running an agent**: anyone presses Start; the agent joins from that
  person's app as its own participant (kind agent, with a stable identity per
  PC) and works in that person's project folder. The server lets one runner
  per agent into the session at a time.
- **Model APIs** run in our own loop with six tools (list, read, search,
  write, edit, run a command). Claude goes through the Anthropic SDK; DeepSeek,
  OpenAI, Ollama and other OpenAI-compatible APIs through the chat completions
  format.
- **Claude Code** runs headless (`claude -p`, stream-json). A PreToolUse hook
  asks the app before every tool use and is denied if the app cannot be
  reached. **Codex** has no such hook, so after each run the app checks the
  files it changed.
- **The guard**: edits to files someone else holds an exclusive lock on are
  refused; soft locks held by others ask first; edits outside the agent's or
  the task's paths (or the handoff's, without a task) follow the agent's
  rule (allow, ask, deny), as do commands. Before writing, the agent takes the
  lock the rules call for. After a command or CLI run, changed files it may
  not change are put to a person and undone unless someone keeps them.
- **Chats** are server-owned: every chat and message is shared live. Agents
  stream an answer by updating their own message; it is stored once
  finished. Only the chat's agent posts tool lines and approval cards, and
  only people decide them. When an agent leaves, its open requests expire.
- **Context panel**: the runner reports what it gave the model (role and
  rules, task, handoff, files read, conversation) with rough token counts.
- **Handoffs**: a new chat with another agent that starts from a package of
  plan, decisions, acceptance criteria, allowed paths and notes; the task
  moves to the chosen stage and is assigned to that agent if it is running.
- Not yet: plugins as a connection type, and separate worktrees per agent
  (agents share their starter's folder for now).

## Planning space, project memory and bloat check, as built (2026-10-26)

- **Shared documents**: the planning space and project memory are two Yjs
  documents (`planning`, `memory`). Each client keeps a full copy; on every
  connect it sends its state vector (`doc.sync`), the server answers with what
  the client is missing plus its own state vector (`doc.state`), and the
  client sends back what the server is missing. After that, edits go out as
  Yjs updates (`doc.update`) and are relayed to everyone (`doc.changed`). The
  server stores each document's merged state in SQLite (schema 3, `docs`
  table), saving at most once a second while people type.
- **Offline**: edits made while the server is unreachable stay in the local
  copy, which is part of the offline cache, and merge on reconnect.
- **Text fields** are Y.Text. The window sends each edit with the text it was
  made on, so an edit made just before someone else's change arrived still
  lands in the right place.
- **Features**: kind (feature, idea, note), title, description,
  requirements, dependencies, acceptance criteria and implementation tasks,
  one per line. Approving a feature creates its tasks (with allowed paths
  after a "|" and the criteria each task gets) linked by `featureId`. From
  then on the feature's stage is that of its least finished task; it is
  blocked by a failing criterion or by a dependency line naming another
  feature that is not done, and "not verified" while criteria in testing or
  done are untested.
- **Acceptance criteria and test results** are server-owned task records:
  each criterion has a state (not tested, verified, failing), evidence, who
  recorded it and when. Rewording a criterion resets it to not tested.
  Results can be recorded offline and are replayed in order. API agents
  record them with a `record_test_result` tool; CLI agents are asked to
  report them in the chat.
- **Project memory** entries (decision, convention, known issue, plan) are
  given to every agent as part of its context and listed in the context
  panel. An agent chat can be saved to memory; the entry links back to it.
- **Bloat check** runs on the PC of whoever presses it, over the files git
  sees in their project folder (ignored files left out): identical files,
  code files with the same name in different folders of one package, assets
  no text file refers to by name, and package.json dependencies nothing
  imports or runs. The report is shared with the session. Changes outside a
  task's paths are worked out live from workspaces, branches and pull
  requests. Findings can be noted as known issues in memory.
- Not yet: Unreal's binary assets in the unused-asset check, and references
  between scenes and scripts (with the engine integrations).
- **Bloat check gaps closed (issue #93, 2026-10-28).** Near-duplicate code:
  each code file becomes 6-token shingles with comments, strings and numbers
  taken out; MinHash (16 bands of 4) finds candidate pairs and pairs sharing
  60% or more are reported as "similar" with the share. Unused Godot add-ons
  (not enabled in `project.godot` and nothing outside them loads their files
  or classes) and Unreal plugins (turned off in the `.uproject`, or off by
  default and not turned on, and no enabled plugin needs them) are their own
  section. Git LFS pointers are listed as not pulled, and a check that could
  not run says why. Up to 150k files are read (text kept up to 512 MB).
  Scans also run by themselves: when main, master or beta moves to a commit
  the shared report does not have (once per head on each PC), and when the
  shared report is a day old. Each report carries the keys of findings the
  previous one did not have, shown as "New". At review, moving a task to
  review asks its reviewing agent (the feature's review pick, else the folder
  notes agent) one question with the change and the folder notes; the answer
  is stored on the task (`task.duplicates`, protocol 18).

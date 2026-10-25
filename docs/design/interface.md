# Interface design, first pass

Clickable mockup: https://claude.ai/artifact/3ZVakSiQtjYZSJoyXdMRf9 (private to Martin until shared).

The app is a Windows desktop window. Martin and a friend join the same live
session, like a multiplayer lobby. AI agents show up in the session the same way
people do: they have a presence, hold locks, own tasks and go through review.

## Shared chrome

- Title bar: project name, live sync status, avatars of everyone connected
  (people as circles, agents as dashed squares), Invite button.
- Left nav: Session board, Planning space, Locks and GitHub, Agents, Project memory.
- Bottom of nav: your own isolated workspace (branch, how many files changed,
  whether the changes are inside your task's scope).

## Screens

1. **Session board.** Tasks in five stages (Planning, Implementing, Review,
   Testing, Done). Each card shows owner (person or agent), locks, PR and
   warnings such as overlap with another task. Side panel shows who is doing
   what right now and a live activity feed.
2. **Task detail and handoff.** Stage tracker, the agreed plan with allowed and
   off-limits paths, acceptance criteria with verified / failing / not tested
   state and evidence, the diff with each file flagged in scope or outside the
   plan, a picker for which agent or person does each stage, the handoff
   package the next agent receives, and conflict warnings.
3. **Locks and GitHub.** Exclusive locks for binary assets, soft locks for
   code, heartbeat per lock with a Recover action for abandoned locks. Overlap
   detection for same file, same scene and shared-system dependencies across
   different files. Branches and PRs with checks, review and merge status.
4. **Planning space.** Features, ideas and notes; a feature doc edited live by
   both people, with requirements, dependencies and implementation tasks;
   discussion with people and agents; approve plan and create tasks.
5. **Agents.** Each agent's connection (model API, CLI tool, plugin, local
   runtime), responsibilities, allowed paths and what it needs approval for.
6. **Project memory.** Architecture decisions, conventions, known issues and
   current plans, plus a bloat check: duplicate systems, unused assets,
   unnecessary dependencies and changes outside the task.

## Open questions

- Tech stack: decided 2026-10-25, Electron + TypeScript.
- Live sync: decided 2026-10-25, central server (runs on Martin's PC for now). See sync.md.
- Engines: decided 2026-10-25, Unreal (with MCP), Godot and Summer Engine. See engines.md. Mockup example data now uses Godot file names.
- The friend's name and GitHub login.

## Project types (decided 2026-10-25)

The app works for any software project, not only games (for example a
command-line tool or a web app). Nothing in the core assumes a game engine:

- **Core, always on:** live session, tasks and stages, acceptance criteria and
  test results, planning space, project memory, agents and permissions, git
  and GitHub, locks, overlap detection, bloat check.
- **Integrations, optional per project:** game engines (Godot, Summer Engine,
  Unreal; see engines.md) and later others (for example a test runner or a
  design tool). An integration adds lock rules, editor tools for agents, a test
  runner and an asset scanner.
- **Lock rules without an integration:** soft locks on code by default, plus
  user-defined patterns for exclusive locks (for example `*.psd`, `*.sqlite`).
- **New project setup:** pick the repo, optionally pick a template (Godot game,
  Unreal game, TypeScript tool, blank), which only pre-fills integrations and
  lock patterns.

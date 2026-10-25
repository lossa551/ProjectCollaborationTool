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

- Tech stack for the desktop app.
- How live sync works: one PC hosts and the other joins, or a small relay server.
- Which game engine the game uses (the mockup assumes Unity file names).
- The friend's name and GitHub login.

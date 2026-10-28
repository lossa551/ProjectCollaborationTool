# Game engine support (optional integrations)

Decided 2026-10-25: support Unreal Engine (including its MCP), Godot, and
Summer Engine (an AI-focused engine that Summer's own comparison pages place
among engines built on Godot).

## One adapter per engine

Each engine gets an adapter inside the desktop app with the same shape:

- **Lock rules:** which file types need an exclusive lock.
- **Engine bridge:** how agents act in the editor (MCP server, plugin or CLI).
- **Test runner:** how to run the game's tests and read results back into
  acceptance criteria.
- **Asset scan:** how to find references, for the bloat check (unused assets).

Agents never talk to the engine directly. The app proxies the engine's tools,
so every engine action still goes through locks, task scope and approvals, and
is logged on the activity feed.

| Engine | Bridge for agents | Exclusive locks | Notes |
| --- | --- | --- | --- |
| Unreal Engine 5 | Unreal MCP: Epic's official plugin (UE 5.8, experimental, minimal tool set) or a third-party Unreal MCP server | `.umap`, `.uasset` (binary, never mergeable) | Fits Unreal's own "one file per actor" option to reduce map lock contention. Git LFS for binaries. |
| Godot 4 | Editor plugin shipped by this app, plus a Godot MCP server | `.tscn`, `.tres` (text but merge badly), imported binaries | GDScript and C# code use soft locks. `.godot/` cache is never committed. |
| Summer Engine | Summer's own MCP server (local server drives the engine) and the `summer` CLI | Scene files, via Summer's engine operations | Summer refuses stale overwrites and returns receipts for writes; the adapter maps those to our locks and activity feed. |

## Unreal MCP options (researched 2026-10-25)

| Server | License / cost | Connects via | Strengths | Concerns |
| --- | --- | --- | --- | --- |
| Epic official (UE 5.8) | Free, ships with engine | Plugin in editor | First-party, Epic frames MCP as core for UE 6, one undo entry per call | Experimental, minimal tool set, limited read-back, API will change |
| ChiR24/Unreal_mcp | MIT | EngineWire plugin, HTTP or Node stdio | ~400 capabilities behind one search/describe/execute tool (small context), UE 5.0-5.8, Blueprints, UMG, PIE with input + screenshots, packaging, capability token, consent for deletes | Beta (0.6), needs its plugin |
| runreal/unreal-mcp | MIT | Built-in Python remote execution, no plugin | Easy install, ~20 tools (Python, console, assets, actors, screenshots) | Small tool set, full editor access, setup can be fiddly |
| sam-david/unreal-mcp | MIT | Python + Remote Control, optional C++ bridge | 127 tools incl. build/packaging and source control, no mandatory plugin | Beta, tiny community (6 stars) |
| chongdashu/unreal-mcp | MIT | C++ plugin + Python server | Popular (~1.6k stars), Blueprint graph editing | Experimental, last updated Apr 2025, UE 5.6 unconfirmed |
| StraySpark Unreal MCP | Paid, from $129 | Plugin | Claims 455 tools, transactional multi-step undo, Blueprint read-back, auth/scope gates | Claims are vendor-written, not verified |

Decided 2026-10-25 (Martin): build the Unreal adapter on ChiR24/Unreal_mcp
now, targeting UE 5.8. Switch to (or add) Epic's official MCP later, so the
adapter is written against MCP generically with the server as a setting.

## Build order (2026-10-25)

Martin builds his own games in Godot; the shared project with his friend will
likely start in Unreal (5.8). Martin chose: Godot and Summer Engine adapters
first (Summer is Godot-based, so they share most of the work), Unreal after.

## Godot and Summer Engine adapter (#10, built 2026-10-27)

Summer Engine is built on Godot and uses its project files, so one adapter
covers both; the difference is only which MCP server the agents use.

- **Engine bridge.** The app runs the engine's MCP server itself (stdio) and
  passes its tools on: to our own agent loop as tools named `godot_*` or
  `summer_*`, and to Claude Code through `--mcp-config` (server name
  `engine`), where each call still goes through the PreToolUse hook. Codex
  has no such hook, so it gets no engine tools. Settings (per PC): Off,
  the Godot MCP server (Coding-Solo/godot-mcp, run with npx) or Summer
  Engine (`npx summer-engine@latest mcp`), and which agents get it.
- **Every call is sorted first** (packages/agents/src/engine.ts): reading the
  engine goes through; calls that change files they name (create a scene,
  add a node, set a property, write a file, project settings) are checked
  and locked like a file edit; anything else (play, run editor scripts,
  Summer's cloud operations) follows the agent's rule for commands. Files a
  call changed without naming them are reviewed afterwards, as after a
  command. A Summer dry run counts as a read.
- **Summer's answers.** A `conflict` (the file changed since it was read) is
  shown in the chat and the agent is told to read again; `needs_approval`
  shows Summer's approval link; write receipts are listed on the tool line.
- **Which folder.** The Godot MCP server runs Godot headless on whatever
  folder it is given, so the app always gives it the chat's own copy (and
  refuses Claude Code calls that name another folder). Summer drives the
  editor that has the project open, which is the person's project folder:
  agents that use Summer work there instead of in a copy. A chat that
  already has a copy is told Summer cannot reach it.
- **Agent copies and the import cache.** A new copy starts with a copy of the
  project folder's `.godot/` (without `.godot/editor/`), so Godot does not
  import every asset again. It is never committed.
- **Tests.** With Godot's path known (Settings, `GODOT_PATH` or the PATH) and
  GUT or gdUnit4 in the project, agents get `run_tests`: the tests run
  headless, the summary (passing, failing, which failed) is shown, and the
  agent records results on the task's acceptance criteria. Running them asks
  like a command. Claude Code is given the command instead.
- **Bloat check.** In a Godot project, what the game loads is followed from
  `project.godot` (main scene, autoloads, icon) through `res://` paths,
  `uid://` ids, `preload`/`load` and `class_name`; scenes, scripts,
  resources and assets nothing reaches are reported. Add-ons and test
  folders are left alone.
- **Editor plugin.** Project setup can add `addons/collab_tool/` and turn it
  on: a Locks dock in Godot and Summer Engine, a warning when the open scene
  is locked by someone else (and again if it is saved anyway), and
  Lock/Release this scene. The app writes the locks to
  `.godot/collab_tool/locks.json` and reads the plugin's requests from
  `.godot/collab_tool/requests.jsonl`.

## What happens on its own (follow-up to #10, 2026-10-27)

Martin asked for most of the engine interaction to be automatic, down to the
app reacting when someone opens the Godot editor.

- **On by default.** The engine choice is Automatic unless changed in
  Settings: with a project.godot in your folder, agents get Summer Engine's
  server while Summer Engine is open (and signed in) and the Godot MCP server
  otherwise, picked again at each agent turn. Every agent but Codex gets the
  engine; Settings keeps an opt-out per agent (`engineAgentsOff`).
- **Noticing the editor.** The Locks plugin (now 1.1) rewrites
  `.godot/collab_tool/editor.json` every 2 s while the editor has the project
  open (editor kind, program, version, pid, open scene) and removes it on
  close; five missed beats or a dead pid count as closed. Without the plugin
  the app still lists running programs every 5 s (`tasklist`, `ps`; on
  Windows a CIM query once per new process for path and command line) and
  ignores headless Godot (agents' MCP server, tests, exports).
- **Reacting.** Home gets a Game engine panel (editor open or not and on which
  scene, a red line when someone else holds that scene, what agents get, and
  one-click fixes). Toasts (kind `engine`, mutable): the editor opened the
  project while others hold locks in it, you opened a scene someone holds, or
  an editor started on a project without the plugin (once per folder per run).
  Add plugin / Update plugin writes setup's plugin item and commits only those
  files; the editor needs Project → Reload Current Project to load it.
- **Fewer manual steps.** Godot's program is taken from the editor you run
  (remembered as `foundGodotPath`), then the PATH, then usual install folders
  (Downloads, Desktop, Program Files, Steam, WinGet, Scoop). Node.js is
  checked at start and every minute while missing, with a Get Node.js button.
- **Still yours to do:** install Node.js, install Summer Engine and sign in
  once (`npx summer-engine@latest login`). Approvals are unchanged.

## Unreal Engine adapter (#11, built 2026-10-28)

Built on ChiR24/Unreal_mcp (EngineWire 0.6.0), pinned: the app runs
`npx unreal-engine-mcp-server@0.6.0` with `UE_PROJECT_PATH` set, and the
proxy reads EngineWire's capability token from `Saved/MCP/capability-token`,
so there is no token to copy. Server name and pinning live in one place
(`engineServer`), so Epic's official MCP can be added later as another bridge.

- **Bridge.** EngineWire has one MCP tool, `unreal` (search, describe,
  execute, configure), which our agent loop passes on as `unreal`; Claude Code
  gets it through `--mcp-config` as before, behind the PreToolUse hook.
  Like Summer, it drives the live editor, so agents in a worktree still act
  on the project folder (no DerivedDataCache/Intermediate copies per agent).
- **Sorting each call** (packages/agents/src/unreal.ts). search, describe and
  read-only capabilities pass. The rest map their targets (`/Game/...`
  object paths, `*Path` params for the capability's own domain, and the
  source of a move, rename or delete) to `Content/....uasset` or `.umap`
  files. Those need the agent's exclusive lock and to be in task scope; an
  asset that does not exist yet must also follow Epic's layout and naming,
  or the call is refused with the rules and asked again. Capabilities whose
  catalog effect is destructive (453 records, generated into
  unreal-capabilities.ts) need an approval naming the files. Edits with no
  named file (for example "spawn actor in the open level") are allowed and
  the files the editor reports changed are locked after.
- **Receipts.** EngineWire's `receipt.changes` lists the packages a call
  touched; the runner takes locks on them and flags any that break Epic's
  layout in the agent chat.
- **Epic's rules.** packages/shared/src/unreal.ts holds Epic's prefix table
  and the recommended structure (`Content/<Project>/` with Assets, Envs,
  Media, Sequences, Stages, StageLevels, Tools; `Content/Common`), with the
  project's folder names in `.collab-tool.json` (`unreal`). The Unreal setup
  preset's AGENTS.md cites the Epic pages (naming, project structure, coding
  standard, source control) as the source of truth. Unlisted prefixes are
  accepted, as Epic calls its list a guide.
- **Locks.** `.uasset` and `.umap` are always exclusive, whatever the
  project's own patterns say (`lockKindFor`), in the server and in the hook.
- **Tests.** `run_tests` runs `UnrealEditor-Cmd <uproject>
  -ExecCmds="Automation RunTests <filter>; Quit" -NullRHI` and reads the
  pass and fail lines back. The editor is found from the .uproject's
  EngineAssociation (launcher list, registry, Epic Games folders) or from
  the running editor.
- **Bloat check.** Assets are reachable from levels, `__External*` actors,
  Config and Source references, through the `/Game/` names in each asset's
  header. Developers and Collections folders are left alone, and an asset
  that is still a Git LFS pointer is skipped. Epic layout problems get their
  own section.
- **What happens on its own.** Automatic picks EngineWire for a folder with a
  .uproject. Home shows an Unreal panel (editor open or not, plugin state,
  engine version found). "Add EngineWire" clones the plugin at the pinned tag
  into `Plugins/EngineWire` and commits only a `.gitignore` line: the plugin
  is about 2000 third-party files, so each PC adds its own and an editor
  without it never asks for a missing plugin. A toast says when the editor
  opens the project without it.
- **Still yours to do:** the project needs a C++ target (EngineWire is a C++
  plugin Unreal builds when it opens the project), and Node.js. EngineWire's
  own compatibility record (0.6.0) says its plugin did not compile on UE 5.8
  preview 1 and was last checked on 5.7.4, so 5.8 needs a check on Martin's PC.

## Open

- Unreal: Epic's official MCP as a second bridge once it is past
  experimental; EngineWire on 5.8 once its plugin compiles there.
- Summer's write receipts and refusals are read from the answer shape in its
  docs (`ok`, `status`, `error.code`); the exact receipt fields are not
  documented, so the app looks for any path with a hash or size.


Sources: https://docs.summerengine.com/index.md,
https://www.summerengine.com/blog/summer-vs-orca-engine,
https://www.strayspark.studio/blog/epic-official-mcp-plugin-ue5-8-vs-third-party

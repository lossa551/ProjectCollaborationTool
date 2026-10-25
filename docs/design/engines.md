# Game engine support

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

## Open

- Which engine the first real game project uses, so that adapter is built first.
- Which Unreal MCP to target first: Epic's official plugin (stable owner, fewer
  tools) or a third-party server (more tools).

Sources: https://docs.summerengine.com/index.md,
https://www.summerengine.com/blog/summer-vs-orca-engine,
https://www.strayspark.studio/blog/epic-official-mcp-plugin-ue5-8-vs-third-party

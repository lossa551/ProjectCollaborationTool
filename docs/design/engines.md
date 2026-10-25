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

## Unreal MCP options (researched 2026-10-25)

| Server | License / cost | Connects via | Strengths | Concerns |
| --- | --- | --- | --- | --- |
| Epic official (UE 5.8) | Free, ships with engine | Plugin in editor | First-party, Epic frames MCP as core for UE 6, one undo entry per call | Experimental, minimal tool set, limited read-back, API will change |
| ChiR24/Unreal_mcp | MIT | EngineWire plugin, HTTP or Node stdio | ~400 capabilities behind one search/describe/execute tool (small context), UE 5.0-5.8, Blueprints, UMG, PIE with input + screenshots, packaging, capability token, consent for deletes | Beta (0.6), needs its plugin |
| runreal/unreal-mcp | MIT | Built-in Python remote execution, no plugin | Easy install, ~20 tools (Python, console, assets, actors, screenshots) | Small tool set, full editor access, setup can be fiddly |
| sam-david/unreal-mcp | MIT | Python + Remote Control, optional C++ bridge | 127 tools incl. build/packaging and source control, no mandatory plugin | Beta, tiny community (6 stars) |
| chongdashu/unreal-mcp | MIT | C++ plugin + Python server | Popular (~1.6k stars), Blueprint graph editing | Experimental, last updated Apr 2025, UE 5.6 unconfirmed |
| StraySpark Unreal MCP | Paid, from $129 | Plugin | Claims 455 tools, transactional multi-step undo, Blueprint read-back, auth/scope gates | Claims are vendor-written, not verified |

Recommendation: write the Unreal adapter against MCP generically so the server
is a setting. Default to Epic's plugin for longevity; offer ChiR24 as the
"more tools" option (needed for PIE testing and screenshots today).

## Open

- Which engine the first real game project uses, so that adapter is built first.
- Which Unreal MCP to target first: Epic's official plugin (stable owner, fewer
  tools) or a third-party server (more tools).

Sources: https://docs.summerengine.com/index.md,
https://www.summerengine.com/blog/summer-vs-orca-engine,
https://www.strayspark.studio/blog/epic-official-mcp-plugin-ue5-8-vs-third-party

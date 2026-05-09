# Warm pool isolation across MCP server instances

**Date:** 2026-05-09
**Status:** Findings — issues filed (#110 phase 1, #111 phase 2)
**Triggered by:** "we launch one warmup per claude code / codex instance ... check if this should be one process only, or if it already reuses the processing across claude code / codex / mcp instances"

## TL;DR

- **No reuse today.** Every MCP client (Claude Code window, Codex CLI invocation, Cursor, etc.) spawns its own `gemini-cli-mcp` child process via stdio. Each child instantiates its own `WarmProcessPool` singleton. Pools never communicate.
- On this machine right now: **~13 MCP server processes**, **~14 warm `gemini --yolo` workers** running in parallel. With pool size 2 and ~250–400 MB resident per worker that is **3–5 GB of RAM** held by idle pools, plus a 5 s keepalive heartbeat per worker.
- Per-instance redundancy is forced by the architecture, not a bug. Stdio MCP transport is inherently 1:1 client↔server. Sharing requires HTTP/SSE transport or an out-of-band daemon.
- **User-approved direction:** "Bound cost, don't share." Lower default footprint and document the multiplication. Architectural rework (HTTP singleton or daemon) deferred.
- **Side investigation closed:** The "doubled relaunch" workers I observed via `pgrep -af "gemini --yolo"` are exclusively from MCP servers started **before today's 06:46 npx-cache refresh**. All post-0.8.0 servers correctly inject `GEMINI_CLI_NO_RELAUNCH=true` and run 1 process per pool slot. Issue #98 contract holds in 0.8.0.

## Architecture confirmation

### Why each instance has its own pool

1. `src/index.ts:228` uses `StdioServerTransport`. MCP stdio is 1:1: each client spawns the server as a child and talks over its stdin/stdout. There is no daemon, broker, or socket.
2. `src/gemini-runner.ts:163` declares `export let warmPool: WarmProcessPool | null = null` — a module-level singleton, scoped to the Node process.
3. `src/gemini-runner.ts:219` constructs the pool exactly once at module init.
4. Multiplicity factor:
   - 1 client × 1 MCP entry → 1 server, 1 pool
   - 1 client × 2 MCP entries (e.g. `gemini` + `gemini-dev` for hands-on testing in this repo's `.mcp.json`) → 2 servers, 2 pools
   - N clients (parallel Claude Code windows, sprint mode, Codex sessions) × M entries → N×M pools

### What IS shared today

- `~/.gemini-cli-mcp/sessions.db` (SQLite) — multi-turn session state. A session started under one MCP server can be continued through another (the new server reads the same DB). This is the only cross-instance state.

### What COULD be shared (not implemented)

| Approach | Sketch | Status |
|---|---|---|
| HTTP/SSE singleton | Switch transport to `StreamableHTTPServerTransport`, leader-elect on Unix socket / 127.0.0.1, clients connect over HTTP. Stock MCP. | Deferred — significant lifecycle / auth / observability work. |
| Out-of-band pool daemon | Keep stdio MCP server thin, factor pool into a separate `gemini-cli-mcp-poold` over a Unix socket. | Deferred — adds a second binary and protocol. |
| Bound cost (chosen) | Reduce per-instance footprint, document multiplication. | **Approved.** Scope below. |

## Empirical evidence

### Current process count (snapshot at ~07:37 local)

| Group | Count | Notes |
|---|---|---|
| `npm exec @guibarscevicius/gemini-cli-mcp` parents | 8 | Each is a Claude Code child via npx |
| MCP server Node processes (`node .../bin/gemini-cli-mcp`) | 13 | Includes long-lived `npx`-resolved binaries |
| `gemini --yolo --output-format stream-json` workers | ~14 | Counts double for pre-0.8.0 servers (relaunch) |

### Relaunch suppression validation (issue #98)

Tested per-server by reading `/proc/<pid>/environ`:

- Pre-0.8.0 servers (started before 06:46:15 cache refresh): outer worker has **no** `GEMINI_CLI_NO_RELAUNCH`; inner worker (relaunched with `--max-old-space-size=9999`) has it set by the relaunch code itself.
- Post-0.8.0 servers (started after 06:46:15): outer worker has `GEMINI_CLI_NO_RELAUNCH=true`. **Only one process per pool slot.** No relaunch.

**Verdict:** 0.8.0 is correct. The doubling visible in `pgrep` output is purely from stale pre-upgrade MCP servers still alive. Closing the relaunch question.

## Approved direction: bound cost

The user picked option A: lower per-instance footprint, document, no sharing rework.

### Cost model to communicate

```
warm workers = N_clients × M_entries × GEMINI_POOL_SIZE
             ≈ (open Claude Code windows) × (gemini-cli-mcp configs) × pool_size
```

Today's defaults: `GEMINI_POOL_SIZE = GEMINI_MAX_CONCURRENT = 2`.
With 5 active Claude Code sessions and one MCP entry: **10 workers, ~2.5–4 GB RAM**.

### Sub-options for the "bound cost" PR

These are the concrete moves available; pick one or combine.

| # | Change | Pros | Cons |
|---|---|---|---|
| **B1** | Default `GEMINI_POOL_SIZE` from `MAX_CONCURRENT` (2) → `1`. | Cuts steady-state RAM in half. One-line change + docs. | When 2 concurrent prompts arrive, the second cold-spawns (~13 s wait, defeating the pool for the 2nd). Hits parallel reviews and `gemini-batch`. |
| **B2** | Add idle eviction: pool shrinks to 0 (or to a `MIN_POOL_SIZE`) after `IDLE_TIMEOUT_MS` of no acquires; replenishes lazily on the next request. | Pays cost only when actively used. Honest match to "warm cache" semantics. | Adds state machine + tests. First request after idle cold-spawns. Requires a way to mark "active" cleanly. |
| **B3** | Detect multi-instance scenarios and warn at startup (e.g. "another `gemini-cli-mcp` already running on this user — consider lowering `GEMINI_POOL_SIZE`"). | Zero behavior change; informs heavy users. | Detection is heuristic (`pgrep` against own user); no automatic action. |
| **B4** | Document only: README section on per-instance cost, recommended overrides for sprint/multi-session workflows (`GEMINI_POOL_SIZE=1`, `GEMINI_POOL_ENABLED=0` for sleep windows). | No code risk. | Users have to read and act. |

### Recommended bundle

**B2 + B4** — idle eviction is the most elegant fix because it makes the pool's cost match its actual utility. B1 alone is a too-blunt regression for active users. B4 captures the operator-facing story regardless of which code change ships. B3 is optional polish.

If idle eviction feels too risky for a single PR, a phased plan:

- **Phase 1 (one PR):** B1 + B4. Lower default, document, accept the cold-start cost for parallel calls. Ship in a minor version bump.
- **Phase 2 (follow-up issue):** B2. Add idle eviction so pool size 2 becomes safe again.

## Open questions for issue creation

1. Which sub-option(s) — B1, B2, B3, B4, or a bundle — should become GitHub issues?
2. Should the cost-model documentation live in README (alongside the env-var table) or in a separate `docs/operations.md`?
3. Is the deferred "shared pool" track (HTTP singleton / daemon) worth a tracking issue with `Research:` / `Evaluate:` prefix, or close cleanly with a pointer to this doc?

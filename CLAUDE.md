# gemini-cli-mcp — Claude Instructions

## Key source files
- `src/gemini-runner.ts` — subprocess execution, retry, telemetry; re-exports the four extracted modules below at their original paths so consumers don't need to update imports
- `src/concurrency.ts` — `Semaphore`, `MAX_CONCURRENT`, `QUEUE_TIMEOUT_MS` (extracted from runner, #109)
- `src/binary-discovery.ts` — `discoverGeminiBinary`, `GEMINI_BINARY` resolution across nvm/fnm/asdf/volta/Homebrew (#109)
- `src/prompt-prep.ts` — `@file` ref expansion + `LARGE_PROMPT_THRESHOLD` heuristics (#109)
- `src/response-cache.ts` — `cache` Map + `cacheKey`, `clearCache`, TTL/eviction constants (#109)
- `src/models-data.ts` — curated model list + `GEMINI_MODELS` env override; backs the `gemini://models` resource (#108)
- `src/warm-pool.ts` — pre-spawned Gemini process pool (WarmProcessPool)
- `src/session-store.ts` — SQLite-backed multi-turn session store (node:sqlite)
- `src/setup.ts` — `--setup` wizard (binary discovery, auth check, MCP config output)
- `src/tools/ask-gemini.ts`, `src/tools/gemini-reply.ts`, `src/tools/gemini-sessions.ts` — MCP tool handlers (`gemini-sessions` is discriminated on presence of `sessionId`: omit ⇒ list, provide ⇒ export)
- `src/resources.ts` — MCP Resource registry (`gemini://server/health`, `gemini://sessions`, `gemini://jobs`, `gemini://models`)
- `src/cli-capabilities.ts` — CLI version detection, flag probing, buildBaseArgs (detectCapabilities, getCapabilities)
- `src/dispatcher.ts` — routes MCP tool calls + error handling

## Build & test
- `npm run build` — tsc (must pass before commit)
- `npx tsc --noEmit` — standalone type check (run before committing; catches type errors without emitting files)
- `npm test` — vitest (all tests must pass)
- SQLite emits `ExperimentalWarning` in test output — not an error, safe to ignore

## Hands-on integration testing (REQUIRED before marking any PR ready)

Unit tests cover isolated logic. **Real MCP tool calls against the local build are mandatory** before a PR leaves draft — they catch spawn failures, session wiring, warm pool behavior, and output parsing that mocks cannot.

**Setup:** The project `.mcp.json` registers `gemini-dev` pointing at `dist/index.js`.
Requires a Claude Code restart after changes to pick up the local build.
Use `mcp__gemini-dev__*` tools (not `mcp__gemini__*` which hit the installed release).

**Required scenarios — run all before marking PR ready:**
1. `ask-gemini` basic prompt (`wait: true`) — verifies spawn, GEMINI_BINARY auto-discovery, response parsing
2. `gemini-reply` continuing a session — verifies session store round-trip
3. `ask-gemini` without `wait` + `gemini-poll` — verifies async job lifecycle
4. `gemini-cancel` — start a job, cancel it, verify status becomes `cancelled`
5. `@file` reference in prompt — verifies file expansion end-to-end (use a file in `src/`)
6. Two concurrent `ask-gemini` calls — verifies semaphore and warm pool under load
7. Idle eviction (PR #112) — start with `GEMINI_POOL_SIZE=2 GEMINI_POOL_IDLE_TIMEOUT_MS=15000 GEMINI_POOL_MIN_SIZE=0`. Run `pgrep -af "gemini --yolo"`: 2 workers → 0 after 20 s idle → 1 after a fresh `ask-gemini` call → second call within 15 s hits warm. Verifies the eviction + replenishment loop end-to-end.

**After a PR adds new features**, add the relevant scenario(s) to the list above and to the PR test plan.

## Testing patterns
- Module-level singletons (semaphore, MAX_RETRIES env constants) are frozen at import time.
  Tests overriding them via `process.env` must use `vi.resetModules()` + dynamic `import()`.
- Always use `GEMINI_SESSION_DB=":memory:"` in tests (already set in vitest.config.ts env).
- Sequential test data labels (user-1..user-25): use `\n`-terminated strings in `.toContain()`
  assertions to avoid substring false positives ("user-1" matches "user-10").

## Environment variables (all optional)
| Variable | Default | Description |
|---|---|---|
| `GEMINI_MAX_RETRIES` | `3` | Auto-retries on empty-stdout/429/ETIMEDOUT. `0` = disabled. |
| `GEMINI_RETRY_BASE_MS` | `1000` | Base delay for first retry (exponential backoff) |
| `GEMINI_MAX_CONCURRENT` | `2` | Max parallel Gemini subprocesses |
| `GEMINI_QUEUE_TIMEOUT_MS` | `60000` | Concurrency slot wait timeout (ms) |
| `GEMINI_STRUCTURED_LOGS` | `0` | `1` = JSON telemetry lines to stderr |
| `GEMINI_MAX_HISTORY_TURNS` | `20` | History sliding window (turn-pairs; 0=unlimited) |
| `GEMINI_SESSION_DB` | `~/.gemini-cli-mcp/sessions.db` | SQLite path; `:memory:` = ephemeral |
| `GEMINI_CACHE_TTL_MS` | `300000` | Response cache TTL (ms); `0` = disabled |
| `GEMINI_CACHE_MAX_ENTRIES` | `50` | Max entries in the response cache |
| `GEMINI_POOL_ENABLED` | `1` | `0` = disable warm pool (cold spawn only, for debugging) |
| `GEMINI_POOL_SIZE` | `1` | Number of pre-spawned warm processes per server. Combined with idle eviction, larger values are safe. |
| `GEMINI_POOL_STARTUP_MS` | `12000` | Estimated CLI startup time (ms); prompt writes delayed until this age after spawn |
| `GEMINI_POOL_IDLE_TIMEOUT_MS` | `300000` | Time of no `acquire()` calls after which the pool shrinks to `GEMINI_POOL_MIN_SIZE`. `0` = disabled. |
| `GEMINI_POOL_MIN_SIZE` | `0` | Floor the pool can shrink to during idle eviction. Must be ≤ `GEMINI_POOL_SIZE`. |
| `GEMINI_BINARY` | (auto-discovered) | Explicit path to the `gemini` binary. When set, auto-discovery is skipped. Useful for nvm/fnm users where gemini isn't on the MCP server's PATH. |
| `GEMINI_JOB_TTL_MS` | `300000` | How long completed/failed/cancelled jobs are retained in memory (ms) |
| `GEMINI_JOB_GC_MS` | `60000` | Job garbage-collection sweep interval (ms) |
| `GEMINI_SKIP_DETECTION` | `0` | `1` = skip CLI version/flag detection at startup (use hardcoded fallback args) |
| `GEMINI_MODELS` | (built-in list) | Comma-separated model IDs to override the default curated list exposed by the `gemini://models` resource. Custom entries report `source: "custom"`, `tier: "balanced"`, `description: "Custom model"`. |
| `GEMINI_DISABLE_PDEATHSIG` | `0` | `1` = skip the `setpriv --pdeathsig TERM` wrapper around child spawns (Linux only). Escape hatch for the issue #97 kernel-level PDEATHSIG safety net; only the literal string `"1"` disables. |
| `GEMINI_ORPHAN_REAPER` | `1` | `0` = disable the issue #99 startup sweep that reaps orphaned `gemini --yolo --output-format stream-json` workers belonging to the current user (orphans whose parent is PID 1 *or* a root-owned subreaper ancestor — see `findLinuxSubreaperAncestors` for the WSL2/systemd-user/container case). POSIX-only; no-op on Windows. |

## Env vars set on every gemini child (issue #98)

`GEMINI_CHILD_ENV_OVERRIDES` in `src/cli-capabilities.ts` defines env vars
injected into every spawned `gemini` process. Currently:

- `GEMINI_CLI_NO_RELAUNCH=true` — disables `@google/gemini-cli`'s runtime
  self-relaunch (`relaunchAppInChildProcess`, located at
  `packages/cli/src/utils/relaunch.ts` in v0.41.x of the upstream repo).
  Without this, the CLI re-execs itself with `--max-old-space-size=<50% RAM>`,
  producing two Node processes per warm-pool slot. With it set, we get one
  process per slot — verifiable via `pgrep -af "gemini --yolo"` (count should
  equal `GEMINI_POOL_SIZE`, not 2× it). Trade-off: CLI runs at Node's default
  heap (~4 GB on 64-bit). If a real prompt OOMs we revisit by passing
  `--max-old-space-size` explicitly.

Contract verified at upstream v0.41.2. If a future release changes the env-var
name or removes the gate, the unit propagation tests in `cli-capabilities` and
`setup` will still pass — they mock `spawn`. The only reliable signal is the
manual integration step: run `pgrep -af "gemini --yolo"` after server startup
and verify the count equals `GEMINI_POOL_SIZE` (not 2× it).

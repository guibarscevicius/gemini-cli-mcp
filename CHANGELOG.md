# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] — 2026-03-08

### Changed

- README rewritten for clarity: removed provisional language, tightened prose, restructured installation section.

## [0.2.0] — 2026-03-08

### Added

- **Warm process pool** (`WarmProcessPool`): pre-spawns Gemini CLI processes to eliminate the ~12 s cold-start cost. First requests arrive in ~4–5 s once the pool has warmed up. Controlled via `GEMINI_POOL_ENABLED`, `GEMINI_POOL_SIZE`, and `GEMINI_POOL_STARTUP_MS`.
- **Async job system**: `ask-gemini` returns a `jobId` immediately without blocking. Use `gemini-poll` to check status and `gemini-cancel` to abort.
- **`gemini-poll` tool**: poll the status of a pending async job — returns `pending` (with partial response), `done`, `error`, or `cancelled`.
- **`gemini-cancel` tool**: cancel a running job; kills the underlying subprocess.
- **Blocking mode** (`wait: true`): `ask-gemini` and `gemini-reply` can optionally block until completion and return the response inline. Falls back to async on timeout.
- **MCP progress notifications**: when the MCP client provides a `progressToken`, the server streams partial responses as `notifications/progress` events, then returns the final response inline.
- **Response cache** (`GEMINI_CACHE_TTL_MS`, `GEMINI_CACHE_MAX_ENTRIES`): caches identical stateless requests with TTL and FIFO eviction. Set `GEMINI_CACHE_TTL_MS=0` to disable.
- **`GEMINI_POOL_STARTUP_MS`**: startup guard that delays prompt writes until the CLI process is fully initialized, preventing prompt loss during the startup window.
- **`GEMINI_MAX_HISTORY_TURNS`**: sliding window on session conversation history (default: 20 turn-pairs). Set to `0` for unlimited history.
- **`GEMINI_STRUCTURED_LOGS`**: set to `1` to emit one JSON telemetry line to stderr per request (timestamps, prompt/response sizes, retry count, duration).
- **`GEMINI_JOB_TTL_MS`** and **`GEMINI_JOB_GC_MS`**: control job retention and garbage-collection interval.
- **Multi-`@file` expansion**: when `cwd` is provided, multiple `@file` tokens in a single prompt are expanded by the server before passing to the CLI, bypassing the single-file CLI restriction.
- **Large-prompt bypass**: prompts larger than 110 KB are written to a temp file and passed via `@path`, bypassing Linux's `MAX_ARG_STRLEN` (`~128 KB`) kernel limit.
- **Concurrency semaphore**: `GEMINI_MAX_CONCURRENT` caps parallel Gemini subprocesses; excess requests queue with `GEMINI_QUEUE_TIMEOUT_MS` timeout.
- **Glob pattern support** in `@file` references: `@src/**/*.ts` expands all matching files.

### Changed

- Session store migrated from in-memory to **SQLite** (`node:sqlite`). Sessions now survive server restarts. Configure path via `GEMINI_SESSION_DB` (default: `~/.gemini-cli-mcp/sessions.db`).
- Output format switched from `--output-format json` to `--output-format stream-json` for real-time NDJSON streaming and partial response support.
- `ask-gemini` output shape extended: now returns `jobId`, `sessionId`, `pollIntervalMs` (async mode) or `response` (blocking mode) or `partialResponse` + `timedOut` (timeout mode).
- `gemini-reply` output extended to match: includes `jobId` and `pollIntervalMs`.

## [0.1.0] — 2025-12-01

### Added

- Initial release: MCP server wrapping the Gemini CLI
- `ask-gemini` and `gemini-reply` tools with stateful multi-turn sessions
- No shell injection: `execFile()` passes args directly to `execve` — no shell invoked
- Env isolation: subprocess inherits only `HOME` and `PATH`
- Structured output via `--output-format json`
- Auto-retry on empty stdout, HTTP 429, and ETIMEDOUT errors
- SIGTERM/SIGINT graceful shutdown

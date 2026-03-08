# gemini-cli-mcp — Claude Instructions

## Key source files
- `src/gemini-runner.ts` — subprocess execution, warm pool integration, semaphore, retry, telemetry
- `src/warm-pool.ts` — pre-spawned Gemini process pool (WarmProcessPool)
- `src/session-store.ts` — SQLite-backed multi-turn session store (node:sqlite)
- `src/tools/ask-gemini.ts`, `src/tools/gemini-reply.ts` — MCP tool handlers
- `src/dispatcher.ts` — routes MCP tool calls + error handling

## Build & test
- `npm run build` — tsc (must pass before commit)
- `npm test` — vitest (244 tests; all must pass)
- SQLite emits `ExperimentalWarning` in test output — not an error, safe to ignore

## Testing patterns
- Module-level singletons (semaphore, MAX_RETRIES env constants) are frozen at import time.
  Tests overriding them via `process.env` must use `vi.resetModules()` + dynamic `import()`.
- Always use `GEMINI_SESSION_DB=":memory:"` in tests (already set in vitest.config.ts env).
- Sequential test data labels (user-1..user-25): use `\n`-terminated strings in `.toContain()`
  assertions to avoid substring false positives ("user-1" matches "user-10").

## Environment variables (all optional)
| Variable | Default | Description |
|---|---|---|
| `GEMINI_MAX_RETRIES` | `3` | Auto-retries on empty-stdout/429/ETIMEDOUT |
| `GEMINI_RETRY_BASE_MS` | `1000` | Base delay for first retry (exponential backoff) |
| `GEMINI_MAX_CONCURRENT` | `2` | Max parallel Gemini subprocesses |
| `GEMINI_QUEUE_TIMEOUT_MS` | `60000` | Concurrency slot wait timeout (ms) |
| `GEMINI_STRUCTURED_LOGS` | `0` | `1` = JSON telemetry lines to stderr |
| `GEMINI_MAX_HISTORY_TURNS` | `20` | History sliding window (turn-pairs; 0=unlimited) |
| `GEMINI_SESSION_DB` | `~/.gemini-cli-mcp/sessions.db` | SQLite path; `:memory:` = ephemeral |
| `GEMINI_POOL_ENABLED` | `1` | `0` = disable warm pool (cold spawn only, for debugging) |
| `GEMINI_POOL_SIZE` | `GEMINI_MAX_CONCURRENT` | Number of pre-spawned warm processes |

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0](https://github.com/guibarscevicius/gemini-cli-mcp/compare/gemini-cli-mcp-v0.4.1...gemini-cli-mcp-v0.5.0) (2026-03-14)


### Features

* 5 quick-win enhancements for 0.5.0 ([6fdba63](https://github.com/guibarscevicius/gemini-cli-mcp/commit/6fdba6378186167eb2d06db9807471bd0355e20d))
* 5 quick-win enhancements for 0.5.0 ([#44](https://github.com/guibarscevicius/gemini-cli-mcp/issues/44) [#45](https://github.com/guibarscevicius/gemini-cli-mcp/issues/45) [#46](https://github.com/guibarscevicius/gemini-cli-mcp/issues/46) [#47](https://github.com/guibarscevicius/gemini-cli-mcp/issues/47) [#48](https://github.com/guibarscevicius/gemini-cli-mcp/issues/48)) ([6a987a4](https://github.com/guibarscevicius/gemini-cli-mcp/commit/6a987a429c1d8a266a4a022d837a245852614b24))
* add gemini-batch tool for parallel prompt processing ([#75](https://github.com/guibarscevicius/gemini-cli-mcp/issues/75)) ([a91a88e](https://github.com/guibarscevicius/gemini-cli-mcp/commit/a91a88e9db67e14d5e8b7fdc11afcb2efcfe9bc2))
* add MCP Resources — gemini:// URIs for health, sessions, jobs ([#50](https://github.com/guibarscevicius/gemini-cli-mcp/issues/50)) ([#73](https://github.com/guibarscevicius/gemini-cli-mcp/issues/73)) ([abe0ec5](https://github.com/guibarscevicius/gemini-cli-mcp/commit/abe0ec56d1ae050a0f7ceeb09d2d3e28f984d7c8))
* add MCP tool annotations and titles to all 4 tools ([#68](https://github.com/guibarscevicius/gemini-cli-mcp/issues/68)) ([289c48d](https://github.com/guibarscevicius/gemini-cli-mcp/commit/289c48d76ed12e44c6f822d23c9af798bb0a9ec4))
* gemini-export tool — export session conversation history ([#49](https://github.com/guibarscevicius/gemini-cli-mcp/issues/49)) ([#71](https://github.com/guibarscevicius/gemini-cli-mcp/issues/71)) ([58a5d3d](https://github.com/guibarscevicius/gemini-cli-mcp/commit/58a5d3d240c7d7e1ecf17c5a046843780113afb4))
* MCP logging capability (issue [#52](https://github.com/guibarscevicius/gemini-cli-mcp/issues/52)) ([#72](https://github.com/guibarscevicius/gemini-cli-mcp/issues/72)) ([ced1433](https://github.com/guibarscevicius/gemini-cli-mcp/commit/ced143303173f299af8b55faa7db2725afbeba78))
* MCP Prompts — ListPrompts and GetPrompt handlers (issue [#51](https://github.com/guibarscevicius/gemini-cli-mcp/issues/51)) ([#74](https://github.com/guibarscevicius/gemini-cli-mcp/issues/74)) ([9dfac51](https://github.com/guibarscevicius/gemini-cli-mcp/commit/9dfac51a97aa9ca6433dadc9d2ec8577e3a96437))


### Bug Fixes

* address all PR review findings (C1/C2/I1-I5/S1-S5) ([90ed223](https://github.com/guibarscevicius/gemini-cli-mcp/commit/90ed223759bbb21750aeffc6003138fbf3258258))
* use ROLLBACK (not COMMIT) on session-not-found path in appendTurn ([0d78dac](https://github.com/guibarscevicius/gemini-cli-mcp/commit/0d78dac64e06071cfb547d29f183bad6046ba797))

## [0.4.1](https://github.com/guibarscevicius/gemini-cli-mcp/compare/gemini-cli-mcp-v0.4.0...gemini-cli-mcp-v0.4.1) (2026-03-11)


### Bug Fixes

* address PR review findings — extract error helper, fix type:error detail, improve diagnostics ([73891db](https://github.com/guibarscevicius/gemini-cli-mcp/commit/73891db14a64e801bab0f21c8dde03966caf8a2c))
* unregister requestId on wait timeout to prevent late MCP cancellation ([52015ce](https://github.com/guibarscevicius/gemini-cli-mcp/commit/52015cebff5f8fa4a83253d8dd490d17d433f612))
* wait:true timeout fallback, warm pool first-run race, NDJSON error detail ([0a0a1b3](https://github.com/guibarscevicius/gemini-cli-mcp/commit/0a0a1b3ad39921c23565cd3aeedebbe534496c85))
* wait:true timeout fallback, warm pool first-run race, NDJSON error detail ([986ddfa](https://github.com/guibarscevicius/gemini-cli-mcp/commit/986ddfa160cac8fa62f4c74c5429beb4f5a06f0a)), closes [#63](https://github.com/guibarscevicius/gemini-cli-mcp/issues/63) [#64](https://github.com/guibarscevicius/gemini-cli-mcp/issues/64) [#65](https://github.com/guibarscevicius/gemini-cli-mcp/issues/65)

## [0.4.0](https://github.com/guibarscevicius/gemini-cli-mcp/compare/gemini-cli-mcp-v0.3.0...gemini-cli-mcp-v0.4.0) (2026-03-10)


### Features

* plug-and-play distribution — GEMINI_BINARY auto-discovery + --setup wizard ([#61](https://github.com/guibarscevicius/gemini-cli-mcp/issues/61)) ([711963c](https://github.com/guibarscevicius/gemini-cli-mcp/commit/711963c007ba1bbc16d981b90c2eacb9155bddf1))

## [0.3.0](https://github.com/guibarscevicius/gemini-cli-mcp/compare/gemini-cli-mcp-v0.2.3...gemini-cli-mcp-v0.3.0) (2026-03-10)


### Features

* async jobs + streaming via spawn/stream-json ([#12](https://github.com/guibarscevicius/gemini-cli-mcp/issues/12), [#17](https://github.com/guibarscevicius/gemini-cli-mcp/issues/17)) ([#22](https://github.com/guibarscevicius/gemini-cli-mcp/issues/22)) ([04abe40](https://github.com/guibarscevicius/gemini-cli-mcp/commit/04abe40455bed8d2942995cec0d84bd39559ff23))
* ergonomics — notifications/cancelled, structuredContent, wait mode, pollIntervalMs ([a893769](https://github.com/guibarscevicius/gemini-cli-mcp/commit/a8937693c179f242ad0d75fc15c0f644cdc9ad19))
* ergonomics — notifications/cancelled, structuredContent, wait mode, pollIntervalMs ([894cb76](https://github.com/guibarscevicius/gemini-cli-mcp/commit/894cb763d61d30a65dedc6461e5a8156913ef013))
* initial implementation of gemini-cli-mcp ([387f6e1](https://github.com/guibarscevicius/gemini-cli-mcp/commit/387f6e1e7a1d5e7af42b4d70604df4f28e4e868c))
* LRU request dedup cache for stateless ask-gemini calls ([#21](https://github.com/guibarscevicius/gemini-cli-mcp/issues/21)) ([0f4706c](https://github.com/guibarscevicius/gemini-cli-mcp/commit/0f4706ca9469d68cb931e3656c54bce931e63060)), closes [#18](https://github.com/guibarscevicius/gemini-cli-mcp/issues/18)
* MCP progress notifications ([#26](https://github.com/guibarscevicius/gemini-cli-mcp/issues/26)) ([#30](https://github.com/guibarscevicius/gemini-cli-mcp/issues/30)) ([0705093](https://github.com/guibarscevicius/gemini-cli-mcp/commit/0705093ad8a0683c8344f0a2f914589ebea8d57a))
* raise limits and add large-prompt temp-file bypass ([#11](https://github.com/guibarscevicius/gemini-cli-mcp/issues/11)) ([93174e5](https://github.com/guibarscevicius/gemini-cli-mcp/commit/93174e56fa78f1901201f3d501d523857989c9c4))
* reliability + observability (semaphore, retry, SQLite sessions, telemetry) ([#20](https://github.com/guibarscevicius/gemini-cli-mcp/issues/20)) ([6feb2b6](https://github.com/guibarscevicius/gemini-cli-mcp/commit/6feb2b62bf76009328f7bb6c8358a7f443088596))
* WarmProcessPool — pre-spawn Gemini processes to cut cold-start latency ([#31](https://github.com/guibarscevicius/gemini-cli-mcp/issues/31)) ([69263ba](https://github.com/guibarscevicius/gemini-cli-mcp/commit/69263ba330bb785e7fa493533a6f4ff675e914c7))


### Bug Fixes

* address 13 PR review findings ([8dbe1bc](https://github.com/guibarscevicius/gemini-cli-mcp/commit/8dbe1bc3e7f213909edd1bf63807af74210b945f))
* address 20 findings from full codebase review ([5c54099](https://github.com/guibarscevicius/gemini-cli-mcp/commit/5c54099f97a1d36134aa38f6eec8edbcd0400bfe))
* address 20 findings from full codebase review ([80b4d21](https://github.com/guibarscevicius/gemini-cli-mcp/commit/80b4d212a4f5790553a8eeb8292ecb880ec2b49e))
* address PR [#29](https://github.com/guibarscevicius/gemini-cli-mcp/issues/29) review findings (19 items) ([3c6fd68](https://github.com/guibarscevicius/gemini-cli-mcp/commit/3c6fd689b60e477391d7b1673df0bc90a6cced96))
* address PR review findings — symlink escape, error handling, test hygiene ([f87e8b2](https://github.com/guibarscevicius/gemini-cli-mcp/commit/f87e8b27924b2be01cc41a6f618e6b2f5243b67d))
* close gemini CLI stdin to unblock non-TTY execution ([16f5cf9](https://github.com/guibarscevicius/gemini-cli-mcp/commit/16f5cf97b0c8595a77e2e766b00ed4268dac80d3))
* delay warm pool prompt write until CLI startup completes ([#32](https://github.com/guibarscevicius/gemini-cli-mcp/issues/32)) ([2a9b2a8](https://github.com/guibarscevicius/gemini-cli-mcp/commit/2a9b2a826df5431e6638470968d8718f4ac0e796))
* enrich 'Path not in workspace' errors with actionable cwd hint ([779f0b1](https://github.com/guibarscevicius/gemini-cli-mcp/commit/779f0b1022e9da398a05750aca0f446f75f42aea))
* enrich 'Path not in workspace' errors with actionable cwd hint ([e27bdf6](https://github.com/guibarscevicius/gemini-cli-mcp/commit/e27bdf635dc4d853996ea9a1a0528485faec7694)), closes [#4](https://github.com/guibarscevicius/gemini-cli-mcp/issues/4)
* expand multiple [@file](https://github.com/file) tokens in MCP layer (issue [#5](https://github.com/guibarscevicius/gemini-cli-mcp/issues/5)) ([22c4b38](https://github.com/guibarscevicius/gemini-cli-mcp/commit/22c4b38ada2745d20ca99a2f78e30e106ec04825))
* expand multiple [@file](https://github.com/file) tokens in MCP layer to fix multi-file support ([b89dc6d](https://github.com/guibarscevicius/gemini-cli-mcp/commit/b89dc6dde2bacb6ee85e7fd501bca5f92b45b02e))
* filter non-file-path @ tokens to prevent false positives ([#39](https://github.com/guibarscevicius/gemini-cli-mcp/issues/39)) ([707bd86](https://github.com/guibarscevicius/gemini-cli-mcp/commit/707bd863a00fed815e81d4a278a31f8a284090f2))
* replace NodeJS.ErrnoException with inline type to satisfy ESLint no-undef ([965e3ee](https://github.com/guibarscevicius/gemini-cli-mcp/commit/965e3ee39514b3b2be26710eb286a1aa084d2144))
* replace NodeJS.ProcessEnv with Record&lt;string, string&gt; to satisfy eslint no-undef on CI ([d9d9ef0](https://github.com/guibarscevicius/gemini-cli-mcp/commit/d9d9ef04c389bad7d0bdcadd3c3005048d4b10bc))
* resolve symlink in isEntrypoint check so npx invocation works ([#36](https://github.com/guibarscevicius/gemini-cli-mcp/issues/36)) ([0e511da](https://github.com/guibarscevicius/gemini-cli-mcp/commit/0e511dab592cdafb2ef874c25fced65117b529da))
* second review pass — cause chains, regex simplification, missing tests ([f601323](https://github.com/guibarscevicius/gemini-cli-mcp/commit/f601323ba9fa1522b1dd014028478917d8cc1fbe))
* ship dist/index.js with executable permissions in tarball ([#37](https://github.com/guibarscevicius/gemini-cli-mcp/issues/37)) ([7c812cf](https://github.com/guibarscevicius/gemini-cli-mcp/commit/7c812cf626eab1324f18a29a54fd565fcf46e3d3))
* support () and [] in [@file](https://github.com/file) paths for framework route patterns ([0648f31](https://github.com/guibarscevicius/gemini-cli-mcp/commit/0648f3172377efd7d8ea2030427484a93f57943d))
* support () and [] in [@file](https://github.com/file) paths for framework route patterns ([f80bded](https://github.com/guibarscevicius/gemini-cli-mcp/commit/f80bdede4d93b7e54f0f4373df8928cc5e9573cf)), closes [#9](https://github.com/guibarscevicius/gemini-cli-mcp/issues/9)
* tighten job-store guards, GC pending jobs, fix wait-mode timer and unregisterRequest leak ([f6b01e9](https://github.com/guibarscevicius/gemini-cli-mcp/commit/f6b01e904478cc32eb2ee14d95d592924df7a9da))

## [0.2.3] — 2026-03-09

### Fixed

- Published tarball now ships `dist/index.js` with executable permissions (`755`), matching best practice from `@anthropic-ai/claude-code` and `@modelcontextprotocol/create-server`. Previously `tsc` emitted the file as `644` and relied on npm to fix permissions at install time.

### Added

- Development note in README about `npx` not working from within the repo (npm Arborist CWD quirk).

## [0.2.2] — 2026-03-09

### Fixed

- Server silently doing nothing when invoked via `npx` or a global install. npm bin entries are symlinks; `path.resolve()` does not dereference them, so the `isEntrypoint` check always evaluated to `false` and `main()` was never called. Fixed by using `realpathSync()` before comparing paths.

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

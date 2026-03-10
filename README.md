# gemini-cli-mcp

[![npm](https://img.shields.io/npm/v/@guibarscevicius/gemini-cli-mcp)](https://www.npmjs.com/package/@guibarscevicius/gemini-cli-mcp)
[![CI](https://github.com/guibarscevicius/gemini-cli-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/guibarscevicius/gemini-cli-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An MCP server that wraps the official [`@google/gemini-cli`](https://github.com/google-gemini/gemini-cli), exposing Gemini to Claude Code and any MCP-compatible host. Supports stateful multi-turn sessions, async jobs, response streaming, and a warm process pool for low-latency responses.

## Quick Setup (recommended)

```bash
npm install -g @guibarscevicius/gemini-cli-mcp
gemini-cli-mcp --setup
```

The wizard will:
1. Find or install `@google/gemini-cli`
2. Verify your Gemini authentication
3. Print a ready-to-paste MCP config with absolute paths

## Security

| Property | Implementation |
|----------|----------------|
| No shell injection | `execFile()` passes args as an array directly to `execve` — no shell is invoked |
| No arg concatenation | Args array is built programmatically; user input is always a single element |
| Env isolation | Subprocess inherits only `HOME` and `PATH` |
| Structured output | `--output-format stream-json` produces reliable streaming NDJSON |

## Prerequisites

- **Node.js ≥ 24** — [nodejs.org/en/download](https://nodejs.org/en/download)
- **Gemini CLI** installed and authenticated:

```bash
npm install -g @google/gemini-cli
gemini  # follow the auth flow (Google subscription — no billing required)
```

Verify it works:
```bash
gemini --prompt "hello" --output-format stream-json
```

## Installation

### npx (recommended)

```json
{
  "mcpServers": {
    "gemini": {
      "command": "npx",
      "args": ["-y", "@guibarscevicius/gemini-cli-mcp"]
    }
  }
}
```

Add to `~/.claude/settings.json` for Claude Code CLI, or your host's MCP config file.

### Local development

```json
{
  "mcpServers": {
    "gemini": {
      "command": "node",
      "args": ["/path/to/gemini-cli-mcp/dist/index.js"]
    }
  }
}
```

> **Model compatibility (Gemini CLI ≥ 0.31):** The CLI forces `include_thoughts` for models that support thinking. Recommended models: `gemini-3-flash-preview` (fast, default), `gemini-3.1-pro-preview` (deep reasoning), `gemini-3.1-flash-lite` (cost-efficient).

## Tools

### `ask-gemini` — start a new session

```
Input:
  prompt        string   Required. The message to send.
  model         string   Optional. E.g. "gemini-3-flash-preview". Defaults to CLI default.
  cwd           string   Optional. Working directory — required for any @file path.
  wait          boolean  Optional. Block until done and return response inline (default: false).
  waitTimeoutMs number   Optional. Max ms to wait when wait=true (default: 90000).

Output (async — default):
  jobId          string   Poll with gemini-poll or cancel with gemini-cancel.
  sessionId      string   Use with gemini-reply for multi-turn conversations.
  pollIntervalMs number   Suggested polling interval in ms (2000).

Output (wait: true — done):
  jobId          string
  sessionId      string
  response       string   Gemini's complete response.
  pollIntervalMs number

Output (wait: true — timeout):
  jobId           string
  sessionId       string
  partialResponse string   Partial output collected before timeout (may be empty).
  timedOut        true
  pollIntervalMs  number
```

### `gemini-reply` — continue an existing session

```
Input:
  sessionId     string   Required. Returned by ask-gemini.
  prompt        string   Required. Follow-up message.
  model         string   Optional. Override the model for this turn.
  cwd           string   Optional. Working directory for relative @file paths.
  wait          boolean  Optional. Block until done (default: false).
  waitTimeoutMs number   Optional. Max ms to wait when wait=true (default: 90000).

Output:
  jobId           string
  pollIntervalMs  number
  response        string   (wait: true — done)
  partialResponse string   (wait: true — timeout)
  timedOut        true     (wait: true — timeout)
```

Sessions auto-expire after 60 minutes of inactivity.

### `gemini-poll` — check job status

```
Input:
  jobId   string   Required. From ask-gemini or gemini-reply output.

Output (pending):
  jobId           string
  status          "pending"
  partialResponse string   Partial output accumulated so far.

Output (done):
  jobId    string
  status   "done"
  response string   Gemini's complete response.

Output (error):
  jobId   string
  status  "error"
  error   string

Output (cancelled):
  jobId   string
  status  "cancelled"
  error   string   Optional cancellation detail.
```

### `gemini-cancel` — cancel a pending job

```
Input:
  jobId   string   Required.

Output:
  jobId       string
  cancelled   boolean   true if the running subprocess was killed.
  alreadyDone boolean   true if the job had already completed before cancel arrived.
```

## Async workflow

`ask-gemini` returns immediately with a `jobId`. Use `gemini-poll` to check status:

```javascript
// Start a long request without blocking
const { jobId, sessionId } = await ask_gemini({
  prompt: "Summarize this large codebase: @src/**/*.ts",
  cwd: "/path/to/your/project"
})

// Poll until done (typically 4–20 s)
let result
do {
  await new Promise(r => setTimeout(r, 2000))
  result = await gemini_poll({ jobId })
} while (result.status === "pending")

// Continue the conversation
const { jobId: j2 } = await gemini_reply({
  sessionId,
  prompt: "What are the 3 most important findings?"
})
```

For simple one-shot requests, use `wait: true`:

```javascript
const { response } = await ask_gemini({
  prompt: "What is the capital of France?",
  wait: true
})
```

## Using `@file` syntax

The server supports `@file` references to inject file contents directly into the prompt.

> **Always pass `cwd`** — the server enforces a workspace boundary at `cwd`. Any `@file` path that resolves outside the tree is rejected with `Path not in workspace`.

**Single file:**
```javascript
ask_gemini({ prompt: "Review this file: @src/auth.ts", cwd: "/path/to/your/project" })
```

**Multiple files** — when two or more `@file` tokens are present and `cwd` is provided, the server expands them before sending to the CLI:
```javascript
ask_gemini({
  prompt: "Compare @src/auth.ts and @src/session.ts for consistency.",
  cwd: "/path/to/your/project"
})
```

**Glob patterns:**
```javascript
ask_gemini({
  prompt: "Review all TypeScript files: @src/**/*.ts",
  cwd: "/path/to/your/project"
})
```

Without `cwd`, only a single `@file` is supported (passed directly to the CLI). Multiple `@file` tokens without `cwd` raise an error.

## Multi-turn example

```javascript
// Turn 1
const { sessionId } = await ask_gemini({
  prompt: "What is the time complexity of merge sort?",
  wait: true
})

// Turn 2 — Gemini has full context of the previous exchange
const { response } = await gemini_reply({
  sessionId,
  prompt: "And how does that compare to quicksort in practice?",
  wait: true
})
```

## Performance

The server pre-spawns Gemini CLI processes (warm pool) to eliminate the ~12 s cold-start cost. First requests arrive in ~4–5 s once the pool has warmed up (~12 s after server start).

Set `GEMINI_POOL_STARTUP_MS` to match your machine's CLI startup time. Disable the pool with `GEMINI_POOL_ENABLED=0` for debugging.

## Environment variables

All variables are optional.

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_MAX_RETRIES` | `3` | Auto-retries on empty-stdout/429/ETIMEDOUT. `0` = disabled. |
| `GEMINI_RETRY_BASE_MS` | `1000` | Base delay for exponential backoff (doubles each retry). |
| `GEMINI_MAX_CONCURRENT` | `2` | Max parallel Gemini subprocesses. |
| `GEMINI_QUEUE_TIMEOUT_MS` | `60000` | Max wait for a concurrency slot (ms). |
| `GEMINI_STRUCTURED_LOGS` | `0` | `1` = emit one JSON telemetry line to stderr per request. |
| `GEMINI_MAX_HISTORY_TURNS` | `20` | Session history window (turn-pairs). `0` = unlimited. |
| `GEMINI_SESSION_DB` | `~/.gemini-cli-mcp/sessions.db` | SQLite path. `:memory:` = ephemeral. |
| `GEMINI_CACHE_TTL_MS` | `300000` | Response cache TTL (ms). `0` = disabled. |
| `GEMINI_CACHE_MAX_ENTRIES` | `50` | Max entries in the response cache. |
| `GEMINI_POOL_ENABLED` | `1` | `0` = disable warm pool (cold spawn only). |
| `GEMINI_POOL_SIZE` | `GEMINI_MAX_CONCURRENT` | Number of pre-spawned warm processes. |
| `GEMINI_POOL_STARTUP_MS` | `12000` | Estimated CLI startup time (ms). Prompt writes are delayed by this amount after spawn. |
| `GEMINI_BINARY` | (auto-discovered) | Explicit path to the `gemini` binary. Overrides auto-discovery. Useful when gemini is installed via nvm/fnm and not on the PATH that MCP servers see. |
| `GEMINI_JOB_TTL_MS` | `300000` | How long completed/failed/cancelled jobs are retained (ms). |
| `GEMINI_JOB_GC_MS` | `60000` | Job garbage-collection interval (ms). |

## Troubleshooting

**`gemini binary not found`** — Install the Gemini CLI: `npm install -g @google/gemini-cli`

**`HOME environment variable is not set`** — The Gemini CLI needs `HOME` to locate OAuth credentials (`~/.config/gemini`).

**`Path not in workspace`** — Pass `cwd` equal to the root of your project when using `@file` paths.

**`Gemini request timed out waiting for a concurrency slot`** — Increase `GEMINI_MAX_CONCURRENT` or reduce request concurrency.

**Sessions expire** — Sessions auto-expire after 60 minutes of inactivity. Start a new session with `ask-gemini`.

**Warm pool not starting** — Check stderr for `gemini binary not found`. After 5 consecutive spawn failures the pool disables itself and logs a diagnostic message.

### gemini binary not found (nvm/fnm users)

If you use nvm or fnm, the `gemini` binary may not be on the PATH that Claude Code sees (MCP servers start in non-interactive shells where version managers don't load).

**Option A (recommended):** Run `gemini-cli-mcp --setup` — it auto-discovers the binary and generates a config with `GEMINI_BINARY` set.

**Option B (manual):** Set `GEMINI_BINARY` in your MCP config env:
```json
{
  "gemini": {
    "command": "...",
    "args": ["..."],
    "env": {
      "GEMINI_BINARY": "/home/you/.nvm/versions/node/v24.0.0/bin/gemini"
    }
  }
}
```

## How sessions work

The server manages conversation history in a local SQLite store (`node:sqlite`). On each `gemini-reply` call, prior turns are prepended as a structured context block:

```
[Conversation history]
User: <turn 1 prompt>
Assistant: <turn 1 response>
...
[End of history — continue the conversation]

<new prompt>
```

## Development

```bash
git clone https://github.com/guibarscevicius/gemini-cli-mcp.git
cd gemini-cli-mcp
npm install
npm run build
npm test
```

Smoke test:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/index.js
```

> **Note:** `npx @guibarscevicius/gemini-cli-mcp` will not work from inside this repo. npm's Arborist sees the local `package.json` matches the package name and skips installation. Use `node dist/index.js` directly when developing.

## License

MIT — see [LICENSE](LICENSE).

# gemini-cli-mcp

[![npm](https://img.shields.io/npm/v/gemini-cli-mcp)](https://www.npmjs.com/package/gemini-cli-mcp)
[![CI](https://github.com/guibarscevicius/gemini-cli-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/guibarscevicius/gemini-cli-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A safe, auditable MCP server that wraps the official [`@google/gemini-cli`](https://github.com/google-gemini/gemini-cli) for use with Claude Code (and any MCP-compatible host).

**Why this exists:** The only previous npm package doing this (`gemini-mcp-tool`) has an unpatched CVSS 9.8 command injection CVE and has been abandoned since July 2025. This project fixes the underlying class of vulnerability and adds stateful multi-turn sessions.

## Security properties

| Property | How it's achieved |
|----------|-------------------|
| No shell injection | `execFile()` passes args as an array directly to `execve` — no shell is invoked |
| No arg concatenation | Args array is built programmatically; user input is always a single element, never spliced into a string |
| Env isolation | Subprocess inherits only `HOME` and `PATH` — your API keys and secrets stay out |
| No hanging | `--yolo` auto-approves Gemini's own tool use (web search, code execution) |
| Structured output | `--output-format stream-json` gives reliable streaming NDJSON output |

## Prerequisites

- **Node.js ≥ 24** (Active LTS) — [nodejs.org/en/download](https://nodejs.org/en/download)

1. Install and authenticate the Gemini CLI:
   ```bash
   npm install -g @google/gemini-cli
   gemini  # follow the auth flow (subscription — no billing)
   ```

2. Verify it works:
   ```bash
   gemini --prompt "hello" --output-format stream-json
   ```

## Claude Code configuration

### Once published to npm — npx (recommended)

```json
{
  "mcpServers": {
    "gemini": {
      "command": "npx",
      "args": ["-y", "gemini-cli-mcp"]
    }
  }
}
```

### Local development — direct node

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

Add to `~/.claude/settings.json` for Claude Code CLI, or your host's MCP config file.

> **Model compatibility note (Gemini CLI ≥ 0.31):** The CLI forces `include_thoughts` for models that support thinking. `gemini-2.0-flash` triggers a 400 error due to this. Recommended: `gemini-3-flash-preview` (fast, default), `gemini-3.1-pro-preview` (deep reasoning), `gemini-3.1-flash-lite` (cost-efficient). `gemini-3-pro-preview` was shut down March 9 2026 — migrate away.

## Tools

### `ask-gemini` — start a new session

```
Input:
  prompt        string   Required. The message to send.
  model         string   Optional. E.g. "gemini-3-flash-preview". Defaults to CLI default.
  cwd           string   Optional. Working directory — required for any @file path.
  wait          boolean  Optional. If true, block until done and return response inline (default: false).
  waitTimeoutMs number   Optional. Max ms to wait when wait=true (default: 90000). Falls back to async on timeout.

Output (async mode — default):
  jobId         string   Poll with gemini-poll or cancel with gemini-cancel.
  sessionId     string   Use with gemini-reply for multi-turn conversations.
  pollIntervalMs number  Suggested polling interval in ms (2000).

Output (blocking mode — wait: true):
  jobId         string
  sessionId     string
  response      string   Gemini's complete response.
  pollIntervalMs number

Output (blocking mode — timeout):
  jobId         string
  sessionId     string
  partialResponse string  Partial output collected before timeout (may be empty).
  timedOut      true
  pollIntervalMs number
```

### `gemini-reply` — continue an existing session

```
Input:
  sessionId  string   Required. Returned by ask-gemini.
  prompt     string   Required. Follow-up message.
  model      string   Optional. Override the model for this turn.
  cwd        string   Optional. Working directory for relative @file paths.
  wait       boolean  Optional. If true, block until done (default: false).
  waitTimeoutMs number  Optional. Max ms to wait when wait=true (default: 90000).

Output:
  jobId         string
  sessionId     string
  pollIntervalMs number
  response      string   (blocking mode only)
```

Sessions auto-expire after 60 minutes of inactivity.

### `gemini-poll` — check job status

```
Input:
  jobId   string   Required. From ask-gemini or gemini-reply output.

Output (pending):
  jobId          string
  status         "pending"
  partialResponse string  Partial output accumulated so far.

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
  alreadyDone boolean   true if the job had already completed/failed before cancel arrived.
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
let result;
do {
  await new Promise(r => setTimeout(r, 2000));
  result = await gemini_poll({ jobId });
} while (result.status === "pending");

// Continue the conversation
const { jobId: j2 } = await gemini_reply({
  sessionId,
  prompt: "What are the 3 most important findings?"
})
```

For simple one-shot requests, use `wait: true` to block until complete:

```javascript
const { response } = await ask_gemini({
  prompt: "What is the capital of France?",
  wait: true
})
```

## Using `@file` syntax

The server supports `@file` references to inject file contents directly into the prompt.

> **Always pass `cwd`** — the server enforces a workspace boundary at `cwd`; any `@file` path that resolves outside the tree is rejected with `Path not in workspace`. Pass `cwd` equal to the root of the project containing your target files.

**Single file (relative path):**
```javascript
ask_gemini({
  prompt: "Review this file: @src/auth.ts",
  cwd: "/path/to/your/project"
})
```

**Multiple files in one prompt** — when `cwd` is provided, the server expands all `@file` tokens itself before sending to the CLI:
```javascript
ask_gemini({
  prompt: "Compare @src/auth.ts and @src/session.ts for consistency.",
  cwd: "/path/to/your/project"
})
```

**Glob patterns** — expand all matching files:
```javascript
ask_gemini({
  prompt: "Review all TypeScript files: @src/**/*.ts",
  cwd: "/path/to/your/project"
})
```

**Without `cwd`** — only a single `@file` is supported (passed directly to the CLI). Multiple `@file` tokens without `cwd` will raise an error.

## Multi-turn example

```javascript
// Turn 1 — start a session
const { sessionId } = await ask_gemini({
  prompt: "What is the time complexity of merge sort?",
  wait: true
})

// Turn 2 — Gemini remembers the previous exchange
const { response } = await gemini_reply({
  sessionId,
  prompt: "And how does that compare to quicksort in practice?",
  wait: true
})
```

## Performance

The server pre-spawns Gemini CLI processes (warm pool) to eliminate the ~12 s cold-start cost. First requests after server start arrive in ~4–5 s once the pool has warmed up (~12 s after startup).

Set `GEMINI_POOL_STARTUP_MS` if your machine's CLI startup is faster or slower. Disable the pool with `GEMINI_POOL_ENABLED=0` for debugging or resource-constrained environments.

## Environment variables

All variables are optional.

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_MAX_RETRIES` | `3` | Auto-retries on empty-stdout/429/ETIMEDOUT. `0` = disabled. |
| `GEMINI_RETRY_BASE_MS` | `1000` | Base delay for exponential backoff (doubles each retry). |
| `GEMINI_MAX_CONCURRENT` | `2` | Max parallel Gemini subprocesses. |
| `GEMINI_QUEUE_TIMEOUT_MS` | `60000` | Max wait for a concurrency slot (ms). |
| `GEMINI_STRUCTURED_LOGS` | `0` | `1` = JSON telemetry line to stderr per request. |
| `GEMINI_MAX_HISTORY_TURNS` | `20` | Session history window (turn-pairs). `0` = unlimited. |
| `GEMINI_SESSION_DB` | `~/.gemini-cli-mcp/sessions.db` | SQLite path. `:memory:` = ephemeral. |
| `GEMINI_CACHE_TTL_MS` | `300000` | Response cache TTL (ms). `0` = disabled. |
| `GEMINI_CACHE_MAX_ENTRIES` | `50` | Max entries in the response cache. |
| `GEMINI_POOL_ENABLED` | `1` | `0` = disable warm pool (cold spawn only, for debugging). |
| `GEMINI_POOL_SIZE` | `GEMINI_MAX_CONCURRENT` | Number of pre-spawned warm processes. |
| `GEMINI_POOL_STARTUP_MS` | `12000` | Estimated CLI startup time (ms) — prompt writes delayed by this. |
| `GEMINI_JOB_TTL_MS` | `3600000` | How long completed/failed/cancelled jobs are retained (ms). |
| `GEMINI_JOB_GC_MS` | `60000` | Job garbage-collection interval (ms). |

## Troubleshooting

**`gemini binary not found`** — Install the Gemini CLI: `npm install -g @google/gemini-cli`

**`HOME environment variable is not set`** — The Gemini CLI needs `HOME` to find OAuth credentials (`~/.config/gemini`).

**`Path not in workspace`** — Always pass `cwd` equal to the root of your project when using `@file` paths.

**`Gemini request timed out waiting for a concurrency slot`** — Too many parallel requests. Increase `GEMINI_MAX_CONCURRENT` or reduce request frequency.

**Sessions expire** — Sessions auto-expire after 60 minutes of inactivity. Start a fresh session with `ask-gemini`.

**Warm pool not warming up** — Check stderr for `gemini binary not found` messages. If the pool detects 5 consecutive spawn failures it disables itself and logs a clear message.

## How sessions work

Since `gemini --resume <id>` is scoped to a project directory and cannot be used from a global MCP server, this server manages conversation history in a local SQLite store (`node:sqlite`). On each `gemini-reply` call, prior turns are prepended as a structured context block:

```
[Conversation history]
User: <turn 1 prompt>
Assistant: <turn 1 response>
...
[End of history — continue the conversation]

<new prompt>
```

This is equivalent to how most LLM wrappers implement multi-turn: resend the full history with each request.

## Development

```bash
git clone https://github.com/guibarscevicius/gemini-cli-mcp.git
cd gemini-cli-mcp
npm install
npm run build

# Smoke test
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/index.js
```

```bash
# Run tests
npm test

# Watch mode
npm run test:watch
```

## License

MIT — see [LICENSE](LICENSE).

# gemini-cli-mcp

A safe, auditable MCP server that wraps the official [`@google/gemini-cli`](https://github.com/google-gemini/gemini-cli) for use with Claude Code (and any MCP-compatible host).

**Why this exists:** The only previous npm package doing this (`gemini-mcp-tool`) has an unpatched CVSS 9.8 command injection CVE and has been abandoned since July 2025. This project fixes the underlying class of vulnerability and adds stateful multi-turn sessions.

## Security properties

| Property | How it's achieved |
|----------|-------------------|
| No shell injection | `execFile()` passes args as an array directly to `execve` — no shell is invoked |
| No arg concatenation | Args array is built programmatically; user input is always a single element, never spliced into a string |
| Env isolation | Subprocess inherits only `HOME` and `PATH` — your API keys and secrets stay out |
| No hanging | `--yolo` auto-approves Gemini's own tool use (web search, code execution) |
| Structured output | `--output-format json` gives reliable parsing instead of fragile screen-scraping |

## Prerequisites

- **Node.js ≥ 24** (Active LTS) — [nodejs.org/en/download](https://nodejs.org/en/download)

1. Install and authenticate the Gemini CLI:
   ```bash
   npm install -g @google/gemini-cli
   gemini  # follow the auth flow (subscription — no billing)
   ```

2. Verify it works:
   ```bash
   gemini --prompt "hello" --output-format json
   ```

## Claude Code configuration

### Personal use — direct node (recommended while testing)

```json
{
  "mcpServers": {
    "gemini": {
      "command": "node",
      "args": ["/home/gui/projects/gemini-cli-mcp/dist/index.js"]
    }
  }
}
```

### Once published to npm — npx

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

Add to `~/.claude/settings.json` for Claude Code CLI, or your host's MCP config file.

> **Model compatibility note (Gemini CLI ≥ 0.31):** The CLI forces `include_thoughts` for models that support thinking. `gemini-2.0-flash` triggers a 400 error due to this. Use `gemini-2.5-flash-lite`, `gemini-2.5-pro`, or omit `model` to let the CLI pick its default.

## Tools

### `ask-gemini` — start a new session

```
Input:
  prompt   string   Required. The message to send.
  model    string   Optional. E.g. "gemini-2.5-pro". Defaults to CLI default.
  cwd      string   Optional. Working directory — required for relative @file paths.

Output:
  sessionId   string   Use with gemini-reply to continue the conversation.
  response    string   Gemini's response.
```

### `gemini-reply` — continue an existing session

```
Input:
  sessionId  string   Required. Returned by ask-gemini.
  prompt     string   Required. Follow-up message.
  model      string   Optional. Override the model for this turn.
  cwd        string   Optional. Working directory for relative @file paths.

Output:
  response   string   Gemini's response.
```

Sessions auto-expire after 60 minutes of inactivity.

## Using `@file` syntax

The Gemini CLI supports `@file` to inject file contents directly into the prompt.

> **Always pass `cwd`** — the Gemini CLI enforces a workspace boundary at the subprocess's working directory. Any `@file` path (relative or absolute) that resolves outside the `cwd` tree is rejected with `Path not in workspace`. Pass `cwd` equal to the root of the project containing your target files.

**Recommended pattern (works for both absolute and relative paths):**
```
ask-gemini({
  prompt: "Review this file: @src/auth.ts",
  cwd: "/home/gui/projects/myapp"
})
```

**Absolute path also works, as long as `cwd` covers it:**
```
ask-gemini({
  prompt: "Review this file: @/home/gui/projects/myapp/src/auth.ts",
  cwd: "/home/gui/projects/myapp"
})
```

> **One `@file` per prompt** — using two or more `@file` tokens in a single prompt causes the Gemini CLI subprocess to exit silently with a non-descriptive error. Read files in separate calls if you need multiple.

## Multi-turn example

```
// Turn 1
const { sessionId, response } = await ask-gemini({
  prompt: "What is the time complexity of merge sort?"
})

// Turn 2 — Gemini remembers the previous exchange
const { response } = await gemini-reply({
  sessionId,
  prompt: "And how does that compare to quicksort in practice?"
})
```

## Development

```bash
git clone https://github.com/guibarscevicius/gemini-cli-mcp.git
cd gemini-cli-mcp
npm install
npm run build

# Smoke test
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/index.js
```

The repo includes a `.mcp.json` that enables [Serena](https://github.com/oraios/serena) for semantic code navigation in Claude Code. Serena is optional but recommended — install [`uv`](https://docs.astral.sh/uv/getting-started/installation/) first, then Claude Code will prompt you to enable it when you open the project.

## How sessions work

Since `gemini --resume <id>` is scoped to a project directory and cannot be used from a global MCP server, this server manages conversation history in-process. On each `gemini-reply` call, prior turns are prepended as a structured context block:

```
[Conversation history]
User: <turn 1 prompt>
Assistant: <turn 1 response>
...
[End of history — continue the conversation]

<new prompt>
```

This is equivalent to how most LLM wrappers implement multi-turn: resend the full history with each request.

## License

MIT

# Upstream 0.38.1 Refresh Implementation Plan

**Date**: 2026-04-15
**Spec**: GitHub issue `#92` refreshed from `0.37.1` to `0.38.1`
**Goal**: Refresh the repo to the current upstream `@google/gemini-cli` release, confirm CLI compatibility, and add repeatable hands-on MCP verification across the full exposed server surface.

## Architecture Overview

This change stays within the existing server architecture. Upstream release tracking remains file-based through `.github/upstream-version.txt` and the scheduled watch workflow. Runtime compatibility remains owned by `src/cli-capabilities.ts`, which probes `gemini --version` and `gemini --help` and drives flag adaptation for the rest of the server. Model discovery remains owned by `src/tools/gemini-list-models.ts`.

The new verification work should not change server behavior. Instead, it should add a reproducible smoke harness that speaks MCP over stdio to `dist/index.js` and verifies the server's tools, resources, prompts, logging, and cancellation behavior against a real Gemini CLI install. That smoke harness becomes the acceptance gate for future upstream bumps.

## Tech Stack

- TypeScript
- Node.js 24+
- Vitest
- MCP stdio transport via `@modelcontextprotocol/sdk`
- `@google/gemini-cli` `0.38.1` for hands-on compatibility checks

## File Structure Map

| File | Status | Responsibility |
|------|--------|----------------|
| `.github/upstream-version.txt` | MODIFY | Track the current upstream Gemini CLI version. |
| `.github/workflows/upstream-watch.yml` | MODIFY | Keep upstream issue generation aligned with the refreshed tracked version and avoid stale follow-up behavior if needed. |
| `package.json` | MODIFY | Add a dedicated smoke-test script for real MCP verification. |
| `README.md` | MODIFY | Document the updated upstream baseline and the new hands-on verification workflow. |
| `src/cli-capabilities.ts` | MODIFY | Adjust flag/version probing only if `0.38.1` changes the help surface. |
| `src/tools/gemini-list-models.ts` | MODIFY | Refresh curated default model metadata only if current upstream naming or retirement notes changed. |
| `tests/cli-capabilities.test.ts` | MODIFY | Align capability fixtures with the verified `0.38.1` help output. |
| `tests/tools/gemini-list-models.test.ts` | MODIFY | Keep curated model assertions aligned with refreshed defaults. |
| `scripts/mcp-smoke.mjs` | NEW | Drive a real stdio MCP session and verify each exposed feature end to end. |

---

## Task 1: Re-baseline upstream version tracking and CLI help assumptions

### Objective

Confirm the actual `0.38.1` help and version surface, then align repo metadata and capability fixtures with what upstream ships now.

### Steps

1. Record the current upstream version and help output:

```bash
npm view @google/gemini-cli version
npx -y @google/gemini-cli@0.38.1 --version
npx -y @google/gemini-cli@0.38.1 --help
```

2. Update `.github/upstream-version.txt` from `0.35.3` to `0.38.1`.
3. Compare the verified help output to:
   - `src/cli-capabilities.ts`
   - `tests/cli-capabilities.test.ts`
4. Only change `src/cli-capabilities.ts` if `0.38.1` added, removed, or renamed flags in a way the current parser or arg builder mishandles.
5. Refresh test fixtures so they describe the real `0.38.1` help surface rather than the older `0.36.0` placeholder.

### Verification

```bash
npm run test -- tests/cli-capabilities.test.ts
```

Expected: capability tests pass with fixtures that match the real upstream help output.

---

## Task 2: Refresh curated model metadata if upstream naming or retirement notes changed

### Objective

Make `gemini-list-models` reflect the current supported and recommended model set without broadening scope beyond metadata.

### Steps

1. Verify the current recommended model names from the installed CLI and current repo docs used during the `0.7.x` work.
2. Compare the current curated list in `src/tools/gemini-list-models.ts` against the verified upstream state.
3. Update only the entries that are stale:
   - model ids
   - descriptions
   - deprecation notes
   - retirement notes
4. Keep `GEMINI_MODELS` override behavior unchanged.
5. Update `tests/tools/gemini-list-models.test.ts` so the curated list assertions match the refreshed defaults.

### Verification

```bash
npm run test -- tests/tools/gemini-list-models.test.ts
```

Expected: curated model tests pass and still preserve custom override behavior.

---

## Task 3: Add a repeatable MCP smoke harness for hands-on feature verification

### Objective

Add a single executable smoke script that verifies the server through a real MCP stdio session and covers every exposed MCP feature this repo ships.

### Scope of the smoke harness

The smoke harness in `scripts/mcp-smoke.mjs` should:

1. Build or assume a built server at `dist/index.js`.
2. Spawn `node dist/index.js`.
3. Send `initialize` and `notifications/initialized`.
4. Exercise the full MCP surface below.
5. Exit non-zero on any missing response, protocol error, malformed payload, or failed assertion.

### Required hands-on verification matrix

The smoke harness must cover all of the following:

| Surface | Check |
|--------|-------|
| `tools/list` | Returns all ten tools: `ask-gemini`, `gemini-reply`, `gemini-poll`, `gemini-cancel`, `gemini-health`, `gemini-list-sessions`, `gemini-export`, `gemini-batch`, `gemini-research`, `gemini-list-models`. |
| `ask-gemini` async | Call with `wait: false`, assert `jobId`, `sessionId`, and `pollIntervalMs`. |
| `gemini-poll` | Poll the async job until `pending` or `done`, assert valid state transitions. |
| `gemini-cancel` | Start a second async job, cancel it, then poll until `cancelled` or verify `cancelled/alreadyDone` semantics. |
| `gemini-reply` | Continue the original `sessionId` and assert a valid follow-up response path. |
| `gemini-health` | Assert structured health payload contains CLI, pool, concurrency, jobs, sessions, and server metadata. |
| `gemini-list-sessions` | Assert the created session appears. |
| `gemini-export` JSON | Export the session as JSON and assert turn structure. |
| `gemini-export` markdown | Export the session as markdown and assert transcript content exists. |
| `gemini-batch` | Call with `wait: true` and assert ordered result objects plus summary counts. |
| `gemini-research` | Call with `depth: quick`, `wait: true`, and assert response text is returned. |
| `gemini-list-models` | Assert `models`, `total`, and `source` fields exist. |
| `resources/list` | Returns the three static resources. |
| `resources/templates/list` | Returns both URI templates. |
| `resources/read` static | Read `gemini://server/health`, `gemini://sessions`, and `gemini://jobs`. |
| `resources/read` templated | Read `gemini://sessions/{sessionId}` and `gemini://jobs/{jobId}` using ids captured during the smoke run. |
| `prompts/list` | Returns all four prompts. |
| `prompts/get` | Fetch `code-review`, `architecture-analysis`, `explain-code`, and `debug-error`, each with valid arguments. |
| `logging/setLevel` | Send `logging/setLevel`, invoke a tool, and assert at least one logging notification is observed at or above the chosen level. |
| `notifications/cancelled` | Start an async `tools/call` request with an id, send `notifications/cancelled` for that request id, then verify the mapped job no longer stays pending forever. |

### Implementation notes

- Base the line-oriented stdio logic on the existing `runServerSelfTest` flow in `src/setup.ts` rather than inventing a second protocol approach.
- Keep the smoke script self-contained and repo-local.
- Use deterministic prompts:
  - `ask-gemini`: `"Reply with exactly: smoke-ok"`
  - `gemini-reply`: `"Now reply with exactly: smoke-reply-ok"`
  - `gemini-batch`: short deterministic prompts like `"Reply with exactly: batch-1"` and `"Reply with exactly: batch-2"`
  - `gemini-research`: a low-cost quick prompt like `"What does the phrase smoke test mean in software?"`
- Use bounded waits and explicit timeout errors so the script fails fast.
- Make the script print a short pass/fail line for each feature so failures are easy to pinpoint.

### Verification

```bash
npm run build
node scripts/mcp-smoke.mjs
```

Expected: every MCP feature check prints a passing status and the script exits `0`.

---

## Task 4: Wire the smoke harness into the developer workflow and docs

### Objective

Make the new hands-on verification easy to run during this refresh and on future upstream bumps.

### Steps

1. Add a `test:smoke` script to `package.json`:

```json
{
  "scripts": {
    "test:smoke": "node scripts/mcp-smoke.mjs"
  }
}
```

2. Update `README.md` so the upstream maintenance section explicitly says the acceptance flow for a new upstream version is:

```bash
npm run build
npm run test -- tests/cli-capabilities.test.ts tests/tools/gemini-list-models.test.ts tests/resources.test.ts tests/prompts.test.ts tests/logging.test.ts tests/index-server.test.ts
npm run test:smoke
npm test
```

3. If `upstream-watch.yml` still produces stale overlapping issues after the version bump, tighten it so future issue titles and issue searches only track the latest open upstream issue.

### Verification

```bash
npm run test:smoke
npm test
```

Expected: the smoke harness passes and the full suite still passes after the workflow/documentation changes.

---

## Hands-on Acceptance Gate

Do not treat the refresh as complete until all of the following succeed on this branch:

```bash
npm run build
npm run test -- tests/cli-capabilities.test.ts tests/tools/gemini-list-models.test.ts tests/resources.test.ts tests/prompts.test.ts tests/logging.test.ts tests/index-server.test.ts
npm run test:smoke
npm test
```

Success means:

- tracked upstream version is `0.38.1`
- CLI capability probing still matches the real `0.38.1` help surface
- curated model metadata is current
- every exposed MCP tool works in a real stdio session
- every exposed MCP resource and resource template reads successfully
- every exposed MCP prompt lists and renders successfully
- logging and cancellation behavior still function through the protocol, not just unit tests

## Recommended Execution Path

Execute sequentially on `fix/upstream-0381-refresh`.

Start with Task 1 because the verified `0.38.1` help output determines whether `src/cli-capabilities.ts` is a metadata-only confirmation or requires a code change. Then complete Task 2 before building the smoke harness in Task 3, because the smoke harness should validate the final model and capability surface, not an intermediate state.

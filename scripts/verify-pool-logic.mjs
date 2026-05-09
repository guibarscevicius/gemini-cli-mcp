/**
 * verify-pool-logic.mjs — pure logic for the warm-pool verification script.
 *
 * Split from verify-pool.mjs so decideVerdict can be unit-tested without
 * spawning real subprocesses or reading env vars.
 */

import { spawnSync } from "node:child_process";

/**
 * The exact cmdline fingerprint of a warm-pool worker. Must match the args
 * passed at src/gemini-runner.ts:218 (warm pool) and the orphan-reaper
 * signature at src/gemini-runner.ts:183 (which is consumed by the matching
 * logic in src/orphan-reaper.ts:86 — `matchesSignature` does an `includes()`
 * against the joined-by-space form, which is why we use the same here).
 *
 * If you change the warm-pool args, update all three sites.
 */
export const PGREP_PATTERN = "gemini --yolo --output-format stream-json";

/**
 * Count running workers via `pgrep -af`. Uses spawnSync with an argv array
 * (no shell) so the wrapping shell's cmdline doesn't show up in the matches —
 * that off-by-one trap was caught during PR review of the original execSync
 * implementation.
 *
 * Distinguishes:
 *   - exit 0  → matches found, count = lines of output
 *   - exit 1  → no matches (pgrep convention), return 0
 *   - ENOENT  → pgrep not on PATH; throws PgrepUnavailableError
 *   - other   → real failure (signal, syntax error); rethrows the spawnSync error
 */
export function countProcesses() {
  const result = spawnSync("pgrep", ["-af", PGREP_PATTERN], {
    encoding: "utf8",
  });

  if (result.error?.code === "ENOENT") {
    const e = new Error(
      "pgrep not found on PATH. Install procps (Linux) or use a system " +
        "where pgrep is built-in (macOS, BSD)."
    );
    e.code = "PGREP_NOT_FOUND";
    throw e;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status === 1) {
    return 0;
  }
  if (result.status !== 0) {
    const e = new Error(
      `pgrep exited with status ${result.status} ` +
        `(signal=${result.signal ?? "none"}); stderr: ${result.stderr?.trim() ?? ""}`
    );
    e.code = "PGREP_FAILED";
    throw e;
  }

  return result.stdout.trim().split("\n").filter(Boolean).length;
}

/**
 * Decide the verdict given a stabilized count and the expected pool size.
 *
 * Cases (all hard-fail except case 1):
 *   1. count === expected (and both > 0)   → exit 0, gate holding
 *   2. expected === 0                       → exit 1, pool is disabled — script not meaningful
 *   3. count === expected * 2 (expected > 0) → exit 1, gate broken (relaunch doubling)
 *   4. count === 0 (expected > 0)           → exit 1, no workers — server down or ENV problem
 *   5. anything else                        → exit 1, unhealthy or noise from another session
 *
 * The expected===0 case must be checked before the count===expected case,
 * otherwise count===expected===0 falsely reports "gate holding".
 */
export function decideVerdict(count, expected) {
  if (expected <= 0) {
    return {
      ok: false,
      message:
        `pool size is ${expected}; verify:pool is meaningless when the warm pool is disabled. ` +
        "Set GEMINI_POOL_SIZE (or GEMINI_MAX_CONCURRENT) to a positive integer, or run with the warm pool enabled.",
    };
  }
  if (count === expected) {
    return { ok: true, message: "gate holding (1 process per slot)" };
  }
  if (count === expected * 2) {
    return {
      ok: false,
      message:
        "gate BROKEN — relaunch is doubling processes. " +
        "GEMINI_CLI_NO_RELAUNCH no longer suppresses self-relaunch in upstream. " +
        "See src/cli-capabilities.ts (GEMINI_CHILD_ENV_OVERRIDES).",
    };
  }
  if (count === 0) {
    return {
      ok: false,
      message:
        "no workers detected. Is the MCP server running? " +
        `Check \`pgrep -af '${PGREP_PATTERN}'\` directly, or restart Claude Code. ` +
        "If GEMINI_POOL_ENABLED=0, the pool is intentionally disabled.",
    };
  }
  return {
    ok: false,
    message:
      `unexpected count=${count}, expected ${expected} or ${expected * 2}. ` +
      "Pool may be partially failed, or another `gemini --yolo` worker is running in a separate session.",
  };
}

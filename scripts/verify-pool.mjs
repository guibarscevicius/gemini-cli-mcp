#!/usr/bin/env node
/**
 * verify-pool.mjs — manual integration check for issue #98 contract.
 *
 * Counts running `gemini --yolo --output-format stream-json` worker processes
 * and compares against the expected warm-pool size.
 *
 * Why: upstream @google/gemini-cli runs `relaunchAppInChildProcess`, which
 * re-execs itself with --max-old-space-size, producing 2 Node processes per
 * warm-pool slot. We suppress this by injecting GEMINI_CLI_NO_RELAUNCH=true
 * (see src/cli-capabilities.ts: GEMINI_CHILD_ENV_OVERRIDES). The unit tests
 * mock spawn, so they cannot observe runtime fork behavior — this script is
 * the only signal that the env-var gate still holds in upstream.
 *
 * Verdicts:
 *   count == expected      → ✅ gate holding (1 process per slot)
 *   count == expected * 2  → ❌ gate broken (relaunch is doubling processes)
 *   count == 0             → ❓ MCP server not running, or pool disabled
 *   other                  → ⚠️ pool mid-spawn or unhealthy (see verdict logic)
 *
 * Usage:
 *   npm run verify:pool                    # poll until stable, then verdict
 *   GEMINI_POOL_SIZE=4 npm run verify:pool # match a non-default pool size
 *
 * Caveat:
 *   pgrep counts ALL `gemini --yolo --output-format stream-json` processes
 *   owned by the user, not just this server's pool. If multiple Claude Code
 *   sessions are running concurrently, expect counts to exceed GEMINI_POOL_SIZE.
 *   For an authoritative single-session check: stop other Claude Code instances
 *   first, or `pgrep -af` and inspect the parent PIDs manually.
 *
 * Tunables (all optional):
 *   GEMINI_POOL_SIZE        — expected count (default: GEMINI_MAX_CONCURRENT or 2)
 *   GEMINI_MAX_CONCURRENT   — fallback expected count
 *   VERIFY_POOL_TIMEOUT_MS  — give up polling after this long (default 30000)
 *   VERIFY_POOL_SETTLE_MS   — count must be unchanged this long (default 3000)
 */

import { execSync } from "node:child_process";
import process from "node:process";

const expected = Number(
  process.env.GEMINI_POOL_SIZE ??
    process.env.GEMINI_MAX_CONCURRENT ??
    2
);
const timeoutMs = Number(process.env.VERIFY_POOL_TIMEOUT_MS ?? 30_000);
const settleMs = Number(process.env.VERIFY_POOL_SETTLE_MS ?? 3000);

// Match the full worker invocation, not just `gemini --yolo`, to avoid
// false positives from interactive Gemini sessions in other terminals.
// Mirrors the orphan-reaper fingerprint in src/gemini-runner.ts (issue #99).
const PGREP_PATTERN = "gemini --yolo --output-format stream-json";

function countProcesses() {
  try {
    const out = execSync(`pgrep -af ${JSON.stringify(PGREP_PATTERN)}`, {
      encoding: "utf8",
    });
    return out.trim().split("\n").filter(Boolean).length;
  } catch (e) {
    // pgrep exits 1 when no matches; that's count=0, not an error.
    if (e.status === 1) return 0;
    throw e;
  }
}

async function pollUntilStable() {
  const start = Date.now();
  let lastCount = -1;
  let stableSince = 0;

  while (Date.now() - start < timeoutMs) {
    const c = countProcesses();
    const now = Date.now();

    if (c !== lastCount) {
      lastCount = c;
      stableSince = now;
      process.stderr.write(`[verify-pool] count=${c} (changing)\n`);
    } else if (now - stableSince >= settleMs) {
      return c;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return lastCount;
}

// ── verdict ──────────────────────────────────────────────────────────────────
// Hard-fail policy: exit 1 unless count exactly matches expected.

function decideVerdict(count, expected) {
  if (count === expected) {
    return { ok: true, message: "✅ gate holding (1 process per slot)" };
  }
  if (count === expected * 2) {
    return {
      ok: false,
      message:
        "❌ gate BROKEN — relaunch is doubling processes. " +
        "GEMINI_CLI_NO_RELAUNCH no longer suppresses self-relaunch in upstream. " +
        "See src/cli-capabilities.ts (GEMINI_CHILD_ENV_OVERRIDES) and CLAUDE.md issue #98.",
    };
  }
  if (count === 0) {
    return {
      ok: false,
      message:
        "❓ no workers detected. Is the MCP server running? " +
        "Check `pgrep -af 'gemini --yolo'` directly, or restart Claude Code. " +
        "If GEMINI_POOL_ENABLED=0, the pool is intentionally disabled.",
    };
  }
  return {
    ok: false,
    message:
      `⚠️ unexpected count=${count}, expected ${expected} or ${expected * 2}. ` +
      "Pool may be partially failed, or another `gemini --yolo` is running in a separate session.",
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

const count = await pollUntilStable();
const verdict = decideVerdict(count, expected);

console.log(`gemini --yolo workers: ${count}`);
console.log(`expected:              ${expected}`);
console.log(verdict.message);
process.exit(verdict.ok ? 0 : 1);

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
 * Verdicts and exit codes:
 *   count == expected      → exit 0 (gate holding, 1 process per slot)
 *   count == expected * 2  → exit 1 (gate broken, relaunch doubling)
 *   count == 0             → exit 1 (server down or pool disabled)
 *   expected <= 0          → exit 1 (verify:pool is meaningless when pool is disabled)
 *   anything else          → exit 1 (mid-spawn, partial failure, or noise)
 *   fatal (pgrep ENOENT,
 *      pollUntilStable
 *      throw, etc.)        → exit 2
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
 *   first, or run the same pgrep manually and inspect the parent PIDs.
 *
 * Tunables (all optional):
 *   GEMINI_POOL_SIZE        — expected count (default: GEMINI_MAX_CONCURRENT or 2)
 *   GEMINI_MAX_CONCURRENT   — fallback expected count
 *   VERIFY_POOL_TIMEOUT_MS  — give up polling after this long (default 30000).
 *                             Setting this to 0 disables polling — the script
 *                             samples once and verdicts immediately.
 *   VERIFY_POOL_SETTLE_MS   — count must be unchanged this long before the
 *                             verdict fires (default 3000). Effective wall-time
 *                             may be up to settleMs + 1s due to the 1-second
 *                             polling interval.
 */

import process from "node:process";
import { countProcesses, decideVerdict } from "./verify-pool-logic.mjs";

const expected = Number(
  process.env.GEMINI_POOL_SIZE ??
    process.env.GEMINI_MAX_CONCURRENT ??
    2
);
const timeoutMs = Number(process.env.VERIFY_POOL_TIMEOUT_MS ?? 30_000);
const settleMs = Number(process.env.VERIFY_POOL_SETTLE_MS ?? 3000);

if (!Number.isFinite(expected) || !Number.isFinite(timeoutMs) || !Number.isFinite(settleMs)) {
  process.stderr.write(
    `[verify-pool] FATAL: non-numeric env var. ` +
      `expected=${expected}, timeoutMs=${timeoutMs}, settleMs=${settleMs}\n`
  );
  process.exit(2);
}

async function pollUntilStable() {
  const start = Date.now();
  let lastCount = -1;
  let stableSince = 0;
  let lastLogAt = 0;

  while (Date.now() - start < timeoutMs) {
    const c = countProcesses();
    const now = Date.now();

    if (c !== lastCount) {
      lastCount = c;
      stableSince = now;
      lastLogAt = now;
      process.stderr.write(`[verify-pool] count=${c} (changing)\n`);
    } else if (now - stableSince >= settleMs) {
      return { count: c, settled: true };
    } else if (now - lastLogAt >= 5000) {
      lastLogAt = now;
      process.stderr.write(`[verify-pool] count=${c} (settling, ${Math.floor((settleMs - (now - stableSince)) / 1000)}s remaining)\n`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { count: lastCount, settled: false };
}

let pollResult;
try {
  pollResult = timeoutMs <= 0
    ? { count: countProcesses(), settled: true }
    : await pollUntilStable();
} catch (e) {
  if (e.code === "PGREP_NOT_FOUND") {
    process.stderr.write(`[verify-pool] FATAL: ${e.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`[verify-pool] FATAL: process counting failed: ${e.message}\n`);
  process.exit(2);
}

if (!pollResult.settled) {
  process.stderr.write(
    `[verify-pool] WARNING: timed out after ${timeoutMs}ms without count stabilizing. ` +
      `Last seen count=${pollResult.count}. Verdict reflects last sample.\n`
  );
}

const verdict = decideVerdict(pollResult.count, expected);

console.log(`gemini --yolo workers: ${pollResult.count}`);
console.log(`expected:              ${expected}`);
console.log(verdict.message);
process.exit(verdict.ok ? 0 : 1);

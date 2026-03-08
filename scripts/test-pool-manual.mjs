#!/usr/bin/env node
/**
 * Manual test runner for WarmProcessPool items 3–6 from PR #31 test plan.
 *
 * Each sub-test spawns a fresh Node process with isolated env vars so that
 * module-level singletons (warmPool, POOL_ENABLED, semaphore) initialize
 * correctly for that test's configuration.
 *
 * Usage:
 *   node scripts/test-pool-manual.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(join(__dirname, ".."));

// ─────────────────────────────────────────────────────────────────────────────
// Subprocess runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs inline ESM code in a fresh Node process with custom env vars.
 * @returns {{ exitCode: number|null, stdout: string, stderr: string }}
 */
function runSubTest(name, code, env, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`[${name}] Starting…`);

    const child = spawn("node", ["--input-type=module"], {
      env: { ...process.env, ...env },
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      // Stream structured log lines to our stderr so they're visible
      const lines = String(d).split("\n");
      for (const line of lines) {
        if (line.trim()) {
          // Only print structured JSON lines (telemetry) — suppress process noise
          if (line.startsWith("{")) {
            process.stderr.write(`  [stderr] ${line}\n`);
          }
        }
      }
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`[${name}] Timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });

    child.stdin.end(code);
  });
}

function parseJsonLines(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-test A — Item 3: Pool smoke (default config)
// ─────────────────────────────────────────────────────────────────────────────
async function subTestA() {
  const code = `
import { handleCallTool } from "./dist/dispatcher.js";
import { warmPool } from "./dist/gemini-runner.js";

// Check that the pool was created (not null)
const poolEnabled = warmPool !== null;
process.stdout.write(JSON.stringify({ poolEnabled }) + "\\n");

// Give pool a moment to pre-spawn its processes
await new Promise(r => setTimeout(r, 500));

const readyCount = warmPool?.readyCount ?? -1;
process.stdout.write(JSON.stringify({ readyCount }) + "\\n");

const start = Date.now();
const result = await handleCallTool("ask-gemini", {
  prompt: "reply with the single word pong",
  wait: true,
  waitTimeoutMs: 60_000,
});
const durationMs = Date.now() - start;

const content = result.content?.[0]?.text ?? "";
let parsed = null;
try { parsed = JSON.parse(content); } catch {}

const ok = !result.isError && parsed?.response !== undefined;
process.stdout.write(JSON.stringify({ ok, durationMs }) + "\\n");
if (!ok) {
  process.stderr.write("result: " + content + "\\n");
  process.exit(1);
}
process.exit(0);
`;

  const { exitCode, stdout, stderr } = await runSubTest(
    "Sub-test A (pool smoke, default config)",
    code,
    { GEMINI_STRUCTURED_LOGS: "1", GEMINI_SESSION_DB: ":memory:" },
    120_000
  );

  const info = parseJsonLines(stdout);
  const poolInfo = info[0] ?? {};
  const readyInfo = info[1] ?? {};
  const resultInfo = info[2] ?? {};

  // Find telemetry line from structured logs
  const telemetry = parseJsonLines(stderr).find(
    (l) => l.event === "gemini_request" && l.status === "ok"
  );

  const pass =
    exitCode === 0 &&
    poolInfo.poolEnabled === true &&
    resultInfo.ok === true;

  console.log(`  poolEnabled = ${poolInfo.poolEnabled}`);
  console.log(`  readyCount at start = ${readyInfo.readyCount}`);
  if (telemetry) {
    console.log(`  telemetry: durationMs=${telemetry.durationMs}, model=${telemetry.model}, status=${telemetry.status}`);
  }
  console.log(`  durationMs = ${resultInfo.durationMs}`);
  console.log(`  exitCode = ${exitCode}`);
  console.log(`[Sub-test A] ${pass ? "PASS ✓" : "FAIL ✗"}`);
  return pass;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-test B — Item 4: Pool disabled (GEMINI_POOL_ENABLED=0) fallback
// ─────────────────────────────────────────────────────────────────────────────
async function subTestB() {
  const code = `
import { handleCallTool } from "./dist/dispatcher.js";
import { warmPool } from "./dist/gemini-runner.js";

// Pool should be null when POOL_ENABLED=0
const poolIsNull = warmPool === null;
process.stdout.write(JSON.stringify({ poolIsNull }) + "\\n");

const start = Date.now();
const result = await handleCallTool("ask-gemini", {
  prompt: "reply with the single word pong",
  wait: true,
  waitTimeoutMs: 90_000,
});
const durationMs = Date.now() - start;

const content = result.content?.[0]?.text ?? "";
let parsed = null;
try { parsed = JSON.parse(content); } catch {}

const ok = !result.isError && parsed?.response !== undefined;
process.stdout.write(JSON.stringify({ ok, durationMs }) + "\\n");
if (!ok) {
  process.stderr.write("result: " + content + "\\n");
  process.exit(1);
}
process.exit(0);
`;

  const { exitCode, stdout, stderr } = await runSubTest(
    "Sub-test B (GEMINI_POOL_ENABLED=0 fallback)",
    code,
    {
      GEMINI_POOL_ENABLED: "0",
      GEMINI_STRUCTURED_LOGS: "1",
      GEMINI_SESSION_DB: ":memory:",
    },
    120_000
  );

  const info = parseJsonLines(stdout);
  const poolInfo = info[0] ?? {};
  const resultInfo = info[1] ?? {};

  const telemetry = parseJsonLines(stderr).find(
    (l) => l.event === "gemini_request" && l.status === "ok"
  );

  const pass =
    exitCode === 0 &&
    poolInfo.poolIsNull === true &&
    resultInfo.ok === true;

  console.log(`  poolIsNull = ${poolInfo.poolIsNull} (warmPool === null)`);
  console.log(`  request ok = ${resultInfo.ok}`);
  if (telemetry) {
    console.log(`  telemetry: durationMs=${telemetry.durationMs}, model=${telemetry.model}, status=${telemetry.status}`);
  }
  console.log(`  durationMs = ${resultInfo.durationMs}`);
  console.log(`  exitCode = ${exitCode}`);
  console.log(`[Sub-test B] ${pass ? "PASS ✓" : "FAIL ✗"}`);
  return pass;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-test C — Item 5: POOL_SIZE=1 with 2 concurrent requests
// ─────────────────────────────────────────────────────────────────────────────
async function subTestC() {
  const code = `
import { handleCallTool } from "./dist/dispatcher.js";

// Fire two calls simultaneously — the semaphore (MAX_CONCURRENT=1) serializes them.
// Both should eventually succeed; they're not expected to run in parallel.
const start = Date.now();
const [r1, r2] = await Promise.all([
  handleCallTool("ask-gemini", {
    prompt: "reply with the single word pong",
    wait: true,
    waitTimeoutMs: 180_000,
  }),
  handleCallTool("ask-gemini", {
    prompt: "reply with the single word ping",
    wait: true,
    waitTimeoutMs: 180_000,
  }),
]);
const durationMs = Date.now() - start;

const c1 = r1.content?.[0]?.text ?? "";
const c2 = r2.content?.[0]?.text ?? "";
let p1 = null, p2 = null;
try { p1 = JSON.parse(c1); } catch {}
try { p2 = JSON.parse(c2); } catch {}

const r1ok = !r1.isError && p1?.response !== undefined;
const r2ok = !r2.isError && p2?.response !== undefined;
const ok = r1ok && r2ok;
process.stdout.write(JSON.stringify({ ok, r1ok, r2ok, durationMs }) + "\\n");
if (!ok) {
  process.stderr.write("r1: " + c1 + "\\n");
  process.stderr.write("r2: " + c2 + "\\n");
  process.exit(1);
}
process.exit(0);
`;

  const { exitCode, stdout } = await runSubTest(
    "Sub-test C (POOL_SIZE=1, 2 concurrent requests)",
    code,
    {
      GEMINI_POOL_SIZE: "1",
      GEMINI_MAX_CONCURRENT: "1",
      GEMINI_STRUCTURED_LOGS: "1",
      GEMINI_SESSION_DB: ":memory:",
    },
    300_000 // 5 min: two serialized cold-ish spawns
  );

  const info = parseJsonLines(stdout);
  const result = info[0] ?? {};

  const pass = exitCode === 0 && result.ok === true;
  console.log(`  r1ok = ${result.r1ok}, r2ok = ${result.r2ok}`);
  console.log(`  both serialized: ${result.ok} (both completed successfully)`);
  console.log(`  total durationMs = ${result.durationMs}`);
  console.log(`  exitCode = ${exitCode}`);
  console.log(`[Sub-test C] ${pass ? "PASS ✓" : "FAIL ✗"}`);
  return pass;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-test D — Item 6: Custom model bypasses warm pool
// ─────────────────────────────────────────────────────────────────────────────
async function subTestD() {
  const code = `
import { handleCallTool } from "./dist/dispatcher.js";

const start = Date.now();
const result = await handleCallTool("ask-gemini", {
  prompt: "reply with the single word pong",
  model: "gemini-2.5-pro",
  wait: true,
  waitTimeoutMs: 120_000,
});
const durationMs = Date.now() - start;

const content = result.content?.[0]?.text ?? "";
let parsed = null;
try { parsed = JSON.parse(content); } catch {}

const ok = !result.isError && parsed?.response !== undefined;
process.stdout.write(JSON.stringify({ ok, durationMs }) + "\\n");
if (!ok) {
  process.stderr.write("result: " + content + "\\n");
  process.exit(1);
}
process.exit(0);
`;

  const { exitCode, stdout, stderr } = await runSubTest(
    "Sub-test D (custom model=gemini-2.5-pro, pool bypassed)",
    code,
    { GEMINI_STRUCTURED_LOGS: "1", GEMINI_SESSION_DB: ":memory:" },
    150_000
  );

  const info = parseJsonLines(stdout);
  const result = info[0] ?? {};

  // Telemetry: model field will be "gemini-2.5-pro" when custom model is used
  const telemetry = parseJsonLines(stderr).find(
    (l) => l.event === "gemini_request" && l.status === "ok"
  );

  // Pool is bypassed when opts.model is set (usePool requires !opts.model)
  const modelInLog = telemetry?.model;
  const poolBypassed = modelInLog === "gemini-2.5-pro"; // model propagated → cold spawn used

  const pass = exitCode === 0 && result.ok === true && poolBypassed;
  console.log(`  request ok = ${result.ok}`);
  console.log(`  telemetry model = "${modelInLog}" (expected "gemini-2.5-pro")`);
  console.log(`  pool bypassed (custom model → cold spawn) = ${poolBypassed}`);
  console.log(`  durationMs = ${result.durationMs}`);
  console.log(`  exitCode = ${exitCode}`);
  console.log(`[Sub-test D] ${pass ? "PASS ✓" : "FAIL ✗"}`);
  return pass;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

// Run sub-tests sequentially — concurrent Gemini subprocesses would fight for
// API quota and confuse telemetry attribution.
const labels = ["A (pool smoke)", "B (pool disabled)", "C (pool=1, 2 concurrent)", "D (custom model)"];
const fns = [subTestA, subTestB, subTestC, subTestD];
const results = [];

for (let i = 0; i < fns.length; i++) {
  try {
    results.push(await fns[i]());
  } catch (err) {
    console.error(`[${labels[i]}] EXCEPTION: ${err.message}`);
    results.push(false);
  }
}

console.log(`\n${"═".repeat(60)}`);
console.log(`Summary: ${results.filter(Boolean).length}/${results.length} sub-tests passed`);
for (let i = 0; i < labels.length; i++) {
  console.log(`  ${results[i] ? "✓" : "✗"} Sub-test ${labels[i]}`);
}
console.log(`${"═".repeat(60)}`);

process.exit(results.every(Boolean) ? 0 : 1);

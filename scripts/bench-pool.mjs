#!/usr/bin/env node
/**
 * Timing comparison: warm pool vs cold spawn.
 *
 * Runs N ask-gemini calls in each mode and reports P50 / P90 / min / max.
 * Each mode runs in a separate subprocess so module-level singletons
 * (warmPool, POOL_ENABLED) initialize correctly for that configuration.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(join(__dirname, ".."));

const SAMPLES = 3; // real Gemini calls — keep low to avoid rate-limit
// Prompts must be unique per sample to defeat the response cache (300s TTL by default).
// We also set GEMINI_CACHE_TTL_MS=0 in env, but unique prompts provide a belt-and-suspenders guard.
const PROMPTS = Array.from({ length: SAMPLES }, (_, i) =>
  `reply with the single word pong — sample ${i + 1} of ${SAMPLES} run ${Date.now()}`
);

// ── subprocess runner ────────────────────────────────────────────────────────

function runBatch(label, env, n) {
  const code = `
import { handleCallTool } from "./dist/dispatcher.js";
import { warmPool } from "./dist/gemini-runner.js";

// Give pool time to fully pre-spawn before first request.
// The Gemini CLI takes ~4-5 s to start, so we wait 8 s to ensure
// the warm processes are sitting idle and ready before we measure.
if (warmPool !== null) {
  await new Promise(r => setTimeout(r, 8000));
}

const poolMode = warmPool !== null ? "warm" : "cold";
const samples = [];
const prompts = ${JSON.stringify(PROMPTS)};

for (let i = 0; i < ${n}; i++) {
  const t0 = Date.now();
  const result = await handleCallTool("ask-gemini", {
    prompt: prompts[i],
    wait: true,
    waitTimeoutMs: 120_000,
  });
  const ms = Date.now() - t0;
  const ok = !result.isError;
  samples.push({ i, ms, ok });
  process.stderr.write(\`  sample \${i + 1}/${n}: \${ms} ms  ok=\${ok}\\n\`);
}

process.stdout.write(JSON.stringify({ poolMode, samples }) + "\\n");
const anyFail = samples.some(s => !s.ok);
process.exit(anyFail ? 1 : 0);
`;

  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--input-type=module"], {
      env: { ...process.env, ...env },
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { process.stderr.write(String(d)); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`[${label}] timed out`));
    }, 600_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(stdout.trim().split("\n").pop());
        resolve({ label, ...data, exitCode: code });
      } catch {
        reject(new Error(`[${label}] failed to parse output:\n${stdout}`));
      }
    });

    child.stdin.end(code);
  });
}

// ── stats helpers ────────────────────────────────────────────────────────────

function stats(samples) {
  const ms = samples.map(s => s.ms).sort((a, b) => a - b);
  const p = (pct) => ms[Math.min(Math.floor(ms.length * pct / 100), ms.length - 1)];
  return {
    min: ms[0],
    p50: p(50),
    p90: p(90),
    max: ms[ms.length - 1],
    avg: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length),
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

console.log(`Benchmark: warm pool vs cold spawn  (${SAMPLES} samples each, cache disabled)\n`);

console.log(`── Cold spawn (GEMINI_POOL_ENABLED=0) ──`);
const coldResult = await runBatch("cold", {
  GEMINI_POOL_ENABLED: "0",
  GEMINI_CACHE_TTL_MS: "0",
  GEMINI_SESSION_DB: ":memory:",
}, SAMPLES);
const coldStats = stats(coldResult.samples);

console.log(`\n── Warm pool (GEMINI_POOL_ENABLED=1) ──`);
const warmResult = await runBatch("warm", {
  GEMINI_POOL_ENABLED: "1",
  GEMINI_CACHE_TTL_MS: "0",
  GEMINI_SESSION_DB: ":memory:",
}, SAMPLES);
const warmStats = stats(warmResult.samples);

// ── report ───────────────────────────────────────────────────────────────────

const fmt = (n) => `${n} ms`;
const delta = (cold, warm) => {
  const diff = cold - warm;
  const sign = diff >= 0 ? "-" : "+";
  return `${sign}${Math.abs(diff)} ms (${sign}${Math.round(Math.abs(diff) / cold * 100)}%)`;
};

console.log(`
${"═".repeat(60)}
Results (${SAMPLES} samples each)
${"─".repeat(60)}
Metric      Cold spawn    Warm pool     Δ (cold→warm)
${"─".repeat(60)}
min         ${fmt(coldStats.min).padEnd(14)}${fmt(warmStats.min).padEnd(14)}${delta(coldStats.min, warmStats.min)}
avg         ${fmt(coldStats.avg).padEnd(14)}${fmt(warmStats.avg).padEnd(14)}${delta(coldStats.avg, warmStats.avg)}
p50         ${fmt(coldStats.p50).padEnd(14)}${fmt(warmStats.p50).padEnd(14)}${delta(coldStats.p50, warmStats.p50)}
p90         ${fmt(coldStats.p90).padEnd(14)}${fmt(warmStats.p90).padEnd(14)}${delta(coldStats.p90, warmStats.p90)}
max         ${fmt(coldStats.max).padEnd(14)}${fmt(warmStats.max).padEnd(14)}${delta(coldStats.max, warmStats.max)}
${"─".repeat(60)}
Cold samples: ${coldResult.samples.map(s => s.ms).join(", ")} ms
Warm samples: ${warmResult.samples.map(s => s.ms).join(", ")} ms
${"═".repeat(60)}
`);

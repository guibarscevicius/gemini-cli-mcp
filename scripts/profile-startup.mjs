#!/usr/bin/env node
/**
 * Profile Gemini CLI startup breakdown.
 * Measures: version check, time-to-spawn, time-to-first-byte, time-to-first-NDJSON, total.
 *
 * Usage: node scripts/profile-startup.mjs
 */
import { spawn } from "node:child_process";

const RUNS_VERSION = 10;
const RUNS_PROMPT = 5;

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p95(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(label, arr) {
  console.log(`  ${label}: median=${median(arr).toFixed(0)}ms  p95=${p95(arr).toFixed(0)}ms  [${arr.map(v => v.toFixed(0)).join(", ")}]`);
}

/** Run `gemini --version` and measure wall clock time. */
function runVersion() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const cp = spawn("gemini", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    cp.on("close", (code) => resolve(Date.now() - t0));
    cp.on("error", reject);
  });
}

/**
 * Run a real prompt and measure breakdown:
 *  - timeToSpawn: Date.now() after spawn() returns
 *  - timeToFirstByte: first stdout data event
 *  - timeToFirstNdjson: first parseable NDJSON line
 *  - total: process close
 */
function runPrompt() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const args = [
      "--yolo",
      "--output-format", "stream-json",
      "--prompt", "Say only: pong",
    ];
    const cp = spawn("gemini", args, {
      env: { HOME: process.env.HOME, PATH: process.env.PATH },
      stdio: ["pipe", "pipe", "pipe"],
    });
    cp.stdin?.end();
    const timeToSpawn = Date.now() - t0;
    let timeToFirstByte = null;
    let timeToFirstNdjson = null;
    let lineBuffer = "";

    cp.stdout?.on("data", (data) => {
      if (timeToFirstByte === null) timeToFirstByte = Date.now() - t0;
      lineBuffer += data.toString("utf8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          JSON.parse(trimmed);
          if (timeToFirstNdjson === null) timeToFirstNdjson = Date.now() - t0;
        } catch {}
      }
    });

    cp.on("close", () => {
      const total = Date.now() - t0;
      resolve({
        timeToSpawn,
        timeToFirstByte: timeToFirstByte ?? total,
        timeToFirstNdjson: timeToFirstNdjson ?? total,
        total,
      });
    });
    cp.on("error", reject);
  });
}

async function main() {
  console.log("=== Phase 1: gemini --version × " + RUNS_VERSION + " ===");
  const versionTimes = [];
  for (let i = 0; i < RUNS_VERSION; i++) {
    process.stdout.write(`  run ${i + 1}/${RUNS_VERSION}...\r`);
    versionTimes.push(await runVersion());
  }
  console.log("");
  stats("wall clock", versionTimes);

  console.log("\n=== Phase 2: gemini --prompt 'Say only: pong' × " + RUNS_PROMPT + " ===");
  const spawns = [], firstBytes = [], firstNdjsons = [], totals = [];
  for (let i = 0; i < RUNS_PROMPT; i++) {
    process.stdout.write(`  run ${i + 1}/${RUNS_PROMPT}...\r`);
    const r = await runPrompt();
    spawns.push(r.timeToSpawn);
    firstBytes.push(r.timeToFirstByte);
    firstNdjsons.push(r.timeToFirstNdjson);
    totals.push(r.total);
  }
  console.log("");
  stats("time-to-spawn (spawn() overhead)", spawns);
  stats("time-to-first-byte", firstBytes);
  stats("time-to-first-NDJSON", firstNdjsons);
  stats("total (process close)", totals);

  console.log("\n=== Summary ===");
  const startupOverhead = median(firstBytes);
  const networkTime = median(totals) - median(firstBytes);
  console.log(`  Estimated startup/JIT overhead: ${startupOverhead.toFixed(0)}ms`);
  console.log(`  Estimated network/inference time: ${networkTime.toFixed(0)}ms`);
  if (startupOverhead > 1000) {
    console.log("  → Process pool would help (startup cost > 1s)");
  } else {
    console.log("  → Process pool may not be needed (startup cost < 1s)");
  }
}

main().catch(err => { console.error(err); process.exit(1); });

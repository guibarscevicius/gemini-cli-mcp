#!/usr/bin/env node
/**
 * Probe: Can Gemini CLI accept prompts via stdin (without --prompt flag)?
 *
 * Tests whether `gemini --yolo --output-format stream-json` (no --prompt arg)
 * accepts a newline-terminated prompt on stdin and responds with NDJSON.
 * Also tests multi-turn reuse (second prompt on same process).
 *
 * Usage: node scripts/probe-stdin.mjs
 */
import { spawn } from "node:child_process";

const WARMUP_MS = 800;   // wait for process to settle before writing
const RESPONSE_TIMEOUT_MS = 15_000;

function readNdjsonFrom(stdout, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    let lineBuffer = "";
    let events = [];
    let resultReceived = false;
    let timer;

    const onData = (data) => {
      lineBuffer += data.toString("utf8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed);
          events.push(evt);
          process.stdout.write(`  [${label}] NDJSON: ${JSON.stringify(evt).slice(0, 120)}\n`);
          if (evt.type === "result") {
            resultReceived = true;
            clearTimeout(timer);
            stdout.removeListener("data", onData);
            resolve({ success: true, events });
          } else if (evt.type === "error") {
            clearTimeout(timer);
            stdout.removeListener("data", onData);
            resolve({ success: false, events, reason: `error event: ${evt.message}` });
          }
        } catch {
          process.stdout.write(`  [${label}] non-JSON line: ${trimmed.slice(0, 80)}\n`);
        }
      }
    };

    stdout.on("data", onData);

    timer = setTimeout(() => {
      stdout.removeListener("data", onData);
      if (!resultReceived) {
        resolve({ success: false, events, reason: `timeout after ${timeoutMs}ms` });
      }
    }, timeoutMs);
  });
}

async function main() {
  console.log("=== Probe: stdin-driven Gemini CLI ===\n");
  console.log("Spawning: gemini --yolo --output-format stream-json (no --prompt)");

  const cp = spawn("gemini", ["--yolo", "--output-format", "stream-json"], {
    env: { HOME: process.env.HOME, PATH: process.env.PATH },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderrBuf = "";
  cp.stderr?.on("data", (d) => {
    stderrBuf += d.toString();
    process.stdout.write(`  [stderr] ${d.toString().trim()}\n`);
  });

  cp.on("error", (err) => {
    console.error("Process error:", err);
    process.exit(1);
  });

  cp.on("close", (code, signal) => {
    console.log(`\n  Process exited: code=${code} signal=${signal}`);
  });

  // Wait for process to initialize
  console.log(`\nWaiting ${WARMUP_MS}ms for process warmup...`);
  await new Promise((r) => setTimeout(r, WARMUP_MS));
  console.log("Warmup done.\n");

  // Check if process already died
  if (cp.exitCode !== null) {
    console.log("RESULT: Process exited during warmup — stdin mode not supported");
    console.log(`  Exit code: ${cp.exitCode}, stderr: ${stderrBuf.slice(0, 200)}`);
    process.exit(0);
  }

  // --- Prompt 1 ---
  console.log("Writing prompt 1: 'Say only: pong'");
  const t1 = Date.now();
  cp.stdin?.write("Say only: pong\n");

  const result1 = await readNdjsonFrom(cp.stdout, "prompt1", RESPONSE_TIMEOUT_MS);
  console.log(`\nPrompt 1 result (${Date.now() - t1}ms):`);
  console.log(`  success: ${result1.success}`);
  if (!result1.success) {
    console.log(`  reason: ${result1.reason}`);
    console.log("\nCONCLUSION: stdin mode does NOT work.");
    cp.kill("SIGTERM");
    process.exit(0);
  }

  const content1 = result1.events
    .filter((e) => e.type === "message" && e.role === "assistant")
    .map((e) => e.content)
    .join("");
  console.log(`  Content: ${content1.trim()}`);

  // Check if process still alive for multi-turn
  if (cp.exitCode !== null) {
    console.log("\nProcess exited after prompt 1 — single-turn only, no multi-turn reuse.");
    console.log("CONCLUSION: stdin mode works for single prompt but not multi-turn.");
    process.exit(0);
  }

  // --- Prompt 2 (multi-turn test) ---
  console.log("\nProcess still alive! Testing multi-turn with prompt 2: 'Say only: ping'");
  const t2 = Date.now();
  cp.stdin?.write("Say only: ping\n");

  const result2 = await readNdjsonFrom(cp.stdout, "prompt2", RESPONSE_TIMEOUT_MS);
  console.log(`\nPrompt 2 result (${Date.now() - t2}ms):`);
  console.log(`  success: ${result2.success}`);
  if (!result2.success) {
    console.log(`  reason: ${result2.reason}`);
    console.log("\nCONCLUSION: stdin mode works for single-turn but fails on second prompt.");
    cp.kill("SIGTERM");
    process.exit(0);
  }

  const content2 = result2.events
    .filter((e) => e.type === "message" && e.role === "assistant")
    .map((e) => e.content)
    .join("");
  console.log(`  Content: ${content2.trim()}`);

  console.log("\n=== CONCLUSION ===");
  console.log("stdin mode WORKS for both single and multi-turn prompts!");
  console.log("→ Warm process pool is feasible.");

  cp.kill("SIGTERM");
}

main().catch(err => { console.error(err); process.exit(1); });

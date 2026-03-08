#!/usr/bin/env node
/**
 * SIGTERM-handling tests for PR #31 test plan (items 7 and 8).
 *
 * Both sub-tests spawn `node dist/index.js` with piped stdio, perform the
 * MCP initialize handshake, then send SIGTERM.  We observe that:
 *   - The server emits the drain message on stderr
 *   - The server exits cleanly (code 0) within a reasonable timeout
 *
 * The MCP stdio transport uses plain newline-delimited JSON (NDJSON).
 *
 * Usage:
 *   node scripts/test-sigterm.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(join(__dirname, ".."));
const serverEntry = join(projectRoot, "dist", "index.js");

const DRAIN_MSG = "[gemini-cli-mcp] received SIGTERM, draining process pool…";
const STARTED_MSG = "gemini-cli-mcp server started";

// ─────────────────────────────────────────────────────────────────────────────
// MCP message helpers
// ─────────────────────────────────────────────────────────────────────────────

function mcpMsg(obj) {
  return JSON.stringify(obj) + "\n";
}

const MSG_INITIALIZE = mcpMsg({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "sigterm-test", version: "1.0" },
  },
});

const MSG_INITIALIZED = mcpMsg({
  jsonrpc: "2.0",
  method: "notifications/initialized",
  params: {},
});

const MSG_ASK_GEMINI = mcpMsg({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: {
    name: "ask-gemini",
    arguments: {
      prompt: "reply with the single word pong",
      // No wait:true — we want an async job so the subprocess is in-flight
      // when SIGTERM arrives
    },
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Server lifecycle helpers
// ─────────────────────────────────────────────────────────────────────────────

function spawnServer(extraEnv = {}) {
  return spawn("node", [serverEntry], {
    env: {
      ...process.env,
      GEMINI_SESSION_DB: ":memory:",
      GEMINI_STRUCTURED_LOGS: "1",
      ...extraEnv,
    },
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Wait until a specific substring appears in stderr output.
 * Resolves with the accumulated stderr string, or rejects on timeout.
 */
function waitForStderr(child, substring, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let accumulated = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for "${substring}" in stderr after ${timeoutMs}ms.\nAccumulated: ${accumulated}`));
    }, timeoutMs);

    function onData(chunk) {
      accumulated += String(chunk);
      if (accumulated.includes(substring)) {
        clearTimeout(timer);
        child.stderr.off("data", onData);
        resolve(accumulated);
      }
    }
    child.stderr.on("data", onData);
  });
}

/**
 * Wait for the process to exit.
 * Resolves with { code, signal, stderr } or rejects on timeout.
 */
function waitForExit(child, timeoutMs = 10_000, currentStderr = "") {
  return new Promise((resolve, reject) => {
    let stderrAcc = currentStderr;
    child.stderr.on("data", (d) => { stderrAcc += String(d); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Process did not exit within ${timeoutMs}ms after SIGTERM. stderr:\n${stderrAcc}`));
    }, timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr: stderrAcc });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-test E — Item 7: SIGTERM during idle (pool warmed, no active request)
// ─────────────────────────────────────────────────────────────────────────────
async function subTestE() {
  console.log(`\n${"─".repeat(60)}`);
  console.log("[Sub-test E] SIGTERM during idle server");

  const server = spawnServer();
  let stderrAcc = "";
  server.stderr.on("data", (d) => { stderrAcc += String(d); });
  // Discard stdout (MCP responses go here)
  server.stdout.resume();

  try {
    // Wait for server to start
    await waitForStderr(server, STARTED_MSG, 15_000);
    console.log("  Server started ✓");

    // Perform MCP handshake so the server is fully initialized
    server.stdin.write(MSG_INITIALIZE);
    server.stdin.write(MSG_INITIALIZED);

    // Wait for pool warmup — give pre-spawned processes time to start
    await new Promise((r) => setTimeout(r, 3_000));
    console.log("  Pool warmup window elapsed ✓");

    // Send SIGTERM
    const sigtermAt = Date.now();
    server.kill("SIGTERM");
    console.log("  SIGTERM sent ✓");

    // Wait for clean exit
    const { code, stderr } = await waitForExit(server, 8_000, stderrAcc);
    const elapsed = Date.now() - sigtermAt;

    const hasDrainMsg = stderr.includes(DRAIN_MSG);
    const cleanExit = code === 0;

    console.log(`  drain message present = ${hasDrainMsg}`);
    console.log(`  exit code = ${code} (expected 0)`);
    console.log(`  exit elapsed = ${elapsed}ms after SIGTERM`);

    const pass = hasDrainMsg && cleanExit;
    console.log(`[Sub-test E] ${pass ? "PASS ✓" : "FAIL ✗"}`);
    return pass;
  } catch (err) {
    console.error(`[Sub-test E] EXCEPTION: ${err.message}`);
    server.kill("SIGKILL");
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-test F — Item 8: SIGTERM during active (in-flight) request
// ─────────────────────────────────────────────────────────────────────────────
async function subTestF() {
  console.log(`\n${"─".repeat(60)}`);
  console.log("[Sub-test F] SIGTERM during active (in-flight) request");

  const server = spawnServer();
  let stderrAcc = "";
  server.stderr.on("data", (d) => { stderrAcc += String(d); });
  server.stdout.resume();

  try {
    // Wait for server to start
    await waitForStderr(server, STARTED_MSG, 15_000);
    console.log("  Server started ✓");

    // Full MCP handshake
    server.stdin.write(MSG_INITIALIZE);
    server.stdin.write(MSG_INITIALIZED);

    // Give pool a moment to spawn warm processes
    await new Promise((r) => setTimeout(r, 2_000));

    // Fire an async ask-gemini (no wait:true) — Gemini subprocess starts running
    server.stdin.write(MSG_ASK_GEMINI);
    console.log("  ask-gemini sent (async, Gemini subprocess now in-flight) ✓");

    // Brief pause to let the job kick off, then immediately SIGTERM
    await new Promise((r) => setTimeout(r, 500));
    const sigtermAt = Date.now();
    server.kill("SIGTERM");
    console.log("  SIGTERM sent ✓");

    // Server should exit promptly — drain() only kills idle pool processes.
    // The in-flight Gemini subprocess is not tracked by the pool, so drain()
    // resolves immediately and process.exit(0) is called right away.
    const { code, stderr } = await waitForExit(server, 8_000, stderrAcc);
    const elapsed = Date.now() - sigtermAt;

    const hasDrainMsg = stderr.includes(DRAIN_MSG);
    const cleanExit = code === 0;
    const promptExit = elapsed < 7_000; // should be well under 7 s

    console.log(`  drain message present = ${hasDrainMsg}`);
    console.log(`  exit code = ${code} (expected 0)`);
    console.log(`  exit elapsed = ${elapsed}ms after SIGTERM (expected < 7000ms)`);

    const pass = hasDrainMsg && cleanExit && promptExit;
    console.log(`[Sub-test F] ${pass ? "PASS ✓" : "FAIL ✗"}`);
    return pass;
  } catch (err) {
    console.error(`[Sub-test F] EXCEPTION: ${err.message}`);
    server.kill("SIGKILL");
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const labels = ["E (SIGTERM idle)", "F (SIGTERM mid-request)"];
const fns = [subTestE, subTestF];
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

#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.join(repoRoot, "dist", "index.js");

const TOOL_NAMES = [
  "ask-gemini",
  "gemini-reply",
  "gemini-poll",
  "gemini-cancel",
  "gemini-health",
  "gemini-sessions",
  "gemini-batch",
  "gemini-research",
];

const RESOURCE_URIS = [
  "gemini://server/health",
  "gemini://sessions",
  "gemini://jobs",
  "gemini://models",
];

const PROMPT_CASES = [
  {
    name: "code-review",
    arguments: { files: "src/index.ts", cwd: repoRoot, focus: "correctness" },
  },
  {
    name: "architecture-analysis",
    arguments: { directory: "src/", cwd: repoRoot, question: "How are MCP tools registered?" },
  },
  {
    name: "explain-code",
    arguments: { file: "src/index.ts", cwd: repoRoot, audience: "intermediate" },
  },
  {
    name: "debug-error",
    arguments: { error: "Error: smoke failure", files: "src/index.ts", cwd: repoRoot },
  },
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function logStep(label, detail = "") {
  process.stdout.write(`${detail ? `${label}: ${detail}` : label}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createStdioClient(child, { isShuttingDown = () => false } = {}) {
  let nextId = 1;
  let buffer = "";
  const pending = new Map();
  const notifications = [];
  const notificationWaiters = [];

  const failPending = (err) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    pending.clear();
    for (const waiter of notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    notificationWaiters.length = 0;
  };

  // Surface a subprocess I/O error to every awaiter — unless we're tearing down on
  // purpose, in which case EPIPE / "write after end" are expected, not regressions.
  const failPendingUnlessShuttingDown = (err) => {
    if (err && !isShuttingDown()) failPending(err);
  };

  // Writes to child.stdin can throw synchronously (destroyed stream) or emit async
  // 'error' events (EPIPE on dead server). Both paths route through failPending so
  // a dead-server write fails loudly with a pending request's awaiter, not silently.
  const writeLine = (payload) => {
    const line = `${JSON.stringify(payload)}\n`;
    try {
      child.stdin.write(line, failPendingUnlessShuttingDown);
    } catch (err) {
      failPendingUnlessShuttingDown(err);
    }
  };

  child.stdin.on("error", failPendingUnlessShuttingDown);

  const handleNotification = (message) => {
    notifications.push(message);
    for (let i = 0; i < notificationWaiters.length; i++) {
      const waiter = notificationWaiters[i];
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      notificationWaiters.splice(i, 1);
      i--;
      waiter.resolve(message);
    }
  };

  const handleMessage = (message) => {
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const entry = pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(message.id);
      if (message.error) {
        entry.reject(
          new Error(
            `JSON-RPC error for ${entry.method}: ${message.error.message ?? JSON.stringify(message.error)}`
          )
        );
        return;
      }
      entry.resolve(message.result);
      return;
    }
    handleNotification(message);
  };

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) {
        try {
          handleMessage(JSON.parse(line));
        } catch (error) {
          failPending(new Error(`Failed to parse server JSON line: ${line}\n${error}`));
        }
      }
      idx = buffer.indexOf("\n");
    }
  });

  child.on("error", (error) => {
    failPending(error);
  });

  child.on("close", (code) => {
    if (isShuttingDown()) return;
    failPending(new Error(`server exited unexpectedly with code ${code ?? "unknown"}`));
  });

  return {
    notifications,
    notify(method, params) {
      writeLine({ jsonrpc: "2.0", method, params });
    },
    request(method, params, timeoutMs = 30_000, id = nextId++) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        writeLine({ jsonrpc: "2.0", id, method, params });
      });
    },
    async waitForNotification(predicate, timeoutMs = 10_000) {
      const existing = notifications.find(predicate);
      if (existing) return existing;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = notificationWaiters.findIndex((entry) => entry.timer === timer);
          if (index !== -1) notificationWaiters.splice(index, 1);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for notification`));
        }, timeoutMs);
        notificationWaiters.push({ predicate, resolve, reject, timer });
      });
    },
  };
}

function parseToolResult(result, label = "<unknown>") {
  if (result?.structuredContent) {
    return result.structuredContent;
  }
  const text = result?.content?.find((item) => item.type === "text")?.text;
  assert(typeof text === "string", `Tool result missing text content (tool: ${label})`);
  try {
    return JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse JSON from tool ${label}: ${message}\nRaw text: ${text}`);
  }
}

async function waitForJobTerminal(client, jobId, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = parseToolResult(
      await client.request("tools/call", { name: "gemini-poll", arguments: { jobId } }, 30_000),
      "gemini-poll"
    );
    if (status.status === "error") {
      throw new Error(`Job ${jobId} failed: ${status.error ?? "(no error message)"}`);
    }
    if (status.status !== "pending") {
      return status;
    }
    await sleep(2_000);
  }
  throw new Error(`Job ${jobId} stayed pending beyond ${timeoutMs}ms`);
}

async function main() {
  assert(existsSync(serverEntry), `Build output not found at ${serverEntry}. Run npm run build first.`);

  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk.toString("utf8"));
  });

  let shuttingDown = false;
  const client = createStdioClient(child, { isShuttingDown: () => shuttingDown });

  try {
    logStep("INIT", "initializing MCP session");
    const initResult = await client.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-smoke", version: "1.0.0" },
      },
      15_000
    );
    assert(initResult?.serverInfo?.name === "gemini-cli-mcp", "Unexpected server name during initialize");
    client.notify("notifications/initialized", {});

    logStep("TOOLS", "listing tools");
    const listedTools = await client.request("tools/list", {}, 15_000);
    const toolNames = listedTools.tools.map((tool) => tool.name).sort();
    assert(toolNames.length === TOOL_NAMES.length, `Expected ${TOOL_NAMES.length} tools, got ${toolNames.length}`);
    for (const toolName of TOOL_NAMES) {
      assert(toolNames.includes(toolName), `Missing tool ${toolName}`);
    }
    logStep("PASS", "tools/list");

    logStep("RESOURCES", "listing resources");
    const resources = await client.request("resources/list", {}, 15_000);
    const resourceUris = resources.resources.map((resource) => resource.uri).sort();
    for (const uri of RESOURCE_URIS) {
      assert(resourceUris.includes(uri), `Missing resource ${uri}`);
    }
    logStep("PASS", "resources/list");

    const resourceTemplates = await client.request("resources/templates/list", {}, 15_000);
    const templateUris = resourceTemplates.resourceTemplates.map((template) => template.uriTemplate).sort();
    assert(templateUris.includes("gemini://sessions/{sessionId}"), "Missing session detail template");
    assert(templateUris.includes("gemini://jobs/{jobId}"), "Missing job detail template");
    logStep("PASS", "resources/templates/list");

    logStep("PROMPTS", "listing prompts");
    const prompts = await client.request("prompts/list", {}, 15_000);
    const promptNames = prompts.prompts.map((prompt) => prompt.name).sort();
    assert(promptNames.length === PROMPT_CASES.length, `Expected ${PROMPT_CASES.length} prompts, got ${promptNames.length}`);
    for (const promptCase of PROMPT_CASES) {
      assert(promptNames.includes(promptCase.name), `Missing prompt ${promptCase.name}`);
      const promptResult = await client.request(
        "prompts/get",
        { name: promptCase.name, arguments: promptCase.arguments },
        15_000
      );
      assert(Array.isArray(promptResult.messages) && promptResult.messages.length > 0, `Prompt ${promptCase.name} returned no messages`);
    }
    logStep("PASS", "prompts/list + prompts/get");

    client.notifications.length = 0;
    await client.request("logging/setLevel", { level: "info" }, 15_000);
    await client.request("tools/call", { name: "gemini-health", arguments: {} }, 30_000);
    const loggingNotification = await client.waitForNotification(
      (message) => message.method === "notifications/message",
      10_000
    );
    assert(loggingNotification.params?.level, "logging notification missing level");
    logStep("PASS", "logging/setLevel + notifications/message");

    const health = parseToolResult(
      await client.request("tools/call", { name: "gemini-health", arguments: {} }, 30_000),
      "gemini-health"
    );
    // Gate on detection success + minimum-version check rather than a pinned exact version,
    // so this smoke harness stays the standard acceptance flow across future upstream bumps.
    assert(typeof health.cli?.version === "string", `Expected CLI version detected, got ${health.cli?.version}`);
    assert(
      health.cli?.versionOk === true,
      `CLI version ${health.cli?.version} does not meet minimum ${health.cli?.minSupported}`
    );
    assert(health.cli?.detectionError == null, `CLI detection failed: ${health.cli?.detectionError}`);
    assert(typeof health.server?.version === "string", "Health response missing server version");
    logStep("PASS", "gemini-health");

    const askAsync = parseToolResult(
      await client.request(
        "tools/call",
        {
          name: "ask-gemini",
          arguments: {
            prompt: "Reply with exactly: smoke-ok",
            model: "gemini-2.5-flash-lite",
            wait: false,
          },
        },
        30_000
      )
    );
    assert(typeof askAsync.jobId === "string", "ask-gemini missing jobId");
    assert(typeof askAsync.sessionId === "string", "ask-gemini missing sessionId");
    assert(typeof askAsync.pollIntervalMs === "number", "ask-gemini missing pollIntervalMs");
    logStep("PASS", "ask-gemini async");

    const sessionId = askAsync.sessionId;
    const firstJobId = askAsync.jobId;

    // gemini-sessions, list path: no sessionId in arguments → returns active sessions.
    const sessionsList = parseToolResult(
      await client.request("tools/call", { name: "gemini-sessions", arguments: {} }, 15_000)
    );
    assert(
      sessionsList.sessions.some((session) => session.id === sessionId),
      `gemini-sessions (list) missing session ${sessionId}`
    );
    assert(typeof sessionsList.total === "number", "gemini-sessions (list) missing total");
    logStep("PASS", "gemini-sessions (list path)");

    const jobsResource = await client.request("resources/read", { uri: "gemini://jobs" }, 15_000);
    const jobsPayload = JSON.parse(jobsResource.contents[0].text);
    assert(Array.isArray(jobsPayload.jobs), "gemini://jobs did not return a jobs array");
    logStep("PASS", "resources/read static jobs");

    const firstJobStatus = await waitForJobTerminal(client, firstJobId, 60_000);
    assert(firstJobStatus.status === "done", `Expected first job done, got ${firstJobStatus.status}`);
    assert(firstJobStatus.response.includes("smoke-ok"), "ask-gemini response did not contain smoke-ok");
    logStep("PASS", "gemini-poll");

    const replyResult = parseToolResult(
      await client.request(
        "tools/call",
        {
          name: "gemini-reply",
          arguments: {
            sessionId,
            prompt: "Now reply with exactly: smoke-reply-ok",
            model: "gemini-2.5-flash-lite",
            wait: true,
          },
        },
        60_000
      )
    );
    assert(replyResult.response.includes("smoke-reply-ok"), "gemini-reply did not return expected content");
    logStep("PASS", "gemini-reply");

    // gemini-sessions, export path: presence of sessionId switches the discriminated tool
    // into export mode (REST-style discriminator — see src/tools/gemini-sessions.ts).
    const exportJson = parseToolResult(
      await client.request(
        "tools/call",
        { name: "gemini-sessions", arguments: { sessionId, format: "json" } },
        15_000
      )
    );
    assert(exportJson.sessionId === sessionId, `Expected exportJson.sessionId === ${sessionId}, got ${exportJson.sessionId}`);
    assert(exportJson.turnCount >= 4, `Expected >=4 turns in JSON export, got ${exportJson.turnCount}`);
    assert(exportJson.format === "json", `Expected format json, got ${exportJson.format}`);

    const exportMarkdown = parseToolResult(
      await client.request(
        "tools/call",
        { name: "gemini-sessions", arguments: { sessionId, format: "markdown" } },
        15_000
      )
    );
    assert(exportMarkdown.content.includes("smoke-ok"), "Markdown export missing expected transcript content");
    assert(exportMarkdown.format === "markdown", `Expected format markdown, got ${exportMarkdown.format}`);
    logStep("PASS", "gemini-sessions (export path) json + markdown");

    const batchResult = parseToolResult(
      await client.request(
        "tools/call",
        {
          name: "gemini-batch",
          arguments: {
            prompts: [
              "Reply with exactly: batch-1",
              "Reply with exactly: batch-2",
            ],
            model: "gemini-2.5-flash-lite",
            wait: true,
          },
        },
        150_000
      )
    );
    assert(batchResult.summary.total === 2, `Expected batch total 2, got ${batchResult.summary.total}`);
    assert(batchResult.results.every((item) => item.status === "done"), "Expected all batch items to succeed");
    logStep("PASS", "gemini-batch");

    const researchResult = parseToolResult(
      await client.request(
        "tools/call",
        {
          name: "gemini-research",
          arguments: {
            query: "What does the phrase smoke test mean in software?",
            depth: "quick",
            model: "gemini-2.5-flash-lite",
            wait: true,
          },
        },
        120_000
      )
    );
    assert(typeof researchResult.response === "string" && researchResult.response.length > 0, "gemini-research returned no response");
    logStep("PASS", "gemini-research");

    // gemini://models is now an MCP Resource, not a tool (#108). Validates that
    // STATIC_RESOURCES registration AND readResource() dispatch both wired correctly.
    const modelsResource = await client.request("resources/read", { uri: "gemini://models" }, 15_000);
    const modelsPayload = JSON.parse(modelsResource.contents[0].text);
    assert(Array.isArray(modelsPayload.models) && modelsPayload.total >= 1, "gemini://models returned no models");
    assert(modelsPayload.total === modelsPayload.models.length, "gemini://models total/length mismatch");
    assert(modelsPayload.source === "curated" || modelsPayload.source === "custom", `gemini://models unexpected source: ${modelsPayload.source}`);
    assert(modelsResource.contents[0].mimeType === "application/json", "gemini://models missing application/json mimeType");
    logStep("PASS", "resources/read gemini://models");

    const healthResource = await client.request("resources/read", { uri: "gemini://server/health" }, 15_000);
    const healthPayload = JSON.parse(healthResource.contents[0].text);
    assert(typeof healthPayload.server?.version === "string", "gemini://server/health missing server version");

    const sessionsResource = await client.request("resources/read", { uri: "gemini://sessions" }, 15_000);
    const sessionsPayload = JSON.parse(sessionsResource.contents[0].text);
    assert(Array.isArray(sessionsPayload.sessions), "gemini://sessions did not return a sessions array");
    logStep("PASS", "resources/read static health + sessions");

    const sessionDetail = await client.request("resources/read", { uri: `gemini://sessions/${sessionId}` }, 15_000);
    const sessionPayload = JSON.parse(sessionDetail.contents[0].text);
    assert(sessionPayload.turnCount >= 4, `Expected session detail turnCount >= 4, got ${sessionPayload.turnCount}`);

    const jobDetail = await client.request("resources/read", { uri: `gemini://jobs/${firstJobId}` }, 15_000);
    const jobPayload = JSON.parse(jobDetail.contents[0].text);
    assert(jobPayload.status === "done", `Expected job detail done, got ${jobPayload.status}`);
    logStep("PASS", "resources/read templated session + job");

    const cancelStart = parseToolResult(
      await client.request(
        "tools/call",
        {
          name: "ask-gemini",
          arguments: {
            prompt: "Write the token cancel-me exactly 200 times, one per line.",
            model: "gemini-2.5-flash-lite",
            wait: false,
          },
        },
        30_000
      )
    );
    const cancelResult = parseToolResult(
      await client.request(
        "tools/call",
        { name: "gemini-cancel", arguments: { jobId: cancelStart.jobId } },
        15_000
      )
    );
    assert(typeof cancelResult.cancelled === "boolean", "gemini-cancel did not return cancelled");
    const cancelStatus = await waitForJobTerminal(client, cancelStart.jobId, 60_000);
    assert(
      cancelStatus.status === "cancelled" || cancelStatus.status === "done",
      `Expected cancelled or done after gemini-cancel, got ${cancelStatus.status}`
    );
    logStep("PASS", "gemini-cancel");

    const cancelRequestId = 9991;
    const requestCancelStart = parseToolResult(
      await client.request(
        "tools/call",
        {
          name: "ask-gemini",
          arguments: {
            prompt: "Write a very long numbered list from 1 to 500 with short explanations.",
            model: "gemini-2.5-flash-lite",
            wait: false,
          },
        },
        30_000,
        cancelRequestId
      )
    );
    client.notify("notifications/cancelled", { requestId: cancelRequestId, reason: "smoke-test cancel" });
    // notifications/cancelled is a protocol-level signal that MAY route to gemini-cancel
    // server-side but is not guaranteed to force-kill an already-running detached subprocess
    // on its own (see docs/plans/2026-04-15-upstream-0381-refresh.md). We verify two things:
    //   1. the server stays healthy and the job is in a known non-error state (not crashed,
    //      not transitioned to "error"), and
    //   2. explicit gemini-cancel still drives the job to terminal within a tight deadline.
    await sleep(2_000);
    const requestCancelPoll = parseToolResult(
      await client.request(
        "tools/call",
        { name: "gemini-poll", arguments: { jobId: requestCancelStart.jobId } },
        30_000
      ),
      "gemini-poll"
    );
    assert(
      requestCancelPoll.status === "pending" ||
        requestCancelPoll.status === "cancelled" ||
        requestCancelPoll.status === "done",
      `notifications/cancelled left job in unexpected state: ${requestCancelPoll.status}`
    );
    parseToolResult(
      await client.request(
        "tools/call",
        { name: "gemini-cancel", arguments: { jobId: requestCancelStart.jobId } },
        15_000
      ),
      "gemini-cancel"
    );
    const requestCancelStatus = await waitForJobTerminal(client, requestCancelStart.jobId, 30_000);
    assert(
      requestCancelStatus.status === "cancelled" || requestCancelStatus.status === "done",
      `Expected request-cancelled job to become manageable, got ${requestCancelStatus.status}`
    );
    logStep("PASS", "notifications/cancelled");

    logStep("SMOKE", "all MCP feature checks passed");
  } finally {
    shuttingDown = true;
    if (child.exitCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGTERM");
      const timedOut = await Promise.race([
        closed.then(() => false),
        sleep(2_000).then(() => true),
      ]);
      if (timedOut && child.exitCode === null) {
        // SIGTERM ignored — escalate rather than leaking a zombie that may keep writing to stderr
        // while the script exits.
        child.kill("SIGKILL");
        await Promise.race([closed, sleep(500)]);
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

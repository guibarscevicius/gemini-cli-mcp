#!/usr/bin/env node
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";

import { askGeminiToolDefinition } from "./tools/ask-gemini.js";
import { geminiReplyToolDefinition } from "./tools/gemini-reply.js";
import { geminiPollToolDefinition } from "./tools/gemini-poll.js";
import { geminiCancelToolDefinition } from "./tools/gemini-cancel.js";
import { geminiHealthToolDefinition } from "./tools/gemini-health.js";
import { geminiListSessionsToolDefinition } from "./tools/gemini-list-sessions.js";
import { geminiExportToolDefinition } from "./tools/gemini-export.js";
import { geminiBatchToolDefinition } from "./tools/gemini-batch.js";
import { geminiResearchToolDefinition } from "./tools/gemini-research.js";
import { handleCallTool } from "./dispatcher.js";
import { getJobByRequestId, unregisterRequest } from "./request-map.js";
import * as jobStore from "./job-store.js";
import { setJobListChangedCallback } from "./job-store.js";
import { warmPool } from "./gemini-runner.js";
import { IdleShutdownController, parseIdleShutdownMs } from "./idle-shutdown.js";
import { initMcpLogger, setMcpLogLevel } from "./logging.js";
import { STATIC_RESOURCES, RESOURCE_TEMPLATES, readResource } from "./resources.js";
import { listPrompts, getPrompt } from "./prompts.js";
import { sessionStore } from "./session-store.js";

const _require = createRequire(import.meta.url);
const { version: pkgVersion } = _require("../package.json") as { version: string };

type ToolServer = Pick<Server, "setRequestHandler" | "getClientCapabilities" | "elicitInput">;
type IdleStateTracker = Pick<
  IdleShutdownController,
  "noteActivity" | "start" | "stop" | "updateActiveJobs"
>;

let idleStateTracker: IdleStateTracker | null = null;
let shuttingDown = false;

function noteServerActivity(): void {
  idleStateTracker?.noteActivity();
}

function syncIdleJobs(): void {
  idleStateTracker?.updateActiveJobs(jobStore.getJobStats().active);
}

function withActivity<TRequest, TResponse>(
  handler: (request: TRequest, extra?: unknown) => Promise<TResponse>
): (request: TRequest, extra?: unknown) => Promise<TResponse> {
  return async (request, extra) => {
    noteServerActivity();
    return handler(request, extra);
  };
}

export function setIdleStateTrackerForTests(tracker: IdleStateTracker | null): void {
  idleStateTracker = tracker;
  shuttingDown = false;
}

export function registerToolHandlers(server: ToolServer): void {
  server.setRequestHandler(ListToolsRequestSchema, withActivity(async () => ({
    tools: [
      askGeminiToolDefinition,
      geminiReplyToolDefinition,
      geminiPollToolDefinition,
      geminiCancelToolDefinition,
      geminiHealthToolDefinition,
      geminiListSessionsToolDefinition,
      geminiExportToolDefinition,
      geminiBatchToolDefinition,
      geminiResearchToolDefinition,
    ],
  })));

  server.setRequestHandler(CallToolRequestSchema, withActivity(async (request, extra) => {
    const { name, arguments: args } = request.params;
    const progressToken = request.params._meta?.progressToken;
    const extraCtx = extra as
      | {
          requestId?: string | number;
          sendNotification?: (notification: unknown) => Promise<void>;
        }
      | undefined;
    const requestId = extraCtx?.requestId;
    const clientCaps = server.getClientCapabilities();
    const ctx = {
      sendNotification: extraCtx?.sendNotification,
      progressToken,
      requestId,
      elicit: clientCaps?.elicitation
        ? (params: Parameters<Server["elicitInput"]>[0]) => server.elicitInput(params)
        : undefined,
    };
    return handleCallTool(name, args, ctx);
  }));
}

export function createServer(): Server {
  const capabilities = {
    tools: {},
    logging: {},
    resources: { listChanged: true },
    prompts: {},
    ...({ elicitation: {} } as Record<string, unknown>),
  } as NonNullable<ConstructorParameters<typeof Server>[1]>["capabilities"];

  const server = new Server(
    { name: "gemini-cli-mcp", version: pkgVersion },
    { capabilities }
  );
  initMcpLogger(server);

  server.setRequestHandler(ListResourcesRequestSchema, withActivity(async () => ({
    resources: STATIC_RESOURCES,
  })));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, withActivity(async () => ({
    resourceTemplates: RESOURCE_TEMPLATES,
  })));

  server.setRequestHandler(ReadResourceRequestSchema, withActivity(async (req) =>
    readResource(req.params.uri)
  ));

  server.setRequestHandler(ListPromptsRequestSchema, withActivity(async () =>
    listPrompts()
  ));

  server.setRequestHandler(GetPromptRequestSchema, withActivity(async (req) =>
    getPrompt(req.params.name, req.params.arguments)
  ));

  const notifyResourceListChanged = () => {
    try {
      server.sendResourceListChanged().catch((err: unknown) => {
        process.stderr.write(
          `[gemini-cli-mcp] sendResourceListChanged failed: ${err instanceof Error ? err.message : String(err)}\n`
        );
      });
    } catch (err) {
      process.stderr.write(
        `[gemini-cli-mcp] sendResourceListChanged threw synchronously: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  };
  setJobListChangedCallback(() => {
    notifyResourceListChanged();
    syncIdleJobs();
  });
  sessionStore.setListChangedCallback(notifyResourceListChanged);
  server.setRequestHandler(SetLevelRequestSchema, withActivity(async (req) => {
    setMcpLogLevel(req.params.level);
    return {};
  }));
  registerToolHandlers(server);
  server.setNotificationHandler(CancelledNotificationSchema, async (notification) => {
    noteServerActivity();
    const requestId = notification.params?.requestId;
    if (requestId === undefined) {
      process.stderr.write(
        "[gemini-cli-mcp] notifications/cancelled with no requestId — ignoring\n"
      );
      return;
    }
    const jobId = getJobByRequestId(requestId);
    if (!jobId) {
      process.stderr.write(`[gemini-cli-mcp] notifications/cancelled: no job registered for requestId ${String(requestId)}\n`);
      return;
    }
    const job = jobStore.getJob(jobId);
    if (job?.status === "pending") {
      if (job.subprocess === undefined) {
        jobStore.cancelJob(jobId);
      }
    }
    if (job && job.status !== "pending") {
      process.stderr.write(`[gemini-cli-mcp] notifications/cancelled: job ${jobId} already ${job.status} — skipping kill\n`);
    }
    unregisterRequest(requestId);
  });
  return server;
}

const server = createServer();

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  idleStateTracker?.stop();
  process.stderr.write(`[gemini-cli-mcp] shutting down (${signal}), draining process pool...\n`);
  if (warmPool !== null) {
    await warmPool.drain();
  }
  process.exit(0);
}

async function main() {
  const transport = new StdioServerTransport();
  shuttingDown = false;
  await server.connect(transport);
  // stderr is safe to use — MCP protocol uses stdout/stdin only
  process.stderr.write("gemini-cli-mcp server started\n");

  const idleShutdownMs = parseIdleShutdownMs(process.env.GEMINI_MCP_IDLE_SHUTDOWN_MS);
  if (idleShutdownMs > 0) {
    idleStateTracker = new IdleShutdownController(idleShutdownMs, async () => {
      if (jobStore.getJobStats().active > 0) {
        syncIdleJobs();
        return;
      }
      try {
        await shutdown(`idle timeout after ${idleShutdownMs}ms`);
      } catch (err) {
        process.stderr.write(
          `[gemini-cli-mcp] idle shutdown error: ${err instanceof Error ? err.message : String(err)}\n`
        );
        process.exit(1);
      }
    });
    idleStateTracker.start();
    syncIdleJobs();
    process.stderr.write(
      `[gemini-cli-mcp] idle shutdown enabled after ${idleShutdownMs}ms of inactivity\n`
    );
  } else {
    idleStateTracker = null;
  }

  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((err) => {
      process.stderr.write(`[gemini-cli-mcp] shutdown error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((err) => {
      process.stderr.write(`[gemini-cli-mcp] shutdown error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
  });
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  if (process.argv.includes("--setup")) {
    import("./setup.js")
      .then(({ runSetup }) => runSetup())
      .then(() => process.exit(0))
      .catch((err) => {
        process.stderr.write(`Setup error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      });
  } else {
    main().catch((err) => {
      process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
  }
}

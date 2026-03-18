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
import { geminiListModelsToolDefinition } from "./tools/gemini-list-models.js";
import { handleCallTool } from "./dispatcher.js";
import { getJobByRequestId, unregisterRequest } from "./request-map.js";
import * as jobStore from "./job-store.js";
import { warmPool } from "./gemini-runner.js";
import { initMcpLogger, setMcpLogLevel } from "./logging.js";
import { STATIC_RESOURCES, RESOURCE_TEMPLATES, readResource } from "./resources.js";
import { listPrompts, getPrompt } from "./prompts.js";
import { sessionStore } from "./session-store.js";

const _require = createRequire(import.meta.url);
const { version: pkgVersion } = _require("../package.json") as { version: string };

type ToolServer = Pick<Server, "setRequestHandler" | "getClientCapabilities" | "elicitInput">;

export function registerToolHandlers(server: ToolServer): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
      geminiListModelsToolDefinition,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const progressToken = request.params._meta?.progressToken;
    const requestId = extra?.requestId as string | number | undefined;
    const clientCaps = server.getClientCapabilities();
    const ctx = {
      sendNotification: extra?.sendNotification as ((n: unknown) => Promise<void>) | undefined,
      progressToken,
      requestId,
      elicit: clientCaps?.elicitation
        ? (params: Parameters<Server["elicitInput"]>[0]) => server.elicitInput(params)
        : undefined,
    };
    return handleCallTool(name, args, ctx);
  });
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

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: STATIC_RESOURCES,
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: RESOURCE_TEMPLATES,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
    readResource(req.params.uri)
  );

  server.setRequestHandler(ListPromptsRequestSchema, async () =>
    listPrompts()
  );

  server.setRequestHandler(GetPromptRequestSchema, async (req) =>
    getPrompt(req.params.name, req.params.arguments)
  );

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
  jobStore.setJobListChangedCallback(notifyResourceListChanged);
  sessionStore.setListChangedCallback(notifyResourceListChanged);
  server.setRequestHandler(SetLevelRequestSchema, async (req) => {
    setMcpLogLevel(req.params.level);
    return {};
  });
  registerToolHandlers(server);
  server.setNotificationHandler(CancelledNotificationSchema, async (notification) => {
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
  process.stderr.write(`[gemini-cli-mcp] received ${signal}, draining process pool…\n`);
  if (warmPool !== null) {
    await warmPool.drain();
  }
  process.exit(0);
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe to use — MCP protocol uses stdout/stdin only
  process.stderr.write("gemini-cli-mcp server started\n");

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

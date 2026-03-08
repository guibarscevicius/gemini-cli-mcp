#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { askGeminiToolDefinition } from "./tools/ask-gemini.js";
import { geminiReplyToolDefinition } from "./tools/gemini-reply.js";
import { geminiPollToolDefinition } from "./tools/gemini-poll.js";
import { geminiCancelToolDefinition } from "./tools/gemini-cancel.js";
import { handleCallTool } from "./dispatcher.js";
import { getJobByRequestId, unregisterRequest } from "./request-map.js";
import * as jobStore from "./job-store.js";

type ToolServer = Pick<Server, "setRequestHandler">;

export function registerToolHandlers(server: ToolServer): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      askGeminiToolDefinition,
      geminiReplyToolDefinition,
      geminiPollToolDefinition,
      geminiCancelToolDefinition,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const progressToken = request.params._meta?.progressToken;
    const requestId = extra?.requestId as string | number | undefined;
    const ctx = {
      sendNotification: extra?.sendNotification as ((n: unknown) => Promise<void>) | undefined,
      progressToken,
      requestId,
    };
    return handleCallTool(name, args, ctx);
  });
}

export function createServer(): Server {
  const server = new Server(
    { name: "gemini-cli-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
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
    if (!jobId) return;
    const job = jobStore.getJob(jobId);
    if (job?.status === "pending") {
      job.subprocess?.kill("SIGTERM");
      jobStore.cancelJob(jobId);
    }
    unregisterRequest(requestId);
  });
  return server;
}

const server = createServer();

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe to use — MCP protocol uses stdout/stdin only
  process.stderr.write("gemini-cli-mcp server started\n");
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

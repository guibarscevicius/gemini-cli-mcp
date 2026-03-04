#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { askGeminiToolDefinition } from "./tools/ask-gemini.js";
import { geminiReplyToolDefinition } from "./tools/gemini-reply.js";
import { handleCallTool } from "./dispatcher.js";

type ToolServer = Pick<Server, "setRequestHandler">;

export function registerToolHandlers(server: ToolServer): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [askGeminiToolDefinition, geminiReplyToolDefinition],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleCallTool(name, args);
  });
}

export function createServer(): Server {
  const server = new Server(
    { name: "gemini-cli-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  registerToolHandlers(server);
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

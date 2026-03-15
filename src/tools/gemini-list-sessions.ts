import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { sessionStore, SESSION_TTL_MS } from "../session-store.js";
import { mcpLog } from "../logging.js";

const GeminiListSessionsSchema = z.object({}).optional();

export interface GeminiListSessionsOutput {
  sessions: Array<{ id: string; lastAccessed: number; turnCount: number; expiresAt: number }>;
  total: number;
}

export async function geminiListSessions(input: unknown): Promise<GeminiListSessionsOutput> {
  GeminiListSessionsSchema.parse(input);

  let rawSessions: ReturnType<typeof sessionStore.listSessions>;
  try {
    rawSessions = sessionStore.listSessions();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gemini-cli-mcp] gemini-list-sessions: listSessions() failed: ${message}\n`);
    mcpLog("error", "sessions", { event: "list_sessions_error", error: message });
    throw new McpError(ErrorCode.InternalError, `Failed to list sessions: ${message}`);
  }

  const sessions = rawSessions.map((session) => ({
    ...session,
    expiresAt: session.lastAccessed + SESSION_TTL_MS,
  }));

  return {
    sessions,
    total: sessions.length,
  };
}

export const geminiListSessionsToolDefinition: Tool = {
  name: "gemini-list-sessions",
  title: "List Gemini Sessions",
  description:
    "List active Gemini sessions with id, last-access timestamp, turn count, and expiry timestamp.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      sessions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            lastAccessed: { type: "number" },
            turnCount: { type: "number" },
            expiresAt: { type: "number" },
          },
          required: ["id", "lastAccessed", "turnCount", "expiresAt"],
        },
      },
      total: { type: "number" },
    },
    required: ["sessions", "total"],
  },
  annotations: {
    title: "List Gemini Sessions",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

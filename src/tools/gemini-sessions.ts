import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { sessionStore, SESSION_TTL_MS, type Turn } from "../session-store.js";
import { mcpLog } from "../logging.js";

export const GeminiSessionsSchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "When omitted, returns the list of active sessions. When provided, returns the full conversation history of that session."
    ),
  format: z
    .enum(["json", "markdown"])
    .optional()
    .default("json")
    .describe("Export format (only used when sessionId is provided): json (default) or markdown."),
  lastN: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Only used when sessionId is provided. Export only the last N individual messages (turns). A single user+assistant exchange is 2 turns. Omit for full history."
    ),
});
export type GeminiSessionsInput = z.infer<typeof GeminiSessionsSchema>;

export interface GeminiSessionsListOutput {
  sessions: Array<{ id: string; lastAccessed: number; turnCount: number; expiresAt: number }>;
  total: number;
}

export interface GeminiSessionsExportOutput {
  sessionId: string;
  turnCount: number;
  totalTurnCount?: number;
  format: "json" | "markdown";
  turns: Turn[];
  lastN?: number;
  content: string;
  exportedAt: string;
}

export type GeminiSessionsOutput = GeminiSessionsListOutput | GeminiSessionsExportOutput;

export async function geminiSessions(input: unknown): Promise<GeminiSessionsOutput> {
  const { sessionId, format, lastN } = GeminiSessionsSchema.parse(input ?? {});

  if (sessionId === undefined) {
    let rawSessions: ReturnType<typeof sessionStore.listSessions>;
    try {
      rawSessions = sessionStore.listSessions();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[gemini-cli-mcp] gemini-sessions: listSessions() failed: ${message}\n`);
      mcpLog("error", "sessions", { event: "list_sessions_error", error: message });
      throw new McpError(ErrorCode.InternalError, `Failed to list sessions: ${message}`);
    }

    const sessions = rawSessions.map((session) => ({
      ...session,
      expiresAt: session.lastAccessed + SESSION_TTL_MS,
    }));

    return { sessions, total: sessions.length };
  }

  const turns = sessionStore.getTurns(sessionId);
  if (turns === undefined) {
    throw new McpError(ErrorCode.InvalidParams, `Session not found or expired: ${sessionId}`);
  }
  const filteredTurns = lastN !== undefined ? turns.slice(-lastN) : turns;

  const content =
    format === "markdown"
      ? filteredTurns
          .map((t) => `**${t.role === "user" ? "User" : "Assistant"}:** ${t.content}`)
          .join("\n\n")
      : JSON.stringify(filteredTurns, null, 2);

  return {
    sessionId,
    turnCount: filteredTurns.length,
    format,
    turns: filteredTurns,
    ...(lastN !== undefined ? { lastN } : {}),
    ...(lastN !== undefined ? { totalTurnCount: turns.length } : {}),
    content,
    exportedAt: new Date().toISOString(),
  };
}

export const geminiSessionsToolDefinition: Tool = {
  name: "gemini-sessions",
  title: "Gemini Sessions",
  description:
    "List or export Gemini sessions. If sessionId is omitted, returns the list of active sessions " +
    "(id, lastAccessed, turnCount, expiresAt). If sessionId is provided, returns the full " +
    "conversation history (turns + pre-rendered content) in the requested format.",
  inputSchema: {
    type: "object" as const,
    properties: {
      sessionId: {
        type: "string",
        description:
          "Optional. When omitted, returns the list of active sessions. When provided, returns the full conversation history of that session.",
      },
      format: {
        type: "string",
        enum: ["json", "markdown"],
        description: "Export format (only used when sessionId is provided; default: json).",
      },
      lastN: {
        type: "integer",
        description:
          "Only used when sessionId is provided. Export only the last N individual messages (turns). A single user+assistant exchange is 2 turns.",
      },
    },
    required: [],
  },
  outputSchema: {
    type: "object" as const,
    oneOf: [
      {
        type: "object",
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
      {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          turnCount: { type: "integer" },
          format: { type: "string", enum: ["json", "markdown"] },
          lastN: { type: "integer" },
          totalTurnCount: { type: "integer" },
          turns: {
            type: "array",
            items: {
              type: "object",
              properties: {
                role: { type: "string", enum: ["user", "assistant"] },
                content: { type: "string" },
              },
              required: ["role", "content"],
            },
          },
          content: { type: "string" },
          exportedAt: { type: "string" },
        },
        required: ["sessionId", "turnCount", "format", "turns", "content", "exportedAt"],
      },
    ],
  },
  annotations: {
    title: "Gemini Sessions",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

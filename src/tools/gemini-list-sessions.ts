import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { sessionStore, SESSION_TTL_MS } from "../session-store.js";

const GeminiListSessionsSchema = z.object({}).optional();

export interface GeminiListSessionsOutput {
  sessions: Array<{ id: string; lastAccessed: number; turnCount: number; expiresAt: number }>;
  total: number;
}

export async function geminiListSessions(input: unknown): Promise<GeminiListSessionsOutput> {
  GeminiListSessionsSchema.parse(input);

  const sessions = sessionStore.listSessions().map((session) => ({
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

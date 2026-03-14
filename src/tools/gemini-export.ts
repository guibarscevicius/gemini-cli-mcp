import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { sessionStore, type Turn } from "../session-store.js";

export const GeminiExportSchema = z.object({
  sessionId: z.string().min(1).describe("Session ID to export"),
  format: z
    .enum(["json", "markdown"])
    .optional()
    .default("json")
    .describe("Output format: json (default) or markdown"),
});
export type GeminiExportInput = z.infer<typeof GeminiExportSchema>;

export interface GeminiExportOutput {
  sessionId: string;
  /** Convenience count. Always equal to `turns.length`. Constructed only by `geminiExport()`. */
  turnCount: number;
  format: "json" | "markdown";
  turns: Turn[];
  /**
   * Pre-rendered representation of `turns` in the requested `format`.
   * JSON: `JSON.stringify(turns, null, 2)`. Markdown: bold-label paragraphs.
   * Always constructed by `geminiExport()` — do not construct this type directly.
   */
  content: string;
  exportedAt: string;
}

export async function geminiExport(input: unknown): Promise<GeminiExportOutput> {
  const { sessionId, format } = GeminiExportSchema.parse(input);

  const turns = sessionStore.getTurns(sessionId);
  if (turns === undefined) {
    throw new McpError(ErrorCode.InvalidParams, `Session not found or expired: ${sessionId}`);
  }

  const content =
    format === "markdown"
      ? turns
          .map((t) => `**${t.role === "user" ? "User" : "Assistant"}:** ${t.content}`)
          .join("\n\n")
      : JSON.stringify(turns, null, 2);

  return {
    sessionId,
    turnCount: turns.length,
    format,
    turns,
    content,
    exportedAt: new Date().toISOString(),
  };
}

export const geminiExportToolDefinition: Tool = {
  name: "gemini-export",
  title: "Export Gemini Session",
  description:
    "Export a Gemini session's full conversation history as JSON or markdown.",
  inputSchema: {
    type: "object" as const,
    properties: {
      sessionId: { type: "string", description: "Session ID to export" },
      format: {
        type: "string",
        enum: ["json", "markdown"],
        description: "Output format (default: json)",
      },
    },
    required: ["sessionId"],
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      sessionId: { type: "string" },
      turnCount: { type: "integer" },
      format: { type: "string", enum: ["json", "markdown"] },
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
  annotations: {
    title: "Export Gemini Session",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

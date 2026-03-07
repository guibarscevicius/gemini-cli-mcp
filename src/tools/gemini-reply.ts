import { z } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { runGemini } from "../gemini-runner.js";
import { sessionStore } from "../session-store.js";

export const GeminiReplySchema = z.object({
  sessionId: z.string().uuid().describe("Session ID returned by ask-gemini"),
  prompt: z.string().min(1).describe("The follow-up message to send"),
  model: z
    .string()
    .min(1)
    .optional()
    .describe("Gemini model to use. Overrides the model used in the original ask-gemini call."),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Working directory for the Gemini subprocess. Required for any @file path — Gemini enforces a workspace boundary at cwd; files outside the tree are rejected."
    ),
});

export type GeminiReplyInput = z.infer<typeof GeminiReplySchema>;

export interface GeminiReplyOutput {
  response: string;
}

/**
 * Continue an existing Gemini session.
 * Throws McpError(InvalidParams) when the provided sessionId is unknown or expired.
 */
export async function geminiReply(input: unknown): Promise<GeminiReplyOutput> {
  const { sessionId, prompt, model, cwd } = GeminiReplySchema.parse(input);

  const sessionExists = sessionStore.get(sessionId);
  if (!sessionExists) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Session not found or expired: ${sessionId}. Start a new session with ask-gemini.`
    );
  }

  // Prepend conversation history so Gemini has full context
  const history = sessionStore.formatHistory(sessionId);
  const fullPrompt = history ? `${history}\n\n${prompt}` : prompt;

  const response = await runGemini(fullPrompt, {
    model,
    cwd,
    tool: "gemini-reply",
    sessionId,
  });
  sessionStore.appendTurn(sessionId, "user", prompt);
  sessionStore.appendTurn(sessionId, "assistant", response);

  return { response };
}

export const geminiReplyToolDefinition = {
  name: "gemini-reply" as const,
  description:
    "Continue an existing Gemini conversation. Provide the sessionId returned by ask-gemini and a follow-up prompt. History is automatically included.",
  inputSchema: {
    type: "object" as const,
    properties: {
      sessionId: {
        type: "string",
        description: "Session ID returned by ask-gemini",
      },
      prompt: {
        type: "string",
        description: "The follow-up message to send",
      },
      model: {
        type: "string",
        description:
          "Gemini model to use. Overrides the model used in the original ask-gemini call.",
      },
      cwd: {
        type: "string",
        description:
          "Working directory for the subprocess. Required for any @file path (relative or absolute) — Gemini enforces a workspace boundary at cwd; files outside the tree are rejected.",
      },
    },
    required: ["sessionId", "prompt"],
  },
};

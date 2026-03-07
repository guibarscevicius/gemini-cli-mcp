import { z } from "zod";
import { randomUUID } from "node:crypto";
import { runGemini } from "../gemini-runner.js";
import { sessionStore } from "../session-store.js";

export const AskGeminiSchema = z.object({
  prompt: z.string().min(1).describe("The prompt to send to Gemini"),
  model: z
    .string()
    .min(1)
    .optional()
    .describe("Gemini model to use (e.g. gemini-2.5-pro). Defaults to CLI default."),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Working directory for the Gemini subprocess. Required for any @file path — Gemini enforces a workspace boundary at cwd; files outside the tree are rejected."
    ),
});

export type AskGeminiInput = z.infer<typeof AskGeminiSchema>;

export interface AskGeminiOutput {
  sessionId: string;
  response: string;
}

/** Start a new Gemini session and persist the first user/assistant turn atomically. */
export async function askGemini(input: unknown): Promise<AskGeminiOutput> {
  const { prompt, model, cwd } = AskGeminiSchema.parse(input);

  const response = await runGemini(prompt, { model, cwd, tool: "ask-gemini" });
  const sessionId = randomUUID();
  sessionStore.create(sessionId);
  sessionStore.appendTurn(sessionId, "user", prompt);
  sessionStore.appendTurn(sessionId, "assistant", response);

  return { sessionId, response };
}

export const askGeminiToolDefinition = {
  name: "ask-gemini" as const,
  description:
    "Start a new conversation with Gemini. Returns a sessionId that can be passed to gemini-reply to continue the conversation.",
  inputSchema: {
    type: "object" as const,
    properties: {
      prompt: {
        type: "string",
        description: "The prompt to send to Gemini",
      },
      model: {
        type: "string",
        description:
          "Gemini model to use (e.g. gemini-2.5-pro). Defaults to CLI default.",
      },
      cwd: {
        type: "string",
        description:
          "Working directory for the subprocess. Required for any @file path (relative or absolute) — Gemini enforces a workspace boundary at cwd; files outside the tree are rejected.",
      },
    },
    required: ["prompt"],
  },
};

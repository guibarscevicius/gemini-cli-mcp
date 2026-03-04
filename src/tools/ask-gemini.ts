import { z } from "zod";
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
      "Working directory for the Gemini subprocess. Required when using relative @file paths in the prompt."
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

  const response = await runGemini(prompt, { model, cwd });

  // createWithTurn is atomic: the session is never observable with 0 turns
  const sessionId = sessionStore.createWithTurn(prompt, response);

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
          "Working directory for the subprocess. Required when using relative @file paths in the prompt (e.g. @src/auth.ts). Use absolute paths to avoid needing cwd.",
      },
    },
    required: ["prompt"],
  },
};

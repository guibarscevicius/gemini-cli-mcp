import { z } from "zod";
import { randomUUID } from "node:crypto";
import { sessionStore } from "../session-store.js";
import * as jobStore from "../job-store.js";
import type { ToolCallContext } from "../dispatcher.js";
import { runGeminiAsync } from "./shared.js";

export const AskGeminiSchema = z.object({
  prompt: z.string().min(1).describe("The prompt to send to Gemini"),
  model: z
    .string()
    .min(1)
    .optional()
    .describe("Gemini model to use (e.g. gemini-3-flash-preview). Defaults to CLI default."),
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
  jobId: string;
  sessionId: string;
}

/** Start a new Gemini session. Returns immediately with { jobId, sessionId }; poll with gemini-poll. */
export async function askGemini(input: unknown, ctx: ToolCallContext = {}): Promise<AskGeminiOutput> {
  const { prompt, model, cwd } = AskGeminiSchema.parse(input);

  const sessionId = randomUUID();
  const jobId = randomUUID();

  sessionStore.create(sessionId);
  sessionStore.setPendingJob(sessionId, jobId);
  jobStore.createJob(jobId);

  // Fire-and-forget: background job
  runGeminiAsync(jobId, prompt, { model, cwd, tool: "ask-gemini" }, ctx)
    .then((response) => {
      jobStore.completeJob(jobId, response);
      sessionStore.appendTurn(sessionId, "user", prompt);
      sessionStore.appendTurn(sessionId, "assistant", response);
      sessionStore.clearPendingJob(sessionId);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      jobStore.failJob(jobId, message);
      sessionStore.clearPendingJob(sessionId);
    });

  return { jobId, sessionId };
}

export const askGeminiToolDefinition = {
  name: "ask-gemini" as const,
  description:
    "Start a new conversation with Gemini. Returns immediately with { jobId, sessionId }. Poll with gemini-poll to get the response, or cancel with gemini-cancel.",
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
          "Gemini model to use (e.g. gemini-3-flash-preview). Defaults to CLI default.",
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

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { sessionStore } from "../session-store.js";
import * as jobStore from "../job-store.js";
import type { ToolCallContext } from "../dispatcher.js";
import { runGeminiAsync } from "./shared.js";

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
  jobId: string;
}

/**
 * Continue an existing Gemini session.
 * Throws McpError(InvalidParams) when the session is unknown, expired, or has a pending job.
 */
export async function geminiReply(input: unknown, ctx: ToolCallContext = {}): Promise<GeminiReplyOutput> {
  const { sessionId, prompt, model, cwd } = GeminiReplySchema.parse(input);

  const sessionExists = sessionStore.get(sessionId);
  if (!sessionExists) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Session not found or expired: ${sessionId}. Start a new session with ask-gemini.`
    );
  }

  const pendingJobId = sessionStore.getPendingJob(sessionId);
  if (pendingJobId !== undefined) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Session ${sessionId} has a pending job (${pendingJobId}). Poll with gemini-poll or cancel with gemini-cancel before sending a new message.`
    );
  }

  const jobId = randomUUID();
  sessionStore.setPendingJob(sessionId, jobId);
  jobStore.createJob(jobId);

  // Prepend conversation history so Gemini has full context
  const history = sessionStore.formatHistory(sessionId);
  const fullPrompt = history ? `${history}\n\n${prompt}` : prompt;

  // Fire-and-forget: background job
  runGeminiAsync(jobId, fullPrompt, { model, cwd, tool: "gemini-reply", sessionId }, ctx)
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

  return { jobId };
}

export const geminiReplyToolDefinition = {
  name: "gemini-reply" as const,
  description:
    "Continue an existing Gemini conversation. Returns immediately with { jobId }. Poll with gemini-poll to get the response. Throws if the session has a pending job.",
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

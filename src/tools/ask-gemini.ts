import { z } from "zod";
import { randomUUID } from "node:crypto";
import { runGemini, spawnGemini, type GeminiExecutor } from "../gemini-runner.js";
import { sessionStore } from "../session-store.js";
import * as jobStore from "../job-store.js";
import type { ToolCallContext } from "../dispatcher.js";

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

/**
 * Fire-and-forget helper: runs runGemini in the background, updating job state as
 * chunks arrive. The subprocess reference is stored in the job for cancellation.
 */
async function runGeminiAsync(
  jobId: string,
  prompt: string,
  opts: { model?: string; cwd?: string; tool: string; sessionId?: string },
  ctx: ToolCallContext
): Promise<string> {
  const job = jobStore.getJob(jobId)!;

  const onChunk = (chunk: string) => {
    jobStore.appendChunk(jobId, chunk);
    if (ctx.progressToken !== undefined && ctx.sendNotification) {
      ctx.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: ctx.progressToken,
          progress: job.partialResponse.length,
          total: undefined,
        },
      }).catch(() => {});
    }
  };

  // Custom executor that captures the ChildProcess for cancellation
  const executor: GeminiExecutor = (args, execOpts, chunkCb) =>
    new Promise((resolve, reject) => {
      const cp = spawnGemini(
        args,
        { env: execOpts.env, cwd: execOpts.cwd, timeout: execOpts.timeout },
        chunkCb ?? (() => {}),
        (fullText) => resolve({ stdout: fullText }),
        reject
      );
      job.subprocess = cp;
    });

  try {
    const response = await runGemini(prompt, opts, executor, onChunk);
    return response;
  } finally {
    job.subprocess = undefined;
  }
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

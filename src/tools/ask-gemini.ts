import { z } from "zod";
import { randomUUID } from "node:crypto";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { sessionStore } from "../session-store.js";
import * as jobStore from "../job-store.js";
import type { ToolCallContext } from "../dispatcher.js";
import { runGeminiAsync } from "./shared.js";
import { registerRequest, unregisterRequest } from "../request-map.js";

const WAIT_TIMEOUT = Symbol("wait-timeout");

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
  wait: z
    .boolean()
    .optional()
    .describe("If true, block until done and return the response directly (default: false)"),
  waitTimeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Timeout for wait mode in ms (default 90000). Falls back to async on timeout."),
});

export type AskGeminiInput = z.infer<typeof AskGeminiSchema>;

export interface AskGeminiOutput {
  jobId: string;
  sessionId: string;
  pollIntervalMs: number;
  response?: string;
  timedOut?: boolean;
}

/** Start a new Gemini session. Returns immediately with { jobId, sessionId }; poll with gemini-poll. */
export async function askGemini(input: unknown, ctx: ToolCallContext = {}): Promise<AskGeminiOutput> {
  const { prompt, model, cwd, wait, waitTimeoutMs } = AskGeminiSchema.parse(input);

  const sessionId = randomUUID();
  const jobId = randomUUID();

  sessionStore.create(sessionId);
  sessionStore.setPendingJob(sessionId, jobId);
  jobStore.createJob(jobId);
  if (ctx.requestId !== undefined) {
    registerRequest(ctx.requestId, jobId);
  }

  // Background job — fire-and-forget in async mode, raced via job.completion in wait mode.
  // This .then/.catch chain always owns request-map cleanup.
  runGeminiAsync(jobId, prompt, { model, cwd, tool: "ask-gemini" }, ctx)
    .then((response) => {
      jobStore.completeJob(jobId, response);
      sessionStore.appendTurn(sessionId, "user", prompt);
      sessionStore.appendTurn(sessionId, "assistant", response);
      sessionStore.clearPendingJob(sessionId);
      if (ctx.requestId !== undefined) {
        unregisterRequest(ctx.requestId);
      }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[gemini-cli-mcp] job ${jobId} failed: ${message}\n`);
      jobStore.failJob(jobId, message);
      sessionStore.clearPendingJob(sessionId);
      if (ctx.requestId !== undefined) {
        unregisterRequest(ctx.requestId);
      }
    });

  if (wait === true) {
    const job = jobStore.getJob(jobId)!;
    const ms = waitTimeoutMs ?? 90_000;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<never>((_, rej) => {
      timerId = setTimeout(() => rej(WAIT_TIMEOUT), ms);
    });

    try {
      const response = await Promise.race([job.completion, timer]);
      return { jobId, sessionId, response, pollIntervalMs: 2000 };
    } catch (err) {
      if (err === WAIT_TIMEOUT) {
        process.stderr.write(`[gemini-cli-mcp] wait-mode timed out after ${ms}ms for job ${jobId} — falling back to async\n`);
        return { jobId, sessionId, pollIntervalMs: 2000, timedOut: true };
      }
      throw new McpError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
    } finally {
      if (timerId !== undefined) clearTimeout(timerId);
    }
  }
  return { jobId, sessionId, pollIntervalMs: 2000 };
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
      wait: {
        type: "boolean",
        description:
          "If true, block until done and return the response directly (default: false)",
      },
      waitTimeoutMs: {
        type: "number",
        description:
          "Timeout for wait mode in ms (default 90000). Falls back to async on timeout.",
      },
    },
    required: ["prompt"],
  },
};

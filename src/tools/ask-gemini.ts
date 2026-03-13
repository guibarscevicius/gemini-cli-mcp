import { z } from "zod";
import { randomUUID } from "node:crypto";
import { McpError, ErrorCode, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { sessionStore } from "../session-store.js";
import * as jobStore from "../job-store.js";
import type { ToolCallContext } from "../dispatcher.js";
import { runGeminiAsync, waitForJob, DEFAULT_WAIT_MS } from "./shared.js";
import { registerRequest, unregisterRequest } from "../request-map.js";
import { SemaphoreTimeoutError } from "../gemini-runner.js";

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
  expandRefs: z
    .boolean()
    .optional()
    .describe("Set to false to disable @file reference expansion. Useful when prompts contain framework @ syntax (e.g. Vue @click)."),
});

export type AskGeminiInput = z.infer<typeof AskGeminiSchema>;

export interface AskGeminiOutput {
  jobId: string;
  sessionId: string;
  pollIntervalMs: number;
  response?: string;
  partialResponse?: string;
  timedOut?: boolean;
}

/**
 * Start a new Gemini session.
 * Blocks and streams progress notifications when ctx.progressToken is set (MCP-native streaming).
 * Also blocks when wait: true is passed explicitly (legacy mode).
 * Returns immediately with { jobId, sessionId } otherwise.
 */
export async function askGemini(input: unknown, ctx: ToolCallContext = {}): Promise<AskGeminiOutput> {
  const { prompt, model, cwd, wait, waitTimeoutMs, expandRefs } = AskGeminiSchema.parse(input);

  const sessionId = randomUUID();
  const jobId = randomUUID();

  sessionStore.create(sessionId);
  sessionStore.setPendingJob(sessionId, jobId);
  jobStore.createJob(jobId);
  if (ctx.requestId !== undefined) {
    registerRequest(ctx.requestId, jobId);
  }

  // Background job — fire-and-forget in async mode, raced via job.completion in wait/streaming mode.
  // This .then/.catch chain always owns request-map cleanup.
  runGeminiAsync(jobId, prompt, { model, cwd, tool: "ask-gemini", expandRefs }, ctx)
    .then((response) => {
      jobStore.completeJob(jobId, response);
      try {
        sessionStore.appendTurn(sessionId, "user", prompt);
        sessionStore.appendTurn(sessionId, "assistant", response);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[gemini-cli-mcp] session ${sessionId} history update failed (non-fatal): ${msg}\n`
        );
      } finally {
        sessionStore.clearPendingJob(sessionId);
      }
      if (ctx.requestId !== undefined) {
        unregisterRequest(ctx.requestId);
      }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[gemini-cli-mcp] job ${jobId} failed: ${message}\n`);
      try {
        jobStore.failJob(jobId, message);
        sessionStore.clearPendingJob(sessionId);
      } finally {
        if (ctx.requestId !== undefined) {
          unregisterRequest(ctx.requestId);
        }
      }
    });

  // Block when the MCP client provides a progressToken (native streaming) or when wait: true.
  const shouldBlock = wait === true || ctx.progressToken !== undefined;

  if (shouldBlock) {
    try {
      const result = await waitForJob(jobId, waitTimeoutMs ?? DEFAULT_WAIT_MS);
      // Stop the background onChunk from sending further notifications after the
      // tool call returns. Works because onChunk checks ctx.progressToken before sending.
      delete ctx.progressToken;
      if (result.timedOut) {
        // unregister so a late notifications/cancelled from the MCP
        // client cannot kill the still-running background job
        if (ctx.requestId !== undefined) unregisterRequest(ctx.requestId);
        return { jobId, sessionId, partialResponse: result.partialResponse, timedOut: true, pollIntervalMs: 2000 };
      }
      return { jobId, sessionId, response: result.response, pollIntervalMs: 2000 };
    } catch (err) {
      // Stop the background onChunk from sending further notifications after the
      // tool call returns. Works because onChunk checks ctx.progressToken before sending.
      delete ctx.progressToken;
      if (err instanceof SemaphoreTimeoutError) {
        throw new McpError(ErrorCode.InvalidRequest, err.message);
      }
      throw new McpError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
    }
  }

  return { jobId, sessionId, pollIntervalMs: 2000 };
}

export const askGeminiToolDefinition: Tool = {
  name: "ask-gemini",
  title: "Ask Gemini",
  description:
    "Start a new conversation with Gemini. If the MCP client supports progress notifications (progressToken present), blocks and streams partial responses as notifications/progress events, then returns the final response inline. Otherwise returns immediately with { jobId, sessionId }; poll with gemini-poll or cancel with gemini-cancel.",
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
      expandRefs: {
        type: "boolean",
        description:
          "Set to false to disable @file reference expansion. Useful when prompts contain framework @ syntax (e.g. Vue @click).",
      },
    },
    required: ["prompt"],
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      jobId: { type: "string" },
      sessionId: { type: "string" },
      pollIntervalMs: { type: "number" },
      response: { type: "string" },
      partialResponse: { type: "string" },
      timedOut: { type: "boolean" },
    },
    required: ["jobId", "sessionId", "pollIntervalMs"],
  },
  annotations: {
    title: "Ask Gemini",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

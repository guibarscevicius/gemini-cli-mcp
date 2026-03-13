import { z } from "zod";
import { randomUUID } from "node:crypto";
import { McpError, ErrorCode, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { sessionStore } from "../session-store.js";
import * as jobStore from "../job-store.js";
import type { ToolCallContext } from "../dispatcher.js";
import { runGeminiAsync, waitForJob, DEFAULT_WAIT_MS } from "./shared.js";
import { registerRequest, unregisterRequest } from "../request-map.js";

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

export type GeminiReplyInput = z.infer<typeof GeminiReplySchema>;

export interface GeminiReplyOutput {
  jobId: string;
  pollIntervalMs: number;
  response?: string;
  partialResponse?: string;
  timedOut?: boolean;
}

/**
 * Continue an existing Gemini session.
 * Blocks and streams progress notifications when ctx.progressToken is set (MCP-native streaming).
 * Also blocks when wait: true is passed explicitly (legacy mode).
 * Returns immediately with { jobId } otherwise.
 * Throws McpError(InvalidParams) when the session is unknown, expired, or has a pending job.
 */
export async function geminiReply(input: unknown, ctx: ToolCallContext = {}): Promise<GeminiReplyOutput> {
  const { sessionId, prompt, model, cwd, wait, waitTimeoutMs, expandRefs } = GeminiReplySchema.parse(input);

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
  if (ctx.requestId !== undefined) {
    registerRequest(ctx.requestId, jobId);
  }

  // Prepend conversation history so Gemini has full context
  const history = sessionStore.formatHistory(sessionId);
  const fullPrompt = history ? `${history}\n\n${prompt}` : prompt;

  // Fire-and-forget: background job
  runGeminiAsync(jobId, fullPrompt, { model, cwd, tool: "gemini-reply", sessionId, expandRefs }, ctx)
    .then((response) => {
      jobStore.completeJob(jobId, response);
      try {
        sessionStore.appendTurn(sessionId, "user", prompt);
        sessionStore.appendTurn(sessionId, "assistant", response);
        sessionStore.clearPendingJob(sessionId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[gemini-cli-mcp] session ${sessionId} history update failed (non-fatal): ${msg}\n`
        );
      }
      if (ctx.requestId !== undefined) unregisterRequest(ctx.requestId);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[gemini-cli-mcp] job ${jobId} failed: ${message}\n`);
      try {
        jobStore.failJob(jobId, message);
        sessionStore.clearPendingJob(sessionId);
      } finally {
        if (ctx.requestId !== undefined) unregisterRequest(ctx.requestId);
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
        return { jobId, partialResponse: result.partialResponse, timedOut: true, pollIntervalMs: 2000 };
      }
      return { jobId, response: result.response, pollIntervalMs: 2000 };
    } catch (err) {
      // Stop the background onChunk from sending further notifications after the
      // tool call returns. Works because onChunk checks ctx.progressToken before sending.
      delete ctx.progressToken;
      throw new McpError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
    }
  }

  return { jobId, pollIntervalMs: 2000 };
}

export const geminiReplyToolDefinition: Tool = {
  name: "gemini-reply",
  title: "Continue Gemini Session",
  description:
    "Continue an existing Gemini conversation. If the MCP client supports progress notifications (progressToken present), blocks and streams partial responses as notifications/progress events, then returns the final response inline. Otherwise returns immediately with { jobId }; poll with gemini-poll. Throws if the session has a pending job.",
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
    required: ["sessionId", "prompt"],
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      jobId: { type: "string" },
      pollIntervalMs: { type: "number" },
      response: { type: "string" },
      partialResponse: { type: "string" },
      timedOut: { type: "boolean" },
    },
    required: ["jobId", "pollIntervalMs"],
  },
  annotations: {
    title: "Continue Gemini Session",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

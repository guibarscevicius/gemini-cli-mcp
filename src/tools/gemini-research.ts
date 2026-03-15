import { z } from "zod";
import { randomUUID } from "node:crypto";
import { McpError, ErrorCode, type Tool } from "@modelcontextprotocol/sdk/types.js";
import * as jobStore from "../job-store.js";
import type { ToolCallContext } from "../dispatcher.js";
import { runGeminiAsync, waitForJob, DEFAULT_WAIT_MS, elicitCwdIfNeeded } from "./shared.js";
import { registerRequest, unregisterRequest } from "../request-map.js";
import { countFileRefs, SemaphoreTimeoutError } from "../gemini-runner.js";
import { mcpLog } from "../logging.js";

export const GeminiResearchSchema = z.object({
  query: z.string().min(1).describe("research question or investigation topic"),
  depth: z.enum(["quick", "standard", "deep"]).optional().default("standard"),
  model: z
    .string()
    .min(1)
    .optional()
    .describe("Gemini model to use (e.g. gemini-3-flash-preview, gemini-3.1-pro-preview). Defaults to CLI default."),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Required when the prompt contains 2 or more @file references. A single @file ref is resolved by the CLI without cwd. If cwd is omitted with 2+ @file refs and the client supports elicitation, you will be prompted to provide it."
    ),
  expandRefs: z
    .boolean()
    .optional()
    .describe("Set to false to disable @file reference expansion. Useful when prompts contain framework @ syntax (e.g. Vue @click)."),
  wait: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true (default), block until done and return the response directly."),
  waitTimeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Timeout for wait mode in ms. Defaults to 90000 for quick/standard depth, 180000 for deep. Falls back to async on timeout."),
});

export type GeminiResearchInput = z.infer<typeof GeminiResearchSchema>;

export type GeminiResearchOutput =
  | { jobId: string; pollIntervalMs: number }
  | { jobId: string; response: string; pollIntervalMs: number }
  | { jobId: string; partialResponse: string; timedOut: true; pollIntervalMs: number };

const DEPTH_PREAMBLES = {
  quick:
    "Answer the following question directly and concisely. Prefer existing knowledge; use web search only if current/real-time data is clearly needed.\n\n",
  standard:
    "Research and answer the following question thoroughly. Use web search to verify facts and gather current information. Synthesize findings into a well-structured response with key findings highlighted.\n\n",
  deep:
    "Conduct a comprehensive research investigation into the following question. Use multiple web searches, cross-reference sources, explore subtopics, and verify claims from independent sources. Produce a detailed report with: executive summary, key findings, supporting evidence, uncertainties or conflicting information, and actionable conclusions.\n\n",
} as const;

const DEEP_WAIT_MS = 180_000;

export async function geminiResearch(
  input: unknown,
  ctx: ToolCallContext = {}
): Promise<GeminiResearchOutput> {
  const { query, depth, model, cwd, expandRefs, wait, waitTimeoutMs } = GeminiResearchSchema.parse(input);
  const resolvedCwd = await elicitCwdIfNeeded(query, cwd, ctx);
  if (resolvedCwd === null) {
    throw new McpError(ErrorCode.InvalidParams, "cwd is required for @file expansion — cancelled by user");
  }
  if (resolvedCwd === undefined && countFileRefs(query) >= 2) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "cwd is required when prompt contains multiple @file references. Provide cwd or use an MCP client that supports elicitation."
    );
  }
  const effectiveCwd = resolvedCwd ?? cwd;

  const jobId = randomUUID();
  jobStore.createJob(jobId);
  if (ctx.requestId !== undefined) {
    registerRequest(ctx.requestId, jobId);
  }

  const fullPrompt = DEPTH_PREAMBLES[depth] + query;

  runGeminiAsync(jobId, fullPrompt, { model, cwd: effectiveCwd, tool: "gemini-research", expandRefs }, ctx)
    .then((response) => {
      try {
        jobStore.completeJob(jobId, response);
        mcpLog("info", "jobs", { event: "job_completed", jobId });
      } finally {
        if (ctx.requestId !== undefined) {
          unregisterRequest(ctx.requestId);
        }
      }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[gemini-cli-mcp] job ${jobId} failed: ${message}\n`);
      mcpLog("error", "jobs", { event: "job_failed", jobId, error: message });
      try {
        jobStore.failJob(jobId, message);
      } finally {
        if (ctx.requestId !== undefined) {
          unregisterRequest(ctx.requestId);
        }
      }
    });

  const shouldBlock = wait === true || ctx.progressToken !== undefined;

  if (shouldBlock) {
    try {
      const defaultWaitTimeoutMs = depth === "deep" ? DEEP_WAIT_MS : DEFAULT_WAIT_MS;
      const result = await waitForJob(jobId, waitTimeoutMs ?? defaultWaitTimeoutMs);
      delete ctx.progressToken;
      if (result.timedOut) {
        if (ctx.requestId !== undefined) unregisterRequest(ctx.requestId);
        return { jobId, partialResponse: result.partialResponse ?? "", timedOut: true, pollIntervalMs: 2000 };
      }
      return { jobId, response: result.response ?? "", pollIntervalMs: 2000 };
    } catch (err) {
      delete ctx.progressToken;
      if (err instanceof SemaphoreTimeoutError) {
        throw new McpError(ErrorCode.InvalidRequest, err.message);
      }
      throw new McpError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
    }
  }

  return { jobId, pollIntervalMs: 2000 };
}

export const geminiResearchToolDefinition: Tool = {
  name: "gemini-research",
  title: "Gemini Research",
  description:
    "Run a research-oriented Gemini query. Supports quick, standard, and deep investigation modes. " +
    "By default (wait: true), blocks and returns the full answer inline; with wait: false, returns a jobId for polling.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "research question or investigation topic",
      },
      depth: {
        type: "string",
        enum: ["quick", "standard", "deep"],
        description: "Research depth preset (default: standard)",
      },
      model: {
        type: "string",
        description:
          "Gemini model to use (e.g. gemini-3-flash-preview, gemini-3.1-pro-preview). Defaults to CLI default.",
      },
      cwd: {
        type: "string",
        description:
          "Required when the prompt contains 2 or more @file references. A single @file ref is resolved by the CLI without cwd. If cwd is omitted with 2+ @file refs and the client supports elicitation, you will be prompted to provide it.",
      },
      expandRefs: {
        type: "boolean",
        description:
          "Set to false to disable @file reference expansion. Useful when prompts contain framework @ syntax (e.g. Vue @click).",
      },
      wait: {
        type: "boolean",
        description: "If true (default), block until done and return the response directly.",
      },
      waitTimeoutMs: {
        type: "number",
        description:
          "Timeout for wait mode in ms. Defaults to 90000 for quick/standard depth, 180000 for deep. Falls back to async on timeout.",
      },
    },
    required: ["query"],
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
    title: "Gemini Research",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

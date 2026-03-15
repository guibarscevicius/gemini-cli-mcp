import { z } from "zod";
import { randomUUID } from "node:crypto";
import { McpError, ErrorCode, type Tool } from "@modelcontextprotocol/sdk/types.js";
import * as jobStore from "../job-store.js";
import type { ToolCallContext } from "../dispatcher.js";
import { countFileRefs } from "../gemini-runner.js";
import { mcpLog } from "../logging.js";
import { runGeminiAsync, elicitCwdIfNeeded } from "./shared.js";

export const GeminiBatchSchema = z.object({
  prompts: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .describe("1–20 independent prompts to run in parallel"),
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
    .describe("Set to false to disable @file reference expansion."),
  wait: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "If true (default), block until all prompts complete and return all results inline. " +
        "If false, return job IDs immediately for polling with gemini-poll."
    ),
});

export type GeminiBatchInput = z.infer<typeof GeminiBatchSchema>;

export type GeminiBatchSyncOutput = {
  results: Array<{
    index: number;
    status: "done" | "error";
    response?: string;
    error?: string;
  }>;
  summary: { total: number; succeeded: number; failed: number; durationMs: number };
};

export type GeminiBatchAsyncOutput = {
  jobs: Array<{ index: number; jobId: string }>;
  pollIntervalMs: number;
};

export type GeminiBatchOutput = GeminiBatchSyncOutput | GeminiBatchAsyncOutput;

/**
 * Run multiple independent prompts in parallel using the existing concurrency
 * infrastructure (semaphore + warm pool). Stateless — no sessions are created.
 *
 * Sync mode (wait: true, default): blocks until all prompts complete and returns
 * all results inline. Individual failures are isolated — other items still succeed.
 *
 * Async mode (wait: false): returns job IDs immediately; use gemini-poll per item.
 */
export async function geminiBatch(input: unknown, ctx: ToolCallContext = {}): Promise<GeminiBatchOutput> {
  const { prompts, model, cwd, expandRefs, wait } = GeminiBatchSchema.parse(input);
  const startMs = Date.now();
  const firstPromptNeedingCwd = prompts.find((prompt) => countFileRefs(prompt) >= 2);
  let effectiveCwd = cwd;
  if (firstPromptNeedingCwd !== undefined) {
    const resolvedCwd = await elicitCwdIfNeeded(firstPromptNeedingCwd, cwd, ctx);
    if (resolvedCwd === null) {
      throw new McpError(ErrorCode.InvalidParams, "cwd is required for @file expansion — cancelled by user");
    }
    if (resolvedCwd === undefined) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "cwd is required when prompt contains multiple @file references. Provide cwd or use an MCP client that supports elicitation."
      );
    }
    effectiveCwd = resolvedCwd;
  }

  const items = prompts.map((prompt, index) => ({
    index,
    prompt,
    jobId: randomUUID(),
  }));

  // Create all jobs and fire them all in parallel (semaphore queues excess calls).
  // We pass {} (empty ToolCallContext) intentionally: each batch item is an independent
  // fire-and-forget job, and there is no sensible way to multiplex N partial-response
  // streams through a single MCP progressToken. Individual jobs can be cancelled
  // post-hoc via gemini-cancel using the jobId returned in async mode.
  for (const { jobId, prompt } of items) {
    jobStore.createJob(jobId);
    runGeminiAsync(jobId, prompt, { model, cwd: effectiveCwd, tool: "gemini-batch", expandRefs }, {})
      .then((response) => {
        jobStore.completeJob(jobId, response);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[gemini-cli-mcp] gemini-batch job ${jobId} failed: ${message}\n`
        );
        mcpLog("error", "jobs", { event: "job_failed", jobId, error: message });
        jobStore.failJob(jobId, message);
      });
  }

  // Async mode: return job IDs immediately; caller polls with gemini-poll
  if (!wait) {
    return {
      jobs: items.map(({ index, jobId }) => ({ index, jobId })),
      pollIntervalMs: 2000,
    };
  }

  // Sync mode: wait for all job completions, collect results preserving input order
  const settled = await Promise.allSettled(
    items.map(async ({ jobId }) => {
      const job = jobStore.getJob(jobId);
      if (!job) {
        throw new Error(`Job ${jobId} disappeared before it could complete`);
      }
      return await job.completion;
    })
  );

  const results = settled.map((r, i) =>
    r.status === "fulfilled"
      ? { index: items[i].index, status: "done" as const, response: r.value }
      : {
          index: items[i].index,
          status: "error" as const,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        }
  );

  const succeeded = results.filter((r) => r.status === "done").length;

  return {
    results,
    summary: {
      total: prompts.length,
      succeeded,
      failed: prompts.length - succeeded,
      durationMs: Date.now() - startMs,
    },
  };
}

export const geminiBatchToolDefinition: Tool = {
  name: "gemini-batch",
  title: "Batch Gemini Prompts",
  description:
    "Run multiple independent prompts in parallel, leveraging the existing concurrency " +
    "infrastructure (semaphore + warm pool). Useful for parallel code review, multi-file analysis, " +
    "and test generation — replacing N sequential ask-gemini calls with a single request. " +
    "Returns all results when complete (wait: true, default) or job IDs for polling (wait: false). " +
    "Individual failures are isolated: other items still complete successfully.",
  inputSchema: {
    type: "object" as const,
    properties: {
      prompts: {
        type: "array",
        items: { type: "string" },
        description: "1–20 independent prompts to run in parallel",
        minItems: 1,
        maxItems: 20,
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
        description: "Set to false to disable @file reference expansion.",
      },
      wait: {
        type: "boolean",
        description:
          "If true (default), block until all prompts complete and return all results inline. " +
          "If false, return job IDs immediately for polling with gemini-poll.",
      },
    },
    required: ["prompts"],
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      // Sync mode (wait: true)
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            status: { type: "string", enum: ["done", "error"] },
            response: { type: "string" },
            error: { type: "string" },
          },
          required: ["index", "status"],
        },
      },
      summary: {
        type: "object",
        properties: {
          total: { type: "integer" },
          succeeded: { type: "integer" },
          failed: { type: "integer" },
          durationMs: { type: "number" },
        },
        required: ["total", "succeeded", "failed", "durationMs"],
      },
      // Async mode (wait: false)
      jobs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            jobId: { type: "string" },
          },
          required: ["index", "jobId"],
        },
      },
      pollIntervalMs: { type: "number" },
    },
  },
  annotations: {
    title: "Batch Gemini Prompts",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

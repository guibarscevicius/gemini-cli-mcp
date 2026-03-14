import { z } from "zod";
import { McpError, ErrorCode, type Tool } from "@modelcontextprotocol/sdk/types.js";
import * as jobStore from "../job-store.js";
import { unregisterByJobId } from "../request-map.js";
import { mcpLog } from "../logging.js";

export const GeminiCancelSchema = z.object({
  jobId: z.string().uuid().describe("Job ID returned by ask-gemini or gemini-reply"),
});

export interface GeminiCancelOutput {
  cancelled: boolean;   // true if subprocess was killed
  alreadyDone: boolean; // true if job was already done/error/cancelled (idempotent)
}

/** Cancel an in-flight Gemini job by sending SIGTERM to its subprocess. */
export async function geminiCancel(input: unknown): Promise<GeminiCancelOutput> {
  const { jobId } = GeminiCancelSchema.parse(input);
  const job = jobStore.getJob(jobId);

  if (!job) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown job: ${jobId}`);
  }

  if (job.status !== "pending") {
    return { cancelled: false, alreadyDone: true };
  }

  const killed = job.subprocess?.kill("SIGTERM") ?? false;
  process.stderr.write(`[gemini-cli-mcp] gemini-cancel: job ${jobId} cancelled (SIGTERM delivered: ${killed})\n`);
  mcpLog("info", "jobs", { event: "job_cancelled", jobId });
  jobStore.cancelJob(jobId);
  unregisterByJobId(jobId);
  return { cancelled: true, alreadyDone: false };
}

export const geminiCancelToolDefinition: Tool = {
  name: "gemini-cancel",
  title: "Cancel Gemini Job",
  description:
    "Cancel an in-flight Gemini job. Sends SIGTERM to the subprocess. Idempotent: if the job is already done, returns { cancelled: false, alreadyDone: true }.",
  inputSchema: {
    type: "object" as const,
    properties: {
      jobId: {
        type: "string",
        description: "Job ID returned by ask-gemini or gemini-reply",
      },
    },
    required: ["jobId"],
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      cancelled: { type: "boolean" },
      alreadyDone: { type: "boolean" },
    },
    required: ["cancelled", "alreadyDone"],
  },
  annotations: {
    title: "Cancel Gemini Job",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

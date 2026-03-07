import { z } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as jobStore from "../job-store.js";

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

  job.subprocess?.kill("SIGTERM");
  jobStore.cancelJob(jobId);

  return { cancelled: true, alreadyDone: false };
}

export const geminiCancelToolDefinition = {
  name: "gemini-cancel" as const,
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
};

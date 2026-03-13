import { z } from "zod";
import { McpError, ErrorCode, type Tool } from "@modelcontextprotocol/sdk/types.js";
import * as jobStore from "../job-store.js";

export const GeminiPollSchema = z.object({
  jobId: z.string().uuid().describe("Job ID returned by ask-gemini or gemini-reply"),
});

export type GeminiPollOutput =
  | { status: "pending"; partialResponse: string }
  | { status: "done"; response: string }
  | { status: "error"; error: string }
  | { status: "cancelled"; error?: string };

/** Poll the status of an async Gemini job. */
export async function geminiPoll(input: unknown): Promise<GeminiPollOutput> {
  const { jobId } = GeminiPollSchema.parse(input);
  const job = jobStore.getJob(jobId);

  if (!job) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown job: ${jobId}`);
  }

  switch (job.status) {
    case "pending":
      return { status: "pending", partialResponse: job.partialResponse };
    case "done":
      return { status: "done", response: job.response! };
    case "error":
      return { status: "error", error: job.error! };
    case "cancelled":
      return { status: "cancelled", error: job.error };
    default: {
      const _exhaustive: never = job.status;
      throw new McpError(ErrorCode.InternalError, `Unhandled job status: ${String(_exhaustive)}`);
    }
  }
}

export const geminiPollToolDefinition: Tool = {
  name: "gemini-poll",
  title: "Poll Gemini Job",
  description:
    "Poll the status of an async Gemini job started by ask-gemini or gemini-reply. Returns status, partial response (while pending), or the full response (when done). Recommended poll interval: 2000ms. Jobs typically complete in 16–20s.",
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
  annotations: {
    title: "Poll Gemini Job",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

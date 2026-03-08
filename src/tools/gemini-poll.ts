import { z } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
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
  }
}

export const geminiPollToolDefinition = {
  name: "gemini-poll" as const,
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
};

import { z } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as jobStore from "../job-store.js";

export const GeminiPollSchema = z.object({
  jobId: z.string().uuid().describe("Job ID returned by ask-gemini or gemini-reply"),
});

export interface GeminiPollOutput {
  status: jobStore.JobStatus;
  partialResponse?: string; // accumulated text so far (pending)
  response?: string;        // full text (done)
  error?: string;           // error message (error / cancelled)
}

/** Poll the status of an async Gemini job. */
export async function geminiPoll(input: unknown): Promise<GeminiPollOutput> {
  const { jobId } = GeminiPollSchema.parse(input);
  const job = jobStore.getJob(jobId);

  if (!job) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown job: ${jobId}`);
  }

  return {
    status: job.status,
    partialResponse: job.status === "pending" ? job.partialResponse : undefined,
    response: job.response,
    error: job.error,
  };
}

export const geminiPollToolDefinition = {
  name: "gemini-poll" as const,
  description:
    "Poll the status of an async Gemini job started by ask-gemini or gemini-reply. Returns status, partial response (while pending), or the full response (when done).",
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

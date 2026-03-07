import { runGemini, spawnGemini, type GeminiExecutor } from "../gemini-runner.js";
import * as jobStore from "../job-store.js";
import type { ToolCallContext } from "../dispatcher.js";

/**
 * Fire-and-forget helper: runs runGemini in the background, updating job state as
 * chunks arrive. The subprocess reference is stored in the job for cancellation.
 */
export async function runGeminiAsync(
  jobId: string,
  prompt: string,
  opts: { model?: string; cwd?: string; tool: string; sessionId?: string },
  ctx: ToolCallContext
): Promise<string> {
  const job = jobStore.getJob(jobId)!;

  const onChunk = (chunk: string) => {
    jobStore.appendChunk(jobId, chunk);
    if (ctx.progressToken !== undefined && ctx.sendNotification) {
      ctx.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: ctx.progressToken,
          progress: job.partialResponse.length,
          total: undefined,
        },
      }).catch(() => {});
    }
  };

  // Custom executor that captures the ChildProcess for cancellation
  const executor: GeminiExecutor = (args, execOpts, chunkCb) =>
    new Promise((resolve, reject) => {
      const cp = spawnGemini(
        args,
        { env: execOpts.env, cwd: execOpts.cwd, timeout: execOpts.timeout },
        chunkCb ?? (() => {}),
        (fullText) => resolve({ stdout: fullText }),
        reject
      );
      job.subprocess = cp;
    });

  try {
    const response = await runGemini(prompt, opts, executor, onChunk);
    return response;
  } finally {
    job.subprocess = undefined;
  }
}

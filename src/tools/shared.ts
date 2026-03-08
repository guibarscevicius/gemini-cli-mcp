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
          data: { partialResponse: job.partialResponse },
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
      // Handle the race where cancelJob() ran before the subprocess was spawned.
      if (job.status === "cancelled") {
        cp.kill("SIGTERM");
        reject(new Error("Job was cancelled before subprocess started"));
        return;
      }
    });

  try {
    const response = await runGemini(prompt, opts, executor, onChunk);
    return response;
  } finally {
    job.subprocess = undefined;
  }
}

const WAIT_TIMEOUT = Symbol("wait-timeout");

export const DEFAULT_WAIT_MS = 90_000;

export interface WaitResult {
  response?: string;
  partialResponse?: string;
  timedOut?: boolean;
}

/**
 * Race a job's completion promise against a timeout.
 * Returns { response } on success, { partialResponse, timedOut: true } on timeout,
 * or rethrows any other rejection from the job itself.
 */
export async function waitForJob(
  jobId: string,
  timeoutMs: number = DEFAULT_WAIT_MS
): Promise<WaitResult> {
  const job = jobStore.getJob(jobId)!;
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, rej) => {
    timerId = setTimeout(() => rej(WAIT_TIMEOUT), timeoutMs);
  });
  try {
    const response = await Promise.race([job.completion, timer]);
    return { response };
  } catch (err) {
    if (err === WAIT_TIMEOUT) {
      process.stderr.write(
        `[gemini-cli-mcp] wait-mode timed out after ${timeoutMs}ms for job ${jobId} — falling back to async\n`
      );
      return { partialResponse: job.partialResponse, timedOut: true };
    }
    throw err;
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
  }
}

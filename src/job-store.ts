import type { ChildProcess } from "node:child_process";

export type JobStatus = "pending" | "done" | "error" | "cancelled";

export interface Job {
  status: JobStatus;
  partialResponse: string;  // accumulated text from message events (streaming)
  response?: string;        // set when status → "done"
  error?: string;           // set when status → "error"
  subprocess?: ChildProcess; // for cancel (cleared on completion)
  createdAt: number;
  readonly completion: Promise<string>;
}

const JOB_TTL_MS = parseInt(process.env.GEMINI_JOB_TTL_MS ?? "300000", 10);
const JOB_GC_MS = parseInt(process.env.GEMINI_JOB_GC_MS ?? "60000", 10);

interface JobInternal extends Job {
  _resolve: (response: string) => void;
  _reject: (error: Error) => void;
}

const jobs = new Map<string, JobInternal>();

export function createJob(jobId: string): void {
  let resolveCompletion!: (response: string) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<string>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  completion.catch(() => {});

  jobs.set(jobId, {
    status: "pending",
    partialResponse: "",
    createdAt: Date.now(),
    completion,
    _resolve: resolveCompletion,
    _reject: rejectCompletion,
  });
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

export function appendChunk(jobId: string, chunk: string): void {
  const job = jobs.get(jobId);
  if (job && job.status === "pending") {
    job.partialResponse += chunk;
  }
}

export function completeJob(jobId: string, response: string): void {
  const job = jobs.get(jobId);
  if (job && job.status !== "cancelled") {
    job.status = "done";
    job.response = response;
    job.subprocess = undefined;
    job._resolve(response);
  }
}

export function failJob(jobId: string, error: string): void {
  const job = jobs.get(jobId);
  if (job && job.status !== "cancelled") {
    job.status = "error";
    job.error = error;
    job.subprocess = undefined;
    job._reject(new Error(error));
  }
}

export function cancelJob(jobId: string): void {
  const job = jobs.get(jobId);
  if (job) {
    job.status = "cancelled";
    job.subprocess = undefined;
    job._reject(new Error("Job was cancelled"));
  }
}

/** @internal For test isolation only — not part of the public API. */
export function clearJobs(): void {
  jobs.clear();
}

/** @internal Exposed for testing — runs the GC sweep synchronously. */
export function sweepExpiredJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.status !== "pending" && job.createdAt < cutoff) {
      jobs.delete(id);
    }
  }
}

// GC: delete completed/errored/cancelled jobs older than JOB_TTL_MS
const gcTimer = setInterval(sweepExpiredJobs, JOB_GC_MS);

if (gcTimer.unref) gcTimer.unref();

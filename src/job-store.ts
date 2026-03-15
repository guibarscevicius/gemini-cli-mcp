import type { ChildProcess } from "node:child_process";
import { unregisterByJobId } from "./request-map.js";
import { mcpLog } from "./logging.js";

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

export interface ActiveJobEntry { id: string; createdAt: number }

let _jobListChangedCb: (() => void) | undefined;

export function setJobListChangedCallback(cb: () => void): void {
  _jobListChangedCb = cb;
}

/** @internal For test isolation only — not part of the public API. */
export function _resetJobListChangedCallback(): void {
  _jobListChangedCb = undefined;
}

export function listActiveJobs(): ActiveJobEntry[] {
  const result: ActiveJobEntry[] = [];
  for (const [id, job] of jobs) {
    if (job.status === "pending") result.push({ id, createdAt: job.createdAt });
  }
  return result;
}

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
  _jobListChangedCb?.();
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

export function getJobStats(): {
  active: number;
  total: number;
  byStatus: { pending: number; done: number; error: number; cancelled: number };
} {
  const byStatus = { pending: 0, done: 0, error: 0, cancelled: 0 };
  for (const job of jobs.values()) {
    byStatus[job.status]++;
  }
  return {
    active: byStatus.pending,
    total: jobs.size,
    byStatus,
  };
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
    _jobListChangedCb?.();
  }
}

export function failJob(jobId: string, error: string): void {
  const job = jobs.get(jobId);
  if (job && job.status !== "cancelled" && job.status !== "done") {
    job.status = "error";
    job.error = error;
    job.subprocess = undefined;
    job._reject(new Error(error));
    _jobListChangedCb?.();
  }
}

export function cancelJob(jobId: string): void {
  const job = jobs.get(jobId);
  if (job && job.status === "pending") {
    job.status = "cancelled";
    job.subprocess = undefined;
    job._reject(new Error("Job was cancelled"));
    _jobListChangedCb?.();
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
    if (job.createdAt < cutoff) {
      if (job.status === "pending") {
        const ageMs = Date.now() - job.createdAt;
        process.stderr.write(`[gemini-cli-mcp] GC: pending job ${id} expired after ${JOB_TTL_MS}ms — evicting\n`);
        job._reject(new Error("Job timed out and was garbage collected"));
        mcpLog("warning", "gc", { event: "job_gc_evicted", jobId: id, ageMs });
      }
      unregisterByJobId(id);
      jobs.delete(id);
    }
  }
}

// GC: delete all jobs older than JOB_TTL_MS regardless of status.
// Pending jobs are rejected before deletion so wait-mode callers get a proper error.
const gcTimer = setInterval(sweepExpiredJobs, JOB_GC_MS);

if (gcTimer.unref) gcTimer.unref();

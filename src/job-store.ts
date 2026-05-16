import type { ChildProcess } from "node:child_process";
import { killGroup } from "./process-group.js";
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
  historyPersisted?: false;  // set to false when appendTurn threw post-response; absent on success
  historyError?: string;     // set alongside historyPersisted when persistence threw
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

export function completeJob(
  jobId: string,
  response: string,
  history?: { persisted: boolean; error?: string }
): void {
  const job = jobs.get(jobId);
  if (job && job.status !== "cancelled") {
    job.status = "done";
    job.response = response;
    job.subprocess = undefined;
    if (history && !history.persisted) {
      job.historyPersisted = false;
      job.historyError = history.error;
    }
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
  cancelJobWithReason(jobId, "Job was cancelled");
}

export function cancelJobWithReason(jobId: string, reason: string): void {
  const job = jobs.get(jobId);
  if (job && job.status === "pending") {
    job.status = "cancelled";
    job.subprocess = undefined;
    job._reject(new Error(reason));
    _jobListChangedCb?.();
  }
}

export async function shutdownPendingJobs(
  reason: string = "Server shutting down",
  forceKillAfterMs: number = 2000
): Promise<void> {
  const subprocesses: ChildProcess[] = [];

  for (const [jobId, job] of jobs) {
    if (job.status !== "pending") continue;

    if (job.subprocess !== undefined) {
      subprocesses.push(job.subprocess);
      killGroup(job.subprocess, "SIGTERM");
    }

    cancelJobWithReason(jobId, reason);
    unregisterByJobId(jobId);
  }

  if (subprocesses.length === 0 || forceKillAfterMs <= 0) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const exitListeners = new Map<ChildProcess, { exit: () => void; error: () => void }>();
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const [subprocess, listeners] of exitListeners) {
        subprocess.off?.("exit", listeners.exit);
        subprocess.off?.("error", listeners.error);
      }
      resolve();
    };
    const maybeFinish = () => {
      if (subprocesses.every((subprocess) => subprocess.exitCode !== null)) {
        finish();
      }
    };

    for (const subprocess of subprocesses) {
      if (subprocess.exitCode !== null) continue;

      const listeners = {
        exit: () => maybeFinish(),
        error: () => maybeFinish(),
      };
      exitListeners.set(subprocess, listeners);
      subprocess.once("exit", listeners.exit);
      subprocess.once("error", listeners.error);
    }

    const timer = setTimeout(() => {
      for (const subprocess of subprocesses) {
        if (subprocess.exitCode === null) {
          killGroup(subprocess, "SIGKILL");
        }
      }
      finish();
    }, forceKillAfterMs);

    if (timer.unref) timer.unref();
    maybeFinish();
  });
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

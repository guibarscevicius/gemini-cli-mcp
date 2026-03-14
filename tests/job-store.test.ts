import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendChunk,
  cancelJob,
  clearJobs,
  completeJob,
  createJob,
  failJob,
  getJob,
  getJobStats,
  sweepExpiredJobs,
} from "../src/job-store.js";

beforeEach(() => {
  clearJobs();
});

afterEach(() => {
  clearJobs();
});

describe("createJob / getJob", () => {
  it("creates a job with pending status", () => {
    createJob("job-1");
    const job = getJob("job-1");
    expect(job).toBeDefined();
    expect(job!.status).toBe("pending");
    expect(job!.partialResponse).toBe("");
    expect(job!.response).toBeUndefined();
    expect(job!.error).toBeUndefined();
  });

  it("returns undefined for unknown jobId", () => {
    expect(getJob("nonexistent")).toBeUndefined();
  });

  it("records createdAt as current timestamp", () => {
    const before = Date.now();
    createJob("job-ts");
    const after = Date.now();
    const job = getJob("job-ts");
    expect(job!.createdAt).toBeGreaterThanOrEqual(before);
    expect(job!.createdAt).toBeLessThanOrEqual(after);
  });
});

describe("appendChunk", () => {
  it("accumulates chunks in partialResponse", () => {
    createJob("j1");
    appendChunk("j1", "Hello ");
    appendChunk("j1", "world");
    expect(getJob("j1")!.partialResponse).toBe("Hello world");
  });

  it("does nothing when jobId is unknown", () => {
    appendChunk("nonexistent", "data"); // no throw
  });

  it("does not append when job is not pending", () => {
    createJob("j2");
    completeJob("j2", "final");
    appendChunk("j2", "extra");
    expect(getJob("j2")!.partialResponse).toBe("");
  });
});

describe("getJobStats", () => {
  it("counts only pending jobs as active", () => {
    createJob("j1");
    createJob("j2");
    completeJob("j2", "done");
    createJob("j3");
    failJob("j3", "err");

    const stats = getJobStats();
    expect(stats.active).toBe(1);
    expect(stats.total).toBe(3);
  });
});

describe("completeJob", () => {
  it("sets status to done and stores response", () => {
    createJob("j3");
    completeJob("j3", "the answer");
    const job = getJob("j3")!;
    expect(job.status).toBe("done");
    expect(job.response).toBe("the answer");
    expect(job.subprocess).toBeUndefined();
  });

  it("does nothing for unknown jobId", () => {
    completeJob("nope", "answer"); // no throw
  });

  it("completeJob resolves the completion promise", async () => {
    createJob("j3-resolve");
    const completion = getJob("j3-resolve")!.completion;
    completeJob("j3-resolve", "resolved response");
    await expect(completion).resolves.toBe("resolved response");
  });
});

describe("failJob", () => {
  it("sets status to error and stores error message", () => {
    createJob("j4");
    failJob("j4", "something went wrong");
    const job = getJob("j4")!;
    expect(job.status).toBe("error");
    expect(job.error).toBe("something went wrong");
    expect(job.subprocess).toBeUndefined();
  });

  it("does nothing for unknown jobId", () => {
    failJob("nope", "err"); // no throw
  });

  it("failJob rejects the completion promise", async () => {
    createJob("j4-reject");
    const completion = getJob("j4-reject")!.completion;
    failJob("j4-reject", "some failure");
    await expect(completion).rejects.toThrow("some failure");
  });
});

describe("cancelJob", () => {
  it("sets status to cancelled and clears subprocess", () => {
    createJob("j5");
    cancelJob("j5");
    const job = getJob("j5")!;
    expect(job.status).toBe("cancelled");
    expect(job.subprocess).toBeUndefined();
  });

  it("does nothing for unknown jobId", () => {
    cancelJob("nope"); // no throw
  });

  it('cancelJob rejects the completion promise with "Job was cancelled"', async () => {
    createJob("j5-cancel");
    const completion = getJob("j5-cancel")!.completion;
    cancelJob("j5-cancel");
    await expect(completion).rejects.toThrow("Job was cancelled");
  });
});

describe("GC expiry (sweepExpiredJobs)", () => {
  it("deletes completed jobs older than TTL", () => {
    createJob("gc-done");
    completeJob("gc-done", "done");
    // Simulate a very old job by setting createdAt to epoch 0
    getJob("gc-done")!.createdAt = 0;

    sweepExpiredJobs();

    // TTL default = 300 s; createdAt=0 is definitely older → should be deleted
    expect(getJob("gc-done")).toBeUndefined();
  });

  it("deletes errored and cancelled jobs older than TTL", () => {
    createJob("gc-err");
    failJob("gc-err", "some error");
    getJob("gc-err")!.createdAt = 0;

    createJob("gc-cancelled");
    cancelJob("gc-cancelled");
    getJob("gc-cancelled")!.createdAt = 0;

    sweepExpiredJobs();

    expect(getJob("gc-err")).toBeUndefined();
    expect(getJob("gc-cancelled")).toBeUndefined();
  });

  it("deletes expired pending jobs and rejects their completion promise", async () => {
    createJob("gc-pending");
    const completion = getJob("gc-pending")!.completion;
    getJob("gc-pending")!.createdAt = 0;

    sweepExpiredJobs();

    expect(getJob("gc-pending")).toBeUndefined();
    await expect(completion).rejects.toThrow("Job timed out and was garbage collected");
  });

  it("GC sweep calls unregisterByJobId for expired jobs", async () => {
    const { registerRequest, getJobByRequestId, clearMap } = await import("../src/request-map.js");
    clearMap();
    createJob("gc-unregister");
    registerRequest("req-gc", "gc-unregister");
    getJob("gc-unregister")!.createdAt = 0;

    sweepExpiredJobs();

    expect(getJobByRequestId("req-gc")).toBeUndefined();
    clearMap();
  });

  it("does NOT delete recent completed jobs within TTL", () => {
    createJob("gc-recent");
    completeJob("gc-recent", "fresh");
    // createdAt defaults to now — within TTL

    sweepExpiredJobs();

    expect(getJob("gc-recent")).toBeDefined();
  });
});

describe("clearJobs", () => {
  it("removes all jobs", () => {
    createJob("a");
    createJob("b");
    clearJobs();
    expect(getJob("a")).toBeUndefined();
    expect(getJob("b")).toBeUndefined();
  });
});

describe("listActiveJobs", () => {
  it("returns empty array when no jobs exist", async () => {
    const { listActiveJobs } = await import("../src/job-store.js");
    expect(listActiveJobs()).toEqual([]);
  });

  it("returns only pending jobs with id and createdAt", async () => {
    const { listActiveJobs } = await import("../src/job-store.js");
    createJob("active-1");
    createJob("active-2");
    completeJob("active-2", "done");
    createJob("active-3");
    failJob("active-3", "oops");

    const active = listActiveJobs();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("active-1");
    expect(typeof active[0].createdAt).toBe("number");
  });

  it("returns no jobs after all are cancelled or completed", async () => {
    const { listActiveJobs } = await import("../src/job-store.js");
    createJob("done-1");
    createJob("done-2");
    completeJob("done-1", "ok");
    cancelJob("done-2");
    expect(listActiveJobs()).toEqual([]);
  });
});

describe("setJobListChangedCallback", () => {
  it("fires on createJob, completeJob, failJob, cancelJob", async () => {
    const { listActiveJobs, setJobListChangedCallback, _resetJobListChangedCallback } =
      await import("../src/job-store.js");
    void listActiveJobs; // referenced to avoid lint
    const cb = vi.fn();
    setJobListChangedCallback(cb);
    try {
      createJob("cb-1");
      expect(cb).toHaveBeenCalledTimes(1);
      completeJob("cb-1", "done");
      expect(cb).toHaveBeenCalledTimes(2);

      createJob("cb-2");
      failJob("cb-2", "err");
      expect(cb).toHaveBeenCalledTimes(4);

      createJob("cb-3");
      cancelJob("cb-3");
      expect(cb).toHaveBeenCalledTimes(6);
    } finally {
      _resetJobListChangedCallback();
    }
  });

  it("does not fire after _resetJobListChangedCallback", async () => {
    const { setJobListChangedCallback, _resetJobListChangedCallback } =
      await import("../src/job-store.js");
    const cb = vi.fn();
    setJobListChangedCallback(cb);
    _resetJobListChangedCallback();
    createJob("cb-reset");
    expect(cb).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendChunk,
  cancelJob,
  clearJobs,
  completeJob,
  createJob,
  failJob,
  getJob,
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

  it("does NOT delete pending jobs even if old", () => {
    createJob("gc-pending");
    getJob("gc-pending")!.createdAt = 0;

    sweepExpiredJobs();

    // Pending jobs are never GC'd regardless of age
    expect(getJob("gc-pending")).toBeDefined();
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

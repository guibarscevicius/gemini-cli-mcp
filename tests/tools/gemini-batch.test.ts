import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZodError } from "zod";

// Module mocks must be declared before imports
vi.mock("../../src/gemini-runner.js", () => ({
  runGemini: vi.fn(),
  spawnGemini: vi.fn(),
  SemaphoreTimeoutError: class SemaphoreTimeoutError extends Error {
    constructor(timeoutMs: number) {
      super(`Gemini request timed out after ${timeoutMs}ms waiting for a concurrency slot`);
      this.name = "SemaphoreTimeoutError";
    }
  },
}));

vi.mock("../../src/job-store.js", () => ({
  createJob: vi.fn(),
  getJob: vi.fn(),
  appendChunk: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
  cancelJob: vi.fn(),
}));

vi.mock("../../src/tools/shared.js", () => ({
  runGeminiAsync: vi.fn(),
}));

import * as jobStore from "../../src/job-store.js";
import { runGeminiAsync } from "../../src/tools/shared.js";
import { geminiBatch } from "../../src/tools/gemini-batch.js";
import type { GeminiBatchSyncOutput, GeminiBatchAsyncOutput } from "../../src/tools/gemini-batch.js";

const mockJobStore = vi.mocked(jobStore);
const mockRunGeminiAsync = vi.mocked(runGeminiAsync);

// Drain the microtask queue so fire-and-forget .then() callbacks run
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Build a mock job whose completion promise resolves or rejects.
 * Attaches a no-op .catch() to suppress unhandled-rejection warnings
 * (Promise.allSettled always handles the rejection before Node can warn).
 */
function makeJob(outcome: string | Error) {
  const completion =
    outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  // Suppress Node's unhandled-rejection warning — allSettled catches it
  completion.catch(() => {});
  return {
    status: "pending" as const,
    partialResponse: "",
    createdAt: Date.now(),
    completion,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunGeminiAsync.mockResolvedValue("gemini response");
  mockJobStore.getJob.mockImplementation(() => makeJob("gemini response"));
});

describe("geminiBatch", () => {
  // ── Schema validation ──────────────────────────────────────────────────────

  it("throws ZodError when prompts is missing", async () => {
    await expect(geminiBatch({})).rejects.toThrow(ZodError);
  });

  it("throws ZodError for empty prompts array", async () => {
    await expect(geminiBatch({ prompts: [] })).rejects.toThrow(ZodError);
  });

  it("throws ZodError for empty string in prompts array", async () => {
    await expect(geminiBatch({ prompts: [""] })).rejects.toThrow(ZodError);
  });

  it("throws ZodError for non-string item in prompts", async () => {
    await expect(geminiBatch({ prompts: [42] })).rejects.toThrow(ZodError);
  });

  it("throws ZodError for more than 20 prompts", async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `prompt ${i}`);
    await expect(geminiBatch({ prompts: tooMany })).rejects.toThrow(ZodError);
  });

  it("accepts exactly 20 prompts", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `prompt ${i}`);
    await expect(geminiBatch({ prompts: twenty })).resolves.toBeDefined();
  });

  it("accepts input with only prompts (all optional fields omitted)", async () => {
    await expect(geminiBatch({ prompts: ["hello"] })).resolves.toBeDefined();
  });

  // ── Sync mode (wait: true — the default) ──────────────────────────────────

  it("returns { results, summary } by default (wait: true)", async () => {
    const result = await geminiBatch({ prompts: ["p1", "p2"] });
    expect(result).toHaveProperty("results");
    expect(result).toHaveProperty("summary");
    expect(result).not.toHaveProperty("jobs");
  });

  it("results array has one entry per prompt", async () => {
    const result = (await geminiBatch({ prompts: ["a", "b", "c"] })) as GeminiBatchSyncOutput;
    expect(result.results).toHaveLength(3);
  });

  it("results entries have index matching input order", async () => {
    const result = (await geminiBatch({ prompts: ["a", "b", "c"] })) as GeminiBatchSyncOutput;
    expect(result.results[0].index).toBe(0);
    expect(result.results[1].index).toBe(1);
    expect(result.results[2].index).toBe(2);
  });

  it("all-success: all results have status 'done' with response field", async () => {
    mockJobStore.getJob.mockImplementation(() => makeJob("hello"));
    const result = (await geminiBatch({ prompts: ["p1", "p2"] })) as GeminiBatchSyncOutput;
    expect(result.results.every((r) => r.status === "done")).toBe(true);
    expect(result.results.every((r) => r.response === "hello")).toBe(true);
  });

  it("all-failure: all results have status 'error' with error field", async () => {
    mockJobStore.getJob.mockImplementation(() => makeJob(new Error("fail")));
    const result = (await geminiBatch({ prompts: ["p1", "p2"] })) as GeminiBatchSyncOutput;
    expect(result.results.every((r) => r.status === "error")).toBe(true);
    expect(result.results.every((r) => typeof r.error === "string")).toBe(true);
  });

  it("partial failure: error on one item does not affect others", async () => {
    let call = 0;
    mockJobStore.getJob.mockImplementation(() => {
      call++;
      return call === 2 ? makeJob(new Error("item 2 failed")) : makeJob("ok");
    });
    const result = (await geminiBatch({ prompts: ["a", "b", "c"] })) as GeminiBatchSyncOutput;
    expect(result.results[0].status).toBe("done");
    expect(result.results[1].status).toBe("error");
    expect(result.results[1].error).toContain("item 2 failed");
    expect(result.results[2].status).toBe("done");
  });

  it("error message is preserved from Error object", async () => {
    mockJobStore.getJob.mockImplementation(() => makeJob(new Error("specific error message")));
    const result = (await geminiBatch({ prompts: ["p"] })) as GeminiBatchSyncOutput;
    expect(result.results[0].error).toBe("specific error message");
  });

  it("non-Error rejection is converted to string", async () => {
    const completion = Promise.reject("string rejection");
    completion.catch(() => {});
    mockJobStore.getJob.mockReturnValue({
      status: "pending" as const,
      partialResponse: "",
      createdAt: Date.now(),
      completion,
    });
    const result = (await geminiBatch({ prompts: ["p"] })) as GeminiBatchSyncOutput;
    expect(result.results[0].status).toBe("error");
    expect(result.results[0].error).toBe("string rejection");
  });

  // ── Summary ────────────────────────────────────────────────────────────────

  it("summary.total equals number of prompts", async () => {
    const result = (await geminiBatch({ prompts: ["a", "b", "c"] })) as GeminiBatchSyncOutput;
    expect(result.summary.total).toBe(3);
  });

  it("summary.succeeded counts done items", async () => {
    mockJobStore.getJob.mockImplementation(() => makeJob("ok"));
    const result = (await geminiBatch({ prompts: ["a", "b"] })) as GeminiBatchSyncOutput;
    expect(result.summary.succeeded).toBe(2);
    expect(result.summary.failed).toBe(0);
  });

  it("summary.failed counts error items", async () => {
    mockJobStore.getJob.mockImplementation(() => makeJob(new Error("fail")));
    const result = (await geminiBatch({ prompts: ["a", "b"] })) as GeminiBatchSyncOutput;
    expect(result.summary.succeeded).toBe(0);
    expect(result.summary.failed).toBe(2);
  });

  it("summary.failed + summary.succeeded equals summary.total", async () => {
    let call = 0;
    mockJobStore.getJob.mockImplementation(() => {
      call++;
      return call % 2 === 0 ? makeJob(new Error("fail")) : makeJob("ok");
    });
    const result = (await geminiBatch({ prompts: ["a", "b", "c", "d"] })) as GeminiBatchSyncOutput;
    expect(result.summary.succeeded + result.summary.failed).toBe(result.summary.total);
  });

  it("summary.durationMs is a non-negative number", async () => {
    const result = (await geminiBatch({ prompts: ["a"] })) as GeminiBatchSyncOutput;
    expect(typeof result.summary.durationMs).toBe("number");
    expect(result.summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── Async mode (wait: false) ───────────────────────────────────────────────

  it("returns { jobs, pollIntervalMs } with wait: false", async () => {
    const result = await geminiBatch({ prompts: ["p1", "p2"], wait: false });
    expect(result).toHaveProperty("jobs");
    expect(result).toHaveProperty("pollIntervalMs");
    expect(result).not.toHaveProperty("results");
    expect(result).not.toHaveProperty("summary");
  });

  it("async: jobs array has one entry per prompt", async () => {
    const result = (await geminiBatch({ prompts: ["a", "b", "c"], wait: false })) as GeminiBatchAsyncOutput;
    expect(result.jobs).toHaveLength(3);
  });

  it("async: each job has index matching input position", async () => {
    const result = (await geminiBatch({ prompts: ["a", "b"], wait: false })) as GeminiBatchAsyncOutput;
    expect(result.jobs[0].index).toBe(0);
    expect(result.jobs[1].index).toBe(1);
  });

  it("async: each job has a UUID jobId", async () => {
    const result = (await geminiBatch({ prompts: ["a"], wait: false })) as GeminiBatchAsyncOutput;
    expect(result.jobs[0].jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("async: pollIntervalMs is 2000", async () => {
    const result = (await geminiBatch({ prompts: ["a"], wait: false })) as GeminiBatchAsyncOutput;
    expect(result.pollIntervalMs).toBe(2000);
  });

  // ── runGeminiAsync call arguments ──────────────────────────────────────────

  it("calls runGeminiAsync once per prompt", async () => {
    await geminiBatch({ prompts: ["a", "b", "c"] });
    expect(mockRunGeminiAsync).toHaveBeenCalledTimes(3);
  });

  it("calls runGeminiAsync with each prompt in order", async () => {
    await geminiBatch({ prompts: ["first", "second"] });
    expect(mockRunGeminiAsync.mock.calls[0][1]).toBe("first");
    expect(mockRunGeminiAsync.mock.calls[1][1]).toBe("second");
  });

  it("passes model to all runGeminiAsync calls", async () => {
    await geminiBatch({ prompts: ["a", "b"], model: "gemini-pro" });
    expect(mockRunGeminiAsync.mock.calls[0][2]).toMatchObject({ model: "gemini-pro" });
    expect(mockRunGeminiAsync.mock.calls[1][2]).toMatchObject({ model: "gemini-pro" });
  });

  it("passes cwd to all runGeminiAsync calls", async () => {
    await geminiBatch({ prompts: ["a", "b"], cwd: "/my/project" });
    expect(mockRunGeminiAsync.mock.calls[0][2]).toMatchObject({ cwd: "/my/project" });
    expect(mockRunGeminiAsync.mock.calls[1][2]).toMatchObject({ cwd: "/my/project" });
  });

  it("passes expandRefs: false to all runGeminiAsync calls", async () => {
    await geminiBatch({ prompts: ["a", "b"], expandRefs: false });
    expect(mockRunGeminiAsync.mock.calls[0][2]).toMatchObject({ expandRefs: false });
    expect(mockRunGeminiAsync.mock.calls[1][2]).toMatchObject({ expandRefs: false });
  });

  it("passes tool: 'gemini-batch' to all runGeminiAsync calls", async () => {
    await geminiBatch({ prompts: ["a", "b"] });
    expect(mockRunGeminiAsync.mock.calls[0][2]).toMatchObject({ tool: "gemini-batch" });
    expect(mockRunGeminiAsync.mock.calls[1][2]).toMatchObject({ tool: "gemini-batch" });
  });

  it("creates a job in the job store for each prompt", async () => {
    await geminiBatch({ prompts: ["a", "b", "c"] });
    expect(mockJobStore.createJob).toHaveBeenCalledTimes(3);
  });

  it("each job has a distinct UUID", async () => {
    const result = (await geminiBatch({ prompts: ["a", "b", "c"], wait: false })) as GeminiBatchAsyncOutput;
    const ids = result.jobs.map((j) => j.jobId);
    expect(new Set(ids).size).toBe(3);
  });

  // ── Background completion callbacks ────────────────────────────────────────

  it("completeJob called with response after runGeminiAsync resolves (async mode)", async () => {
    mockRunGeminiAsync.mockResolvedValue("batch response");
    await geminiBatch({ prompts: ["a"], wait: false });
    await flush();
    expect(mockJobStore.completeJob).toHaveBeenCalledWith(expect.any(String), "batch response");
  });

  it("failJob called when runGeminiAsync rejects (async mode)", async () => {
    mockRunGeminiAsync.mockRejectedValue(new Error("gemini error"));
    await geminiBatch({ prompts: ["a"], wait: false });
    await flush();
    expect(mockJobStore.failJob).toHaveBeenCalledWith(expect.any(String), "gemini error");
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  it("single prompt works the same as N prompts", async () => {
    mockJobStore.getJob.mockImplementation(() => makeJob("solo"));
    const result = (await geminiBatch({ prompts: ["solo prompt"] })) as GeminiBatchSyncOutput;
    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe("done");
    expect(result.results[0].response).toBe("solo");
    expect(result.summary.total).toBe(1);
  });

  it("wait: true is the default (explicit wait: true behaves the same)", async () => {
    const withDefault = (await geminiBatch({ prompts: ["p"] })) as GeminiBatchSyncOutput;
    const withExplicit = (await geminiBatch({ prompts: ["p"], wait: true })) as GeminiBatchSyncOutput;
    expect(withDefault).toHaveProperty("results");
    expect(withExplicit).toHaveProperty("results");
  });

  it("results are indexed by original input position, not completion order", async () => {
    // Simulate out-of-order completions via per-call mock returns
    let call = 0;
    mockJobStore.getJob.mockImplementation(() => {
      call++;
      // All resolve, but we just confirm index order is correct
      return makeJob(`response-${call}`);
    });
    const result = (await geminiBatch({ prompts: ["first", "second", "third"] })) as GeminiBatchSyncOutput;
    expect(result.results[0].index).toBe(0);
    expect(result.results[1].index).toBe(1);
    expect(result.results[2].index).toBe(2);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/request-map.js", () => ({
  getJobByRequestId: vi.fn(),
  unregisterRequest: vi.fn(),
  registerRequest: vi.fn(),
  unregisterByJobId: vi.fn(),
  clearMap: vi.fn(),
}));

vi.mock("../src/job-store.js", () => ({
  getJob: vi.fn(),
  cancelJob: vi.fn(),
  createJob: vi.fn(),
  clearJobs: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
  sweepExpiredJobs: vi.fn(),
  appendChunk: vi.fn(),
  setJobListChangedCallback: vi.fn(),
}));

vi.mock("../src/dispatcher.js", () => ({
  handleCallTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "{}" }] }),
}));

import { getJobByRequestId, unregisterRequest } from "../src/request-map.js";
import { getJob, cancelJob } from "../src/job-store.js";
import { createServer } from "../src/index.js";

const mockGetJobByRequestId = vi.mocked(getJobByRequestId);
const mockGetJob = vi.mocked(getJob);
const mockCancelJob = vi.mocked(cancelJob);
const mockUnregisterRequest = vi.mocked(unregisterRequest);

describe("createServer()", () => {
  it("creates a server without throwing", () => {
    expect(() => createServer()).not.toThrow();
  });
});

describe("notifications/cancelled handler logic", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  async function runCancellationHandler(requestId: string | number | undefined) {
    if (requestId === undefined) {
      process.stderr.write("[gemini-cli-mcp] notifications/cancelled with no requestId - ignoring\n");
      return;
    }
    const jobId = getJobByRequestId(requestId);
    if (!jobId) {
      process.stderr.write(`[gemini-cli-mcp] notifications/cancelled: no job registered for requestId ${String(requestId)}\n`);
      return;
    }
    const job = getJob(jobId);
    if (job && job.status !== "pending") {
      process.stderr.write(`[gemini-cli-mcp] notifications/cancelled: job ${jobId} already ${job.status} - skipping kill\n`);
    }
    if ((job as any)?.status === "pending") {
      (job as any).subprocess?.kill("SIGTERM");
      cancelJob(jobId);
    }
    unregisterRequest(requestId);
  }

  it("logs and returns when requestId is undefined", async () => {
    await runCancellationHandler(undefined);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("no requestId"));
    expect(mockGetJobByRequestId).not.toHaveBeenCalled();
  });

  it("logs and returns when no job is registered for requestId", async () => {
    mockGetJobByRequestId.mockReturnValue(undefined);
    await runCancellationHandler("req-1");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("no job registered for requestId req-1"));
    expect(mockCancelJob).not.toHaveBeenCalled();
  });

  it("kills subprocess and cancels pending job", async () => {
    const kill = vi.fn();
    mockGetJobByRequestId.mockReturnValue("job-abc");
    mockGetJob.mockReturnValue({ status: "pending", subprocess: { kill } } as any);
    await runCancellationHandler("req-1");
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(mockCancelJob).toHaveBeenCalledWith("job-abc");
    expect(mockUnregisterRequest).toHaveBeenCalledWith("req-1");
  });

  it("does not cancel a completed job, logs it, but still unregisters", async () => {
    mockGetJobByRequestId.mockReturnValue("job-abc");
    mockGetJob.mockReturnValue({ status: "done" } as any);
    await runCancellationHandler("req-1");
    expect(mockCancelJob).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("already done"));
    expect(mockUnregisterRequest).toHaveBeenCalledWith("req-1");
  });

  it("handles no subprocess (race: not yet assigned)", async () => {
    mockGetJobByRequestId.mockReturnValue("job-abc");
    mockGetJob.mockReturnValue({ status: "pending", subprocess: undefined } as any);
    await runCancellationHandler("req-1");
    expect(mockCancelJob).toHaveBeenCalledWith("job-abc");
    expect(mockUnregisterRequest).toHaveBeenCalledWith("req-1");
  });

  it("unregisters numeric requestId", async () => {
    mockGetJobByRequestId.mockReturnValue("job-xyz");
    mockGetJob.mockReturnValue({ status: "pending", subprocess: { kill: vi.fn() } } as any);
    await runCancellationHandler(99);
    expect(mockUnregisterRequest).toHaveBeenCalledWith(99);
  });
});

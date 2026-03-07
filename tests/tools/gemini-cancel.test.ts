import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import type { ChildProcess } from "node:child_process";

vi.mock("../../src/job-store.js", () => ({
  getJob: vi.fn(),
  cancelJob: vi.fn(),
}));

import * as jobStore from "../../src/job-store.js";
import { geminiCancel } from "../../src/tools/gemini-cancel.js";

const mockGetJob = vi.mocked(jobStore.getJob);
const mockCancelJob = vi.mocked(jobStore.cancelJob);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

const VALID_JOB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("geminiCancel", () => {
  it("kills subprocess and cancels the job when pending", async () => {
    const mockKill = vi.fn().mockReturnValue(true);
    mockGetJob.mockReturnValue({
      status: "pending",
      partialResponse: "",
      subprocess: { kill: mockKill } as unknown as ChildProcess,
      createdAt: Date.now(),
    });

    const result = await geminiCancel({ jobId: VALID_JOB_ID });

    expect(mockKill).toHaveBeenCalledWith("SIGTERM");
    expect(mockCancelJob).toHaveBeenCalledWith(VALID_JOB_ID);
    expect(result).toEqual({ cancelled: true, alreadyDone: false });
  });

  it("works without a subprocess reference (no-op kill)", async () => {
    mockGetJob.mockReturnValue({
      status: "pending",
      partialResponse: "",
      subprocess: undefined,
      createdAt: Date.now(),
    });

    const result = await geminiCancel({ jobId: VALID_JOB_ID });
    expect(mockCancelJob).toHaveBeenCalledWith(VALID_JOB_ID);
    expect(result).toEqual({ cancelled: true, alreadyDone: false });
  });

  it("returns alreadyDone: true when job is done", async () => {
    mockGetJob.mockReturnValue({
      status: "done",
      partialResponse: "",
      response: "finished",
      createdAt: Date.now(),
    });

    const result = await geminiCancel({ jobId: VALID_JOB_ID });
    expect(result).toEqual({ cancelled: false, alreadyDone: true });
    expect(mockCancelJob).not.toHaveBeenCalled();
  });

  it("returns alreadyDone: true when job is already cancelled", async () => {
    mockGetJob.mockReturnValue({
      status: "cancelled",
      partialResponse: "",
      createdAt: Date.now(),
    });

    const result = await geminiCancel({ jobId: VALID_JOB_ID });
    expect(result).toEqual({ cancelled: false, alreadyDone: true });
  });

  it("returns alreadyDone: true when job errored", async () => {
    mockGetJob.mockReturnValue({
      status: "error",
      partialResponse: "",
      error: "some error",
      createdAt: Date.now(),
    });

    const result = await geminiCancel({ jobId: VALID_JOB_ID });
    expect(result).toEqual({ cancelled: false, alreadyDone: true });
  });

  it("throws McpError(InvalidParams) for unknown jobId", async () => {
    mockGetJob.mockReturnValue(undefined);
    try {
      await geminiCancel({ jobId: VALID_JOB_ID });
      expect.fail("should have thrown");
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string };
      expect(e.code).toBe(ErrorCode.InvalidParams);
      expect(e.message).toMatch(/unknown job/i);
    }
  });

  it("throws ZodError for missing jobId", async () => {
    await expect(geminiCancel({})).rejects.toThrow(ZodError);
  });

  it("throws ZodError for non-UUID jobId", async () => {
    await expect(geminiCancel({ jobId: "not-a-uuid" })).rejects.toThrow(ZodError);
  });
});

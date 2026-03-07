import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

vi.mock("../../src/job-store.js", () => ({
  getJob: vi.fn(),
}));

import * as jobStore from "../../src/job-store.js";
import { geminiPoll } from "../../src/tools/gemini-poll.js";

const mockGetJob = vi.mocked(jobStore.getJob);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

const VALID_JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("geminiPoll", () => {
  it("returns pending status with partialResponse when job is pending", async () => {
    mockGetJob.mockReturnValue({
      status: "pending",
      partialResponse: "so far...",
      createdAt: Date.now(),
    });
    const result = await geminiPoll({ jobId: VALID_JOB_ID });
    expect(result.status).toBe("pending");
    expect(result.partialResponse).toBe("so far...");
    expect(result.response).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("omits partialResponse when job is done", async () => {
    mockGetJob.mockReturnValue({
      status: "done",
      partialResponse: "accumulated",
      response: "final answer",
      createdAt: Date.now(),
    });
    const result = await geminiPoll({ jobId: VALID_JOB_ID });
    expect(result.status).toBe("done");
    expect(result.response).toBe("final answer");
    expect(result.partialResponse).toBeUndefined();
  });

  it("returns error status with error message", async () => {
    mockGetJob.mockReturnValue({
      status: "error",
      partialResponse: "",
      error: "subprocess died",
      createdAt: Date.now(),
    });
    const result = await geminiPoll({ jobId: VALID_JOB_ID });
    expect(result.status).toBe("error");
    expect(result.error).toBe("subprocess died");
    expect(result.partialResponse).toBeUndefined();
  });

  it("returns cancelled status", async () => {
    mockGetJob.mockReturnValue({
      status: "cancelled",
      partialResponse: "",
      createdAt: Date.now(),
    });
    const result = await geminiPoll({ jobId: VALID_JOB_ID });
    expect(result.status).toBe("cancelled");
  });

  it("throws McpError(InvalidParams) for unknown jobId", async () => {
    mockGetJob.mockReturnValue(undefined);
    try {
      await geminiPoll({ jobId: VALID_JOB_ID });
      expect.fail("should have thrown");
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string };
      expect(e.code).toBe(ErrorCode.InvalidParams);
      expect(e.message).toMatch(/unknown job/i);
    }
  });

  it("McpError message includes the jobId", async () => {
    mockGetJob.mockReturnValue(undefined);
    try {
      await geminiPoll({ jobId: VALID_JOB_ID });
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect((err as Error).message).toContain(VALID_JOB_ID);
    }
  });

  it("throws ZodError for missing jobId", async () => {
    await expect(geminiPoll({})).rejects.toThrow(ZodError);
  });

  it("throws ZodError for non-UUID jobId", async () => {
    await expect(geminiPoll({ jobId: "not-a-uuid" })).rejects.toThrow(ZodError);
  });
});

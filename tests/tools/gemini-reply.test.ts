import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

vi.mock("../../src/gemini-runner.js", () => ({
  runGemini: vi.fn(),
  spawnGemini: vi.fn(),
  countFileRefs: vi.fn(() => 0),
  SemaphoreTimeoutError: class SemaphoreTimeoutError extends Error {
    constructor(timeoutMs: number) {
      super(`Gemini request timed out after ${timeoutMs}ms waiting for a concurrency slot`);
      this.name = "SemaphoreTimeoutError";
    }
  },
}));

vi.mock("../../src/session-store.js", () => ({
  sessionStore: {
    create: vi.fn(),
    get: vi.fn(),
    appendTurn: vi.fn(),
    formatHistory: vi.fn(),
    setPendingJob: vi.fn(),
    clearPendingJob: vi.fn(),
    getPendingJob: vi.fn(),
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

vi.mock("../../src/request-map.js", () => ({
  registerRequest: vi.fn(),
  unregisterRequest: vi.fn(),
  unregisterByJobId: vi.fn(),
  getJobByRequestId: vi.fn(),
  clearMap: vi.fn(),
}));

vi.mock("../../src/tools/shared.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/tools/shared.js")>("../../src/tools/shared.js");
  return {
    ...actual,
    elicitCwdIfNeeded: vi.fn(actual.elicitCwdIfNeeded),
  };
});

import { runGemini, countFileRefs } from "../../src/gemini-runner.js";
import { sessionStore } from "../../src/session-store.js";
import * as jobStore from "../../src/job-store.js";
import { unregisterRequest } from "../../src/request-map.js";
import { geminiReply } from "../../src/tools/gemini-reply.js";
import { DEFAULT_WAIT_MS, elicitCwdIfNeeded } from "../../src/tools/shared.js";

const mockRunGemini = vi.mocked(runGemini);
const mockCountFileRefs = vi.mocked(countFileRefs);
const mockStore = vi.mocked(sessionStore);
const mockJobStore = vi.mocked(jobStore);
const mockUnregisterRequest = vi.mocked(unregisterRequest);
const mockElicitCwdIfNeeded = vi.mocked(elicitCwdIfNeeded);

const VALID_SESSION_ID = "11111111-1111-4111-8111-111111111111";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.get.mockReturnValue(true);
  mockStore.formatHistory.mockReturnValue({ history: "", truncated: false, totalTurns: 0 });
  mockStore.getPendingJob.mockReturnValue(undefined);
  mockRunGemini.mockResolvedValue("Gemini follow-up response.");
  mockJobStore.getJob.mockReturnValue({
    status: "pending",
    partialResponse: "",
    createdAt: Date.now(),
    completion: new Promise<string>(() => {}),
  });
});

describe("geminiReply", () => {
  // ── Return shape ─────────────────────────────────────────────────────────────

  it("returns { jobId, pollIntervalMs } immediately (no response field)", async () => {
    const result = await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "follow up" });
    expect(result).toHaveProperty("jobId");
    expect(result.pollIntervalMs).toBe(2000);
    expect(result).not.toHaveProperty("response");
  });

  it("pollIntervalMs is 2000 in response", async () => {
    const result = await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "hello" });
    expect(result.pollIntervalMs).toBe(2000);
  });

  it("does not include historyTruncated when history is not truncated", async () => {
    mockStore.formatHistory.mockReturnValue({ history: "User: hi", truncated: false, totalTurns: 2 });
    const result = await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "hello" });
    expect(result.historyTruncated).toBeUndefined();
    expect(result.historyTurnCount).toBeUndefined();
  });

  it("includes historyTruncated and historyTurnCount when history is truncated", async () => {
    mockStore.formatHistory.mockReturnValue({ history: "User: old", truncated: true, totalTurns: 42 });
    const result = await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "hello" });
    expect(result.historyTruncated).toBe(true);
    expect(result.historyTurnCount).toBe(42);
  });

  it("jobId is a UUID", async () => {
    const { jobId } = await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "hello" });
    expect(jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  // ── Pending job guard ─────────────────────────────────────────────────────────

  it("throws McpError(InvalidParams) when session has a pending job", async () => {
    mockStore.getPendingJob.mockReturnValue("existing-job-id");
    try {
      await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "hello" });
      expect.fail("should have thrown");
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string };
      expect(e.code).toBe(ErrorCode.InvalidParams);
      expect(e.message).toMatch(/pending job/i);
    }
  });

  it("pending job error includes the pending jobId for debugging", async () => {
    mockStore.getPendingJob.mockReturnValue("pending-job-xyz");
    try {
      await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "hello" });
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect((err as Error).message).toContain("pending-job-xyz");
    }
  });

  it("does not call runGemini when session has a pending job", async () => {
    mockStore.getPendingJob.mockReturnValue("pending-job-id");
    await expect(
      geminiReply({ sessionId: VALID_SESSION_ID, prompt: "hello" })
    ).rejects.toThrow();
    expect(mockRunGemini).not.toHaveBeenCalled();
  });

  // ── Session lookup ────────────────────────────────────────────────────────────

  it("throws McpError(InvalidParams) for unknown sessionId", async () => {
    mockStore.get.mockReturnValue(false);
    try {
      await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "hello" });
      expect.fail("should have thrown");
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string };
      expect(e.code).toBe(ErrorCode.InvalidParams);
      expect(e.message).toMatch(/session not found or expired/i);
    }
  });

  it("McpError message includes the bad sessionId for debugging", async () => {
    mockStore.get.mockReturnValue(false);
    try {
      await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "hello" });
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect((err as Error).message).toContain(VALID_SESSION_ID);
    }
  });

  it("does not call runGemini when session is not found", async () => {
    mockStore.get.mockReturnValue(false);
    await expect(
      geminiReply({ sessionId: VALID_SESSION_ID, prompt: "hello" })
    ).rejects.toThrow();
    expect(mockRunGemini).not.toHaveBeenCalled();
  });

  // ── Job and session setup ────────────────────────────────────────────────────

  it("creates a job in the job store before returning", async () => {
    const { jobId } = await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "q" });
    expect(mockJobStore.createJob).toHaveBeenCalledWith(jobId);
  });

  it("marks the session as pending before returning", async () => {
    const { jobId } = await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "q" });
    expect(mockStore.setPendingJob).toHaveBeenCalledWith(VALID_SESSION_ID, jobId);
  });

  // ── Async background completion ───────────────────────────────────────────────

  it("completes job and appends turns after runGemini resolves", async () => {
    const { jobId } = await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "q" });
    await flush();
    expect(mockJobStore.completeJob).toHaveBeenCalledWith(jobId, "Gemini follow-up response.");
    expect(mockStore.appendTurn).toHaveBeenCalledWith(VALID_SESSION_ID, "user", "q");
    expect(mockStore.appendTurn).toHaveBeenCalledWith(VALID_SESSION_ID, "assistant", "Gemini follow-up response.");
    expect(mockStore.clearPendingJob).toHaveBeenCalledWith(VALID_SESSION_ID);
  });

  it("calls failJob when runGemini rejects", async () => {
    mockRunGemini.mockRejectedValue(new Error("subprocess timeout"));
    const { jobId } = await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "q" });
    await flush();
    expect(mockJobStore.failJob).toHaveBeenCalledWith(jobId, "subprocess timeout");
  });

  it("does not call appendTurn if runGemini throws", async () => {
    mockRunGemini.mockRejectedValue(new Error("failed"));
    await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "q" });
    await flush();
    expect(mockStore.appendTurn).not.toHaveBeenCalled();
  });

  it("clears pending job on session on failure", async () => {
    mockRunGemini.mockRejectedValue(new Error("crash"));
    await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "q" });
    await flush();
    expect(mockStore.clearPendingJob).toHaveBeenCalledWith(VALID_SESSION_ID);
  });

  // ── History prepending ───────────────────────────────────────────────────────

  it("calls runGemini with the prompt when there is no prior history", async () => {
    mockStore.formatHistory.mockReturnValue({ history: "", truncated: false, totalTurns: 0 });
    await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "new question" });
    await flush();
    expect(mockRunGemini).toHaveBeenCalledWith(
      "new question",
      expect.objectContaining({ tool: "gemini-reply", sessionId: VALID_SESSION_ID }),
      expect.any(Function),
      expect.any(Function)
    );
  });

  it("prepends conversation history with \\n\\n separator", async () => {
    const history =
      "[Conversation history]\nUser: hi\nAssistant: hello\n[End of history — continue the conversation]";
    mockStore.formatHistory.mockReturnValue({ history, truncated: false, totalTurns: 2 });

    await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "what did I say?" });
    await flush();

    const [calledPrompt] = mockRunGemini.mock.calls[0];
    expect(calledPrompt).toBe(`${history}\n\nwhat did I say?`);
  });

  it("formats history using the session ID, not the prompt", async () => {
    await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "new question" });
    expect(mockStore.formatHistory).toHaveBeenCalledWith(VALID_SESSION_ID);
  });

  it("passes model option to runGemini when provided", async () => {
    await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "hello", model: "gemini-2.5-flash" });
    await flush();
    expect(mockRunGemini).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model: "gemini-2.5-flash" }),
      expect.any(Function),
      expect.any(Function)
    );
  });

  it("passes cwd option to runGemini when provided", async () => {
    await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "review @src/main.ts", cwd: "/my/project" });
    await flush();
    expect(mockRunGemini).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: "/my/project" }),
      expect.any(Function),
      expect.any(Function)
    );
  });

  it("passes expandRefs: false to runGemini when provided", async () => {
    await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "Check @click in @a.ts", expandRefs: false });
    await flush();
    expect(mockRunGemini).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expandRefs: false }),
      expect.any(Function),
      expect.any(Function)
    );
  });

  it("expandRefs defaults to undefined when not provided", async () => {
    await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "hello" });
    await flush();
    const opts = mockRunGemini.mock.calls[0][1];
    expect(opts.expandRefs).toBeUndefined();
  });

  it("throws McpError when elicitation is cancelled (resolvedCwd === null)", async () => {
    mockElicitCwdIfNeeded.mockResolvedValueOnce(null);
    await expect(
      geminiReply({ sessionId: VALID_SESSION_ID, prompt: "@file1.ts and @file2.ts" }, { elicit: vi.fn() })
    ).rejects.toThrow(McpError);

    mockElicitCwdIfNeeded.mockResolvedValueOnce(null);
    await expect(
      geminiReply({ sessionId: VALID_SESSION_ID, prompt: "@file1.ts and @file2.ts" }, { elicit: vi.fn() })
    ).rejects.toThrow("cancelled by user");
  });

  it("throws McpError when elicitation unsupported and multiple @file refs present", async () => {
    mockElicitCwdIfNeeded.mockResolvedValueOnce(undefined);
    mockCountFileRefs.mockReturnValueOnce(2);
    await expect(
      geminiReply({ sessionId: VALID_SESSION_ID, prompt: "@file1.ts and @file2.ts" }, {})
    ).rejects.toThrow(McpError);
  });

  // ── Input validation (Zod) ───────────────────────────────────────────────────

  it("throws ZodError for missing sessionId", async () => {
    await expect(
      geminiReply({ prompt: "hello" } as Parameters<typeof geminiReply>[0])
    ).rejects.toThrow(ZodError);
  });

  it("throws ZodError for non-UUID sessionId", async () => {
    await expect(
      geminiReply({ sessionId: "not-a-uuid", prompt: "hello" })
    ).rejects.toThrow(ZodError);
  });

  it("throws ZodError for missing prompt", async () => {
    await expect(
      geminiReply({ sessionId: VALID_SESSION_ID } as Parameters<typeof geminiReply>[0])
    ).rejects.toThrow(ZodError);
  });

  it("throws ZodError for empty prompt", async () => {
    await expect(
      geminiReply({ sessionId: VALID_SESSION_ID, prompt: "" })
    ).rejects.toThrow(ZodError);
  });

  // ── progressToken (MCP-native streaming) ─────────────────────────────────────

  it("progressToken in ctx auto-blocks and returns response inline", async () => {
    mockJobStore.getJob.mockReturnValue({
      status: "pending",
      partialResponse: "",
      createdAt: Date.now(),
      completion: Promise.resolve("streamed reply"),
    });
    const result = await geminiReply(
      { sessionId: VALID_SESSION_ID, prompt: "follow up" },
      { progressToken: "tok-1", sendNotification: vi.fn().mockResolvedValue(undefined) }
    );
    expect(result).toMatchObject({
      jobId: expect.any(String),
      response: "streamed reply",
      pollIntervalMs: 2000,
    });
    expect(result).not.toHaveProperty("partialResponse");
  });

  it("progressToken: sendNotification is called with notifications/progress payload per chunk", async () => {
    const job = {
      status: "pending" as const,
      partialResponse: "",
      createdAt: Date.now(),
      completion: Promise.resolve("full response"),
    };
    mockJobStore.getJob.mockReturnValue(job);
    mockJobStore.appendChunk.mockImplementation((_jobId: string, chunk: string) => {
      job.partialResponse += chunk;
    });
    mockRunGemini.mockImplementation(
      async (
        _prompt: unknown,
        _opts: unknown,
        _executor: unknown,
        onChunk: ((c: string) => void) | undefined
      ) => {
        onChunk?.("hello ");
        onChunk?.("world");
        return "full response";
      }
    );

    const sendNotification = vi.fn().mockResolvedValue(undefined);
    await geminiReply(
      { sessionId: VALID_SESSION_ID, prompt: "follow up" },
      { progressToken: "tok-notify", sendNotification }
    );

    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "notifications/progress",
        params: expect.objectContaining({
          progressToken: "tok-notify",
          data: expect.objectContaining({ partialResponse: expect.any(String) }),
        }),
      })
    );
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it("progressToken + timeout returns partialResponse and timedOut", async () => {
    vi.useFakeTimers();
    try {
      mockJobStore.getJob.mockReturnValue({
        status: "pending",
        partialResponse: "partial text",
        createdAt: Date.now(),
        completion: new Promise<string>(() => {}), // never resolves
      });

      const resultPromise = geminiReply(
        { sessionId: VALID_SESSION_ID, prompt: "follow up" },
        { progressToken: "tok-2", sendNotification: vi.fn().mockResolvedValue(undefined) }
      );

      await vi.advanceTimersByTimeAsync(DEFAULT_WAIT_MS + 1);
      const result = await resultPromise;

      expect(result).toMatchObject({
        jobId: expect.any(String),
        partialResponse: "partial text",
        timedOut: true,
        pollIntervalMs: 2000,
      });
      expect(result).not.toHaveProperty("response");
    } finally {
      vi.useRealTimers();
    }
  });

  it("no progressToken returns immediately without response", async () => {
    const result = await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "follow up" });
    expect(result).not.toHaveProperty("response");
    expect(result).not.toHaveProperty("partialResponse");
  });

  it("progressToken + job failure throws McpError", async () => {
    mockJobStore.getJob.mockReturnValue({
      status: "pending",
      partialResponse: "",
      createdAt: Date.now(),
      completion: Promise.reject(new Error("subprocess crashed")),
    });
    await expect(
      geminiReply(
        { sessionId: VALID_SESSION_ID, prompt: "follow up" },
        { progressToken: "tok-3", sendNotification: vi.fn().mockResolvedValue(undefined) }
      )
    ).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining("subprocess crashed"),
    });
  });

  // ── #63: wait:true timeout must unregister to prevent late cancellation ──

  it("wait:true timeout unregisters requestId to prevent late cancellation", async () => {
    mockJobStore.getJob.mockReturnValue({
      status: "pending",
      partialResponse: "partial",
      createdAt: Date.now(),
      completion: new Promise<string>(() => {}),
    });
    await geminiReply(
      { sessionId: VALID_SESSION_ID, prompt: "follow up", wait: true, waitTimeoutMs: 1 },
      { requestId: "req-99" }
    );
    expect(mockUnregisterRequest).toHaveBeenCalledWith("req-99");
  });
});

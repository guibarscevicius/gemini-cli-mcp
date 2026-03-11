import { describe, it, expect, vi, beforeEach } from "vitest";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

// Module mocks must be declared before imports
vi.mock("../../src/gemini-runner.js", () => ({
  runGemini: vi.fn(),
  spawnGemini: vi.fn(),
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

import { runGemini } from "../../src/gemini-runner.js";
import { sessionStore } from "../../src/session-store.js";
import * as jobStore from "../../src/job-store.js";
import { registerRequest, unregisterRequest } from "../../src/request-map.js";
import { askGemini } from "../../src/tools/ask-gemini.js";
import { DEFAULT_WAIT_MS } from "../../src/tools/shared.js";

const mockRunGemini = vi.mocked(runGemini);
const mockStore = vi.mocked(sessionStore);
const mockJobStore = vi.mocked(jobStore);
const mockUnregisterRequest = vi.mocked(unregisterRequest);
const mockRegisterRequest = vi.mocked(registerRequest);

// Helper to drain the microtask queue so fire-and-forget .then() callbacks run
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.clearAllMocks();
  mockRunGemini.mockResolvedValue("Gemini says hello.");
  // getJob must return a mutable job object for subprocess capture
  mockJobStore.getJob.mockReturnValue({
    status: "pending",
    partialResponse: "",
    createdAt: Date.now(),
    completion: new Promise<string>(() => {}),
  });
});

describe("askGemini", () => {
  // ── Return shape ────────────────────────────────────────────────────────────

  it("returns { jobId, sessionId, pollIntervalMs } immediately (no response field)", async () => {
    const result = await askGemini({ prompt: "hello" });
    expect(result).toHaveProperty("jobId");
    expect(result).toHaveProperty("sessionId");
    expect(result.pollIntervalMs).toBe(2000);
    expect(result).not.toHaveProperty("response");
  });

  it("pollIntervalMs is 2000 in async response", async () => {
    const result = await askGemini({ prompt: "hello" });
    expect(result.pollIntervalMs).toBe(2000);
  });

  it("jobId is a UUID", async () => {
    const { jobId } = await askGemini({ prompt: "hello" });
    expect(jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("sessionId is a UUID", async () => {
    const { sessionId } = await askGemini({ prompt: "hello" });
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("jobId and sessionId are different", async () => {
    const { jobId, sessionId } = await askGemini({ prompt: "hello" });
    expect(jobId).not.toBe(sessionId);
  });

  // ── Job and session setup ────────────────────────────────────────────────────

  it("creates a new session before returning", async () => {
    const { sessionId } = await askGemini({ prompt: "hello" });
    expect(mockStore.create).toHaveBeenCalledWith(sessionId);
  });

  it("creates a job in the job store before returning", async () => {
    const { jobId } = await askGemini({ prompt: "hello" });
    expect(mockJobStore.createJob).toHaveBeenCalledWith(jobId);
  });

  it("marks the session as pending with the jobId before returning", async () => {
    const { jobId, sessionId } = await askGemini({ prompt: "hello" });
    expect(mockStore.setPendingJob).toHaveBeenCalledWith(sessionId, jobId);
  });

  // ── Async background completion ──────────────────────────────────────────────

  it("calls completeJob with response after runGemini resolves", async () => {
    const { jobId } = await askGemini({ prompt: "hello" });
    await flush();
    expect(mockJobStore.completeJob).toHaveBeenCalledWith(jobId, "Gemini says hello.");
  });

  it("appends user and assistant turns after runGemini resolves", async () => {
    const { sessionId } = await askGemini({ prompt: "my prompt" });
    await flush();
    expect(mockStore.appendTurn).toHaveBeenCalledWith(sessionId, "user", "my prompt");
    expect(mockStore.appendTurn).toHaveBeenCalledWith(sessionId, "assistant", "Gemini says hello.");
  });

  it("clears pending job on session after completion", async () => {
    const { sessionId } = await askGemini({ prompt: "hello" });
    await flush();
    expect(mockStore.clearPendingJob).toHaveBeenCalledWith(sessionId);
  });

  it("calls failJob when runGemini rejects", async () => {
    mockRunGemini.mockRejectedValue(new Error("gemini crash"));
    const { jobId } = await askGemini({ prompt: "hello" });
    await flush();
    expect(mockJobStore.failJob).toHaveBeenCalledWith(jobId, "gemini crash");
  });

  it("clears pending job on session on failure", async () => {
    mockRunGemini.mockRejectedValue(new Error("crash"));
    const { sessionId } = await askGemini({ prompt: "hello" });
    await flush();
    expect(mockStore.clearPendingJob).toHaveBeenCalledWith(sessionId);
  });

  it("does not appendTurn if runGemini fails", async () => {
    mockRunGemini.mockRejectedValue(new Error("crash"));
    await askGemini({ prompt: "hello" });
    await flush();
    expect(mockStore.appendTurn).not.toHaveBeenCalled();
  });

  // ── runGemini call options ───────────────────────────────────────────────────

  it("calls runGemini with the provided prompt", async () => {
    await askGemini({ prompt: "What is the weather?" });
    await flush();
    expect(mockRunGemini).toHaveBeenCalledWith(
      "What is the weather?",
      expect.objectContaining({ model: undefined, cwd: undefined, tool: "ask-gemini" }),
      expect.any(Function), // custom executor
      expect.any(Function)  // onChunk
    );
  });

  it("passes model option to runGemini when provided", async () => {
    await askGemini({ prompt: "hello", model: "gemini-2.5-pro" });
    await flush();
    expect(mockRunGemini).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ model: "gemini-2.5-pro" }),
      expect.any(Function),
      expect.any(Function)
    );
  });

  it("passes cwd option to runGemini when provided", async () => {
    await askGemini({ prompt: "review @src/auth.ts", cwd: "/my/project" });
    await flush();
    expect(mockRunGemini).toHaveBeenCalledWith(
      "review @src/auth.ts",
      expect.objectContaining({ cwd: "/my/project" }),
      expect.any(Function),
      expect.any(Function)
    );
  });

  it("passes expandRefs: false to runGemini when provided", async () => {
    await askGemini({ prompt: "Check @click.prevent in @a.ts", expandRefs: false });
    await flush();
    expect(mockRunGemini).toHaveBeenCalledWith(
      "Check @click.prevent in @a.ts",
      expect.objectContaining({ expandRefs: false }),
      expect.any(Function),
      expect.any(Function)
    );
  });

  it("expandRefs defaults to undefined when not provided", async () => {
    await askGemini({ prompt: "hello" });
    await flush();
    const opts = mockRunGemini.mock.calls[0][1];
    expect(opts.expandRefs).toBeUndefined();
  });

  // ── Input validation (Zod) ──────────────────────────────────────────────────

  it("throws ZodError when prompt is missing", async () => {
    await expect(askGemini({})).rejects.toThrow(ZodError);
  });

  it("throws ZodError when prompt is an empty string", async () => {
    await expect(askGemini({ prompt: "" })).rejects.toThrow(ZodError);
  });

  it("throws ZodError when prompt is not a string", async () => {
    await expect(askGemini({ prompt: 42 })).rejects.toThrow(ZodError);
  });

  it("accepts input without optional fields (model, cwd)", async () => {
    await expect(askGemini({ prompt: "hello" })).resolves.toMatchObject({
      jobId: expect.any(String),
      sessionId: expect.any(String),
    });
  });

  it("accepts ctx.requestId without throwing", async () => {
    const result = await askGemini({ prompt: "hello" }, { requestId: "req-42" });
    expect(result.jobId).toBeDefined();
    expect(result.sessionId).toBeDefined();
  });

  it("wait: true returns response directly when job completes", async () => {
    mockJobStore.getJob.mockReturnValue({
      status: "pending",
      partialResponse: "",
      createdAt: Date.now(),
      completion: Promise.resolve("waited response"),
    });
    const result = await askGemini({ prompt: "hello", wait: true });
    expect(result).toMatchObject({
      jobId: expect.any(String),
      sessionId: expect.any(String),
      response: "waited response",
      pollIntervalMs: 2000,
    });
  });

  it("wait: true with timeout falls back to async", async () => {
    vi.useFakeTimers();
    try {
      mockJobStore.getJob.mockReturnValue({
        status: "pending",
        partialResponse: "",
        createdAt: Date.now(),
        completion: new Promise<string>(() => {}),
      });
      const resultPromise = askGemini({ prompt: "hello", wait: true });
      await vi.advanceTimersByTimeAsync(DEFAULT_WAIT_MS + 1);
      const result = await resultPromise;
      expect(result).toMatchObject({
        jobId: expect.any(String),
        sessionId: expect.any(String),
        pollIntervalMs: 2000,
      });
      expect(result).not.toHaveProperty("response");
    } finally {
      vi.useRealTimers();
    }
  });

  it("wait: true throws McpError when job fails", async () => {
    mockJobStore.getJob.mockReturnValue({
      status: "pending",
      partialResponse: "",
      createdAt: Date.now(),
      completion: Promise.reject(new Error("job failed")),
    });
    await expect(askGemini({ prompt: "hello", wait: true })).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining("job failed"),
    });
  });

  it("wait: true returns timedOut with partialResponse on timeout", async () => {
    mockJobStore.getJob.mockReturnValue({
      status: "pending",
      partialResponse: "so far...",
      createdAt: Date.now(),
      completion: new Promise<string>(() => {}),
    });
    const result = await askGemini({ prompt: "hello", wait: true, waitTimeoutMs: 1 });
    expect(result).toMatchObject({
      jobId: expect.any(String),
      sessionId: expect.any(String),
      partialResponse: "so far...",
      timedOut: true,
      pollIntervalMs: 2000,
    });
    expect(result).not.toHaveProperty("response");
  });

  // ── progressToken (MCP-native streaming) ─────────────────────────────────────

  it("progressToken in ctx auto-blocks and returns response inline", async () => {
    mockJobStore.getJob.mockReturnValue({
      status: "pending",
      partialResponse: "",
      createdAt: Date.now(),
      completion: Promise.resolve("streamed response"),
    });
    const result = await askGemini(
      { prompt: "hello" },
      { progressToken: "tok-1", sendNotification: vi.fn().mockResolvedValue(undefined) }
    );
    expect(result).toMatchObject({
      jobId: expect.any(String),
      sessionId: expect.any(String),
      response: "streamed response",
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
    await askGemini({ prompt: "hi" }, { progressToken: "tok-notify", sendNotification });

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
        partialResponse: "partial chunk",
        createdAt: Date.now(),
        completion: new Promise<string>(() => {}),
      });
      const resultPromise = askGemini(
        { prompt: "hello" },
        { progressToken: "tok-2", sendNotification: vi.fn().mockResolvedValue(undefined) }
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_WAIT_MS + 1);
      const result = await resultPromise;
      expect(result).toMatchObject({
        partialResponse: "partial chunk",
        timedOut: true,
        pollIntervalMs: 2000,
      });
      expect(result).not.toHaveProperty("response");
    } finally {
      vi.useRealTimers();
    }
  });

  it("progressToken + job failure throws McpError", async () => {
    mockJobStore.getJob.mockReturnValue({
      status: "pending",
      partialResponse: "",
      createdAt: Date.now(),
      completion: Promise.reject(new Error("subprocess crashed")),
    });
    await expect(
      askGemini(
        { prompt: "hello" },
        { progressToken: "tok-3", sendNotification: vi.fn().mockResolvedValue(undefined) }
      )
    ).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining("subprocess crashed"),
    });
  });

  it("no progressToken and no wait returns immediately without response", async () => {
    const result = await askGemini({ prompt: "hello" });
    expect(result).not.toHaveProperty("response");
    expect(result).not.toHaveProperty("partialResponse");
  });

  // ── #63: wait:true timeout must NOT cancel the job ────────────────────────

  it("wait:true timeout does NOT call cancelJob", async () => {
    mockJobStore.getJob.mockReturnValue({
      status: "pending",
      partialResponse: "partial",
      createdAt: Date.now(),
      completion: new Promise<string>(() => {}),
    });
    await askGemini({ prompt: "hello", wait: true, waitTimeoutMs: 1 });
    expect(mockJobStore.cancelJob).not.toHaveBeenCalled();
  });

  it("wait:true timeout does NOT kill subprocess", async () => {
    const mockKill = vi.fn();
    mockJobStore.getJob.mockReturnValue({
      status: "pending",
      partialResponse: "",
      createdAt: Date.now(),
      completion: new Promise<string>(() => {}),
      subprocess: { kill: mockKill },
    });
    await askGemini({ prompt: "hello", wait: true, waitTimeoutMs: 1 });
    expect(mockKill).not.toHaveBeenCalled();
  });

  it("wait:true timeout unregisters requestId to prevent late cancellation", async () => {
    mockJobStore.getJob.mockReturnValue({
      status: "pending",
      partialResponse: "partial",
      createdAt: Date.now(),
      completion: new Promise<string>(() => {}),
    });
    await askGemini(
      { prompt: "hello", wait: true, waitTimeoutMs: 1 },
      { requestId: "req-42" }
    );
    expect(mockUnregisterRequest).toHaveBeenCalledWith("req-42");
  });
});

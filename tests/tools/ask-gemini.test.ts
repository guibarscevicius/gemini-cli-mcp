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
}));

import { runGemini } from "../../src/gemini-runner.js";
import { sessionStore } from "../../src/session-store.js";
import * as jobStore from "../../src/job-store.js";
import { askGemini } from "../../src/tools/ask-gemini.js";

const mockRunGemini = vi.mocked(runGemini);
const mockStore = vi.mocked(sessionStore);
const mockJobStore = vi.mocked(jobStore);

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
    mockJobStore.getJob.mockReturnValue({
      status: "pending",
      partialResponse: "",
      createdAt: Date.now(),
      completion: new Promise<string>(() => {}),
    });
    const result = await askGemini({ prompt: "hello", wait: true, waitTimeoutMs: 1 });
    expect(result).toMatchObject({
      jobId: expect.any(String),
      sessionId: expect.any(String),
      pollIntervalMs: 2000,
    });
    expect(result).not.toHaveProperty("response");
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
});

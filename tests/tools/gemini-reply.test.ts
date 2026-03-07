import { describe, it, expect, vi, beforeEach } from "vitest";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

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
import { geminiReply } from "../../src/tools/gemini-reply.js";

const mockRunGemini = vi.mocked(runGemini);
const mockStore = vi.mocked(sessionStore);
const mockJobStore = vi.mocked(jobStore);

const VALID_SESSION_ID = "11111111-1111-4111-8111-111111111111";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.get.mockReturnValue(true);
  mockStore.formatHistory.mockReturnValue("");
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
    mockStore.formatHistory.mockReturnValue("");
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
    mockStore.formatHistory.mockReturnValue(history);

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
});

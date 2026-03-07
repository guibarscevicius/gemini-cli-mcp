import { describe, it, expect, vi, beforeEach } from "vitest";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

vi.mock("../../src/gemini-runner.js", () => ({
  runGemini: vi.fn(),
}));

vi.mock("../../src/session-store.js", () => ({
  sessionStore: {
    create: vi.fn(),
    get: vi.fn(),
    appendTurn: vi.fn(),
    formatHistory: vi.fn(),
  },
}));

import { runGemini } from "../../src/gemini-runner.js";
import { sessionStore } from "../../src/session-store.js";
import { geminiReply } from "../../src/tools/gemini-reply.js";

const mockRunGemini = vi.mocked(runGemini);
const mockStore = vi.mocked(sessionStore);

const VALID_SESSION_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.get.mockReturnValue(true);
  mockStore.formatHistory.mockReturnValue("");
  mockRunGemini.mockResolvedValue("Gemini follow-up response.");
});

describe("geminiReply", () => {
  // ── Happy path ─────────────────────────────────────────────────────────────

  it("returns the response on success", async () => {
    const result = await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "follow up" });
    expect(result.response).toBe("Gemini follow-up response.");
  });

  it("calls runGemini with the prompt when there is no prior history", async () => {
    mockStore.formatHistory.mockReturnValue("");
    await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "new question" });
    expect(mockRunGemini).toHaveBeenCalledWith(
      "new question",
      expect.objectContaining({ tool: "gemini-reply", sessionId: VALID_SESSION_ID })
    );
  });

  it("prepends conversation history with \\n\\n separator", async () => {
    const history =
      "[Conversation history]\nUser: hi\nAssistant: hello\n[End of history — continue the conversation]";
    mockStore.formatHistory.mockReturnValue(history);

    await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "what did I say?" });

    const [calledPrompt] = vi.mocked(mockRunGemini).mock.calls[0];
    // Exact separator matters: \n\n is the boundary Gemini uses to parse context vs new prompt
    expect(calledPrompt).toBe(`${history}\n\nwhat did I say?`);
  });

  it("formats history using the session ID, not the prompt", async () => {
    await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "new question" });
    expect(mockStore.formatHistory).toHaveBeenCalledWith(VALID_SESSION_ID);
  });

  it("passes model option to runGemini when provided", async () => {
    await geminiReply({
      sessionId: VALID_SESSION_ID,
      prompt: "hello",
      model: "gemini-2.5-flash",
    });
    expect(mockRunGemini).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        model: "gemini-2.5-flash",
        tool: "gemini-reply",
        sessionId: VALID_SESSION_ID,
      })
    );
  });

  it("passes cwd option to runGemini when provided", async () => {
    await geminiReply({
      sessionId: VALID_SESSION_ID,
      prompt: "review @src/main.ts",
      cwd: "/my/project",
    });
    expect(mockRunGemini).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        cwd: "/my/project",
        tool: "gemini-reply",
        sessionId: VALID_SESSION_ID,
      })
    );
  });

  it("appends the new turn to the session after success", async () => {
    await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "q" });
    expect(mockStore.appendTurn).toHaveBeenNthCalledWith(
      1,
      VALID_SESSION_ID,
      "user",
      "q"
    );
    expect(mockStore.appendTurn).toHaveBeenNthCalledWith(
      2,
      VALID_SESSION_ID,
      "assistant",
      "Gemini follow-up response."
    );
  });

  // ── Session lookup ─────────────────────────────────────────────────────────

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
    expect.assertions(1);
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

  // ── Input validation (Zod) ─────────────────────────────────────────────────

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

  // ── Error propagation ──────────────────────────────────────────────────────

  it("propagates errors thrown by runGemini", async () => {
    mockRunGemini.mockRejectedValue(new Error("subprocess timeout"));
    await expect(
      geminiReply({ sessionId: VALID_SESSION_ID, prompt: "hello" })
    ).rejects.toThrow("subprocess timeout");
  });

  it("does not call appendTurn if runGemini throws", async () => {
    mockRunGemini.mockRejectedValue(new Error("failed"));
    await expect(
      geminiReply({ sessionId: VALID_SESSION_ID, prompt: "hello" })
    ).rejects.toThrow();
    expect(mockStore.appendTurn).not.toHaveBeenCalled();
  });
});

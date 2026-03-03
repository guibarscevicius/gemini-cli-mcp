import { describe, it, expect, vi, beforeEach } from "vitest";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";

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
const MOCK_SESSION = { turns: [], lastAccessed: Date.now() };

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.get.mockReturnValue(MOCK_SESSION as ReturnType<typeof sessionStore.get>);
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
      expect.anything()
    );
  });

  it("prepends conversation history when it exists", async () => {
    const history = "[Conversation history]\nUser: hi\nGemini: hello\n[End of history — continue the conversation]";
    mockStore.formatHistory.mockReturnValue(history);

    await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "what did I say?" });

    const [calledPrompt] = vi.mocked(mockRunGemini).mock.calls[0];
    expect(calledPrompt).toContain("[Conversation history]");
    expect(calledPrompt).toContain("what did I say?");
    // History comes first, then a separator, then the new prompt
    expect(calledPrompt.indexOf("[Conversation history]")).toBeLessThan(
      calledPrompt.indexOf("what did I say?")
    );
  });

  it("passes model option to runGemini when provided", async () => {
    await geminiReply({
      sessionId: VALID_SESSION_ID,
      prompt: "hello",
      model: "gemini-2.5-flash",
    });
    expect(mockRunGemini).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model: "gemini-2.5-flash" })
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
      expect.objectContaining({ cwd: "/my/project" })
    );
  });

  it("appends the new turn to the session after success", async () => {
    await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "q" });
    expect(mockStore.appendTurn).toHaveBeenCalledWith(
      VALID_SESSION_ID,
      "q",
      "Gemini follow-up response."
    );
  });

  // ── Session lookup ─────────────────────────────────────────────────────────

  it("throws McpError(InvalidParams) for unknown sessionId", async () => {
    mockStore.get.mockReturnValue(null);
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
    mockStore.get.mockReturnValue(null);
    try {
      await geminiReply({ sessionId: VALID_SESSION_ID, prompt: "hello" });
    } catch (err: unknown) {
      expect((err as Error).message).toContain(VALID_SESSION_ID);
    }
  });

  it("does not call runGemini when session is not found", async () => {
    mockStore.get.mockReturnValue(null);
    await expect(
      geminiReply({ sessionId: VALID_SESSION_ID, prompt: "hello" })
    ).rejects.toThrow();
    expect(mockRunGemini).not.toHaveBeenCalled();
  });

  // ── Input validation (Zod) ─────────────────────────────────────────────────

  it("throws ZodError for missing sessionId", async () => {
    await expect(geminiReply({ prompt: "hello" } as Parameters<typeof geminiReply>[0])).rejects.toThrow();
  });

  it("throws ZodError for non-UUID sessionId", async () => {
    await expect(
      geminiReply({ sessionId: "not-a-uuid", prompt: "hello" })
    ).rejects.toThrow();
  });

  it("throws ZodError for missing prompt", async () => {
    await expect(
      geminiReply({ sessionId: VALID_SESSION_ID } as Parameters<typeof geminiReply>[0])
    ).rejects.toThrow();
  });

  it("throws ZodError for empty prompt", async () => {
    await expect(
      geminiReply({ sessionId: VALID_SESSION_ID, prompt: "" })
    ).rejects.toThrow();
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

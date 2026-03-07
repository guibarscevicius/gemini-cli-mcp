import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZodError } from "zod";

// Module mocks must be declared before imports
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
import { askGemini } from "../../src/tools/ask-gemini.js";

const mockRunGemini = vi.mocked(runGemini);
const mockStore = vi.mocked(sessionStore);

beforeEach(() => {
  vi.clearAllMocks();
  mockRunGemini.mockResolvedValue("Gemini says hello.");
});

describe("askGemini", () => {
  // ── Happy path ─────────────────────────────────────────────────────────────

  it("returns sessionId and response on success", async () => {
    const result = await askGemini({ prompt: "hello" });
    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(result.response).toBe("Gemini says hello.");
  });

  it("calls runGemini with the provided prompt", async () => {
    await askGemini({ prompt: "What is the weather?" });
    expect(mockRunGemini).toHaveBeenCalledWith(
      "What is the weather?",
      expect.objectContaining({ model: undefined, cwd: undefined, tool: "ask-gemini" })
    );
  });

  it("passes model option to runGemini when provided", async () => {
    await askGemini({ prompt: "hello", model: "gemini-2.5-pro" });
    expect(mockRunGemini).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ model: "gemini-2.5-pro", tool: "ask-gemini" })
    );
  });

  it("passes cwd option to runGemini when provided", async () => {
    await askGemini({ prompt: "review @src/auth.ts", cwd: "/my/project" });
    expect(mockRunGemini).toHaveBeenCalledWith(
      "review @src/auth.ts",
      expect.objectContaining({ cwd: "/my/project", tool: "ask-gemini" })
    );
  });

  it("creates a new session and stores user/assistant turns", async () => {
    const result = await askGemini({ prompt: "my prompt" });
    expect(mockStore.create).toHaveBeenCalledWith(result.sessionId);
    expect(mockStore.appendTurn).toHaveBeenNthCalledWith(
      1,
      result.sessionId,
      "user",
      "my prompt"
    );
    expect(mockStore.appendTurn).toHaveBeenNthCalledWith(
      2,
      result.sessionId,
      "assistant",
      "Gemini says hello."
    );
  });

  // ── Input validation (Zod) ─────────────────────────────────────────────────

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
      sessionId: expect.any(String),
      response: expect.any(String),
    });
  });

  // ── Error propagation ──────────────────────────────────────────────────────

  it("propagates errors thrown by runGemini", async () => {
    mockRunGemini.mockRejectedValue(new Error("gemini process failed: auth error"));
    await expect(askGemini({ prompt: "hello" })).rejects.toThrow(
      "gemini process failed: auth error"
    );
  });

  it("does not call create/appendTurn if runGemini throws", async () => {
    mockRunGemini.mockRejectedValue(new Error("failed"));
    await expect(askGemini({ prompt: "hello" })).rejects.toThrow("failed");
    expect(mockStore.create).not.toHaveBeenCalled();
    expect(mockStore.appendTurn).not.toHaveBeenCalled();
  });
});

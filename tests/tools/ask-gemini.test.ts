import { describe, it, expect, vi, beforeEach } from "vitest";

// Module mocks must be declared before imports
vi.mock("../../src/gemini-runner.js", () => ({
  runGemini: vi.fn(),
}));

vi.mock("../../src/session-store.js", () => ({
  sessionStore: {
    create: vi.fn(),
    createWithTurn: vi.fn(),
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
  mockStore.createWithTurn.mockReturnValue("test-session-id");
  mockRunGemini.mockResolvedValue("Gemini says hello.");
});

describe("askGemini", () => {
  // ── Happy path ─────────────────────────────────────────────────────────────

  it("returns sessionId and response on success", async () => {
    const result = await askGemini({ prompt: "hello" });
    expect(result.sessionId).toBe("test-session-id");
    expect(result.response).toBe("Gemini says hello.");
  });

  it("calls runGemini with the provided prompt", async () => {
    await askGemini({ prompt: "What is the weather?" });
    expect(mockRunGemini).toHaveBeenCalledWith(
      "What is the weather?",
      expect.objectContaining({ model: undefined, cwd: undefined })
    );
  });

  it("passes model option to runGemini when provided", async () => {
    await askGemini({ prompt: "hello", model: "gemini-2.5-pro" });
    expect(mockRunGemini).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ model: "gemini-2.5-pro" })
    );
  });

  it("passes cwd option to runGemini when provided", async () => {
    await askGemini({ prompt: "review @src/auth.ts", cwd: "/my/project" });
    expect(mockRunGemini).toHaveBeenCalledWith(
      "review @src/auth.ts",
      expect.objectContaining({ cwd: "/my/project" })
    );
  });

  it("creates a new session atomically via sessionStore.createWithTurn()", async () => {
    await askGemini({ prompt: "hello" });
    expect(mockStore.createWithTurn).toHaveBeenCalledOnce();
  });

  it("stores the user prompt and gemini response atomically in createWithTurn", async () => {
    await askGemini({ prompt: "my prompt" });
    expect(mockStore.createWithTurn).toHaveBeenCalledWith("my prompt", "Gemini says hello.");
    // appendTurn is no longer called — createWithTurn replaces create()+appendTurn()
    expect(mockStore.appendTurn).not.toHaveBeenCalled();
  });

  // ── Input validation (Zod) ─────────────────────────────────────────────────

  it("throws ZodError when prompt is missing", async () => {
    await expect(askGemini({})).rejects.toThrow();
  });

  it("throws ZodError when prompt is an empty string", async () => {
    await expect(askGemini({ prompt: "" })).rejects.toThrow();
  });

  it("throws ZodError when prompt is not a string", async () => {
    await expect(askGemini({ prompt: 42 })).rejects.toThrow();
  });

  it("accepts input without optional fields (model, cwd)", async () => {
    await expect(askGemini({ prompt: "hello" })).resolves.toBeDefined();
  });

  // ── Error propagation ──────────────────────────────────────────────────────

  it("propagates errors thrown by runGemini", async () => {
    mockRunGemini.mockRejectedValue(new Error("gemini process failed: auth error"));
    await expect(askGemini({ prompt: "hello" })).rejects.toThrow(
      "gemini process failed: auth error"
    );
  });

  it("does not call createWithTurn if runGemini throws (no orphan session)", async () => {
    mockRunGemini.mockRejectedValue(new Error("failed"));
    await expect(askGemini({ prompt: "hello" })).rejects.toThrow();
    expect(mockStore.createWithTurn).not.toHaveBeenCalled();
  });
});

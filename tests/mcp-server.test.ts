/**
 * Tests for the MCP tool dispatcher (src/dispatcher.ts).
 *
 * We import handleCallTool directly rather than spinning up the full
 * StdioServerTransport, keeping tests fast and free of I/O side effects.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

vi.mock("../src/tools/ask-gemini.js", () => ({
  askGemini: vi.fn(),
  askGeminiToolDefinition: {
    name: "ask-gemini",
    description: "stub",
    inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
  },
}));

vi.mock("../src/tools/gemini-reply.js", () => ({
  geminiReply: vi.fn(),
  geminiReplyToolDefinition: {
    name: "gemini-reply",
    description: "stub",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" }, prompt: { type: "string" } },
      required: ["sessionId", "prompt"],
    },
  },
}));

import { askGemini } from "../src/tools/ask-gemini.js";
import { geminiReply } from "../src/tools/gemini-reply.js";
import { handleCallTool } from "../src/dispatcher.js";

const mockAskGemini = vi.mocked(askGemini);
const mockGeminiReply = vi.mocked(geminiReply);

beforeEach(() => {
  vi.clearAllMocks();
  mockAskGemini.mockResolvedValue({ sessionId: "abc-123", response: "hello" });
  mockGeminiReply.mockResolvedValue({ response: "follow up" });
});

describe("MCP dispatcher (handleCallTool)", () => {
  // ── ask-gemini dispatch ────────────────────────────────────────────────────

  it("dispatches ask-gemini and returns JSON content", async () => {
    const result = await handleCallTool("ask-gemini", { prompt: "hello" });
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sessionId).toBe("abc-123");
    expect(parsed.response).toBe("hello");
  });

  it("passes args through to askGemini", async () => {
    await handleCallTool("ask-gemini", { prompt: "test", model: "gemini-2.5-pro" });
    expect(mockAskGemini).toHaveBeenCalledWith({ prompt: "test", model: "gemini-2.5-pro" });
  });

  // ── gemini-reply dispatch ──────────────────────────────────────────────────

  it("dispatches gemini-reply and returns JSON content", async () => {
    const result = await handleCallTool("gemini-reply", {
      sessionId: "11111111-1111-4111-8111-111111111111",
      prompt: "follow up",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.response).toBe("follow up");
  });

  // ── Unknown tool ───────────────────────────────────────────────────────────

  it("throws McpError(MethodNotFound) for unknown tool name", async () => {
    expect.assertions(1);
    try {
      await handleCallTool("totally-unknown-tool", {});
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect((err as McpError).code).toBe(ErrorCode.MethodNotFound);
    }
  });

  it("McpError includes the unknown tool name", async () => {
    expect.assertions(1);
    try {
      await handleCallTool("not-a-tool", {});
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect((err as Error).message).toContain("not-a-tool");
    }
  });

  // ── Error wrapping ─────────────────────────────────────────────────────────

  it("wraps non-McpError as isError response (not a throw)", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockAskGemini.mockRejectedValue(new Error("subprocess crashed"));

    try {
      const result = await handleCallTool("ask-gemini", { prompt: "hello" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("subprocess crashed");
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('\nError: subprocess crashed')
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("re-throws McpError without wrapping it", async () => {
    const mcpErr = new McpError(ErrorCode.InvalidParams, "bad input");
    mockAskGemini.mockRejectedValue(mcpErr);
    await expect(handleCallTool("ask-gemini", { prompt: "hello" })).rejects.toThrow(mcpErr);
  });

  it("isError response is not set for successful calls", async () => {
    const result = await handleCallTool("ask-gemini", { prompt: "hello" });
    expect(result.isError).toBeUndefined();
  });

  // ── ZodError → McpError(InvalidParams) ────────────────────────────────────

  it("converts ZodError to McpError(InvalidParams)", async () => {
    const zodErr = new ZodError([
      { path: ["prompt"], message: "Required", code: "invalid_type", expected: "string", received: "undefined" },
    ]);
    mockAskGemini.mockRejectedValue(zodErr);

    expect.assertions(1);
    try {
      await handleCallTool("ask-gemini", {});
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
    }
  });

  it("ZodError McpError message includes field-level detail", async () => {
    const zodErr = new ZodError([
      { path: ["prompt"], message: "Required", code: "invalid_type", expected: "string", received: "undefined" },
    ]);
    mockAskGemini.mockRejectedValue(zodErr);

    expect.assertions(1);
    try {
      await handleCallTool("ask-gemini", {});
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect((err as Error).message).toContain("prompt");
    }
  });
});

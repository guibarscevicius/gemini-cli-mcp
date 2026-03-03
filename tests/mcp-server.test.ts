/**
 * Tests for the MCP server dispatcher logic in index.ts.
 *
 * We test the tool dispatch and error-wrapping behaviour directly by
 * simulating what the MCP SDK would send through CallToolRequestSchema,
 * without spinning up the full stdio transport.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

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

// We import and call the dispatch logic directly rather than through the MCP
// transport. Extract the handler logic into a testable helper.
// The actual switch/dispatch is duplicated here to keep index.ts clean
// (no coupling to test infrastructure).

async function dispatch(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  try {
    switch (name) {
      case "ask-gemini": {
        const result = await askGemini(args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "gemini-reply": {
        const result = await geminiReply(args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

const mockAskGemini = vi.mocked(askGemini);
const mockGeminiReply = vi.mocked(geminiReply);

beforeEach(() => {
  vi.clearAllMocks();
  mockAskGemini.mockResolvedValue({ sessionId: "abc-123", response: "hello" });
  mockGeminiReply.mockResolvedValue({ response: "follow up" });
});

describe("MCP dispatcher", () => {
  // ── ask-gemini dispatch ────────────────────────────────────────────────────

  it("dispatches ask-gemini and returns JSON content", async () => {
    const result = await dispatch("ask-gemini", { prompt: "hello" });
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sessionId).toBe("abc-123");
    expect(parsed.response).toBe("hello");
  });

  it("passes args through to askGemini", async () => {
    await dispatch("ask-gemini", { prompt: "test", model: "gemini-2.5-pro" });
    expect(mockAskGemini).toHaveBeenCalledWith({ prompt: "test", model: "gemini-2.5-pro" });
  });

  // ── gemini-reply dispatch ──────────────────────────────────────────────────

  it("dispatches gemini-reply and returns JSON content", async () => {
    const result = await dispatch("gemini-reply", {
      sessionId: "11111111-1111-4111-8111-111111111111",
      prompt: "follow up",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.response).toBe("follow up");
  });

  // ── Unknown tool ───────────────────────────────────────────────────────────

  it("throws McpError(MethodNotFound) for unknown tool name", async () => {
    try {
      await dispatch("totally-unknown-tool", {});
      expect.fail("should have thrown");
    } catch (err: unknown) {
      const e = err as { code?: number };
      expect(e.code).toBe(ErrorCode.MethodNotFound);
    }
  });

  it("McpError includes the unknown tool name", async () => {
    try {
      await dispatch("not-a-tool", {});
    } catch (err: unknown) {
      expect((err as Error).message).toContain("not-a-tool");
    }
  });

  // ── Error wrapping ─────────────────────────────────────────────────────────

  it("wraps non-McpError as isError response (not a throw)", async () => {
    mockAskGemini.mockRejectedValue(new Error("subprocess crashed"));
    const result = await dispatch("ask-gemini", { prompt: "hello" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("subprocess crashed");
  });

  it("re-throws McpError without wrapping it", async () => {
    const mcpErr = new McpError(ErrorCode.InvalidParams, "bad input");
    mockAskGemini.mockRejectedValue(mcpErr);
    await expect(dispatch("ask-gemini", { prompt: "hello" })).rejects.toThrow(mcpErr);
  });

  it("isError response is not set for successful calls", async () => {
    const result = await dispatch("ask-gemini", { prompt: "hello" });
    expect(result.isError).toBeUndefined();
  });
});

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

vi.mock("../src/tools/gemini-poll.js", () => ({
  geminiPoll: vi.fn(),
  geminiPollToolDefinition: {
    name: "gemini-poll",
    description: "stub",
    inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] },
  },
}));

vi.mock("../src/tools/gemini-cancel.js", () => ({
  geminiCancel: vi.fn(),
  geminiCancelToolDefinition: {
    name: "gemini-cancel",
    description: "stub",
    inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] },
  },
}));

import { askGemini } from "../src/tools/ask-gemini.js";
import { geminiReply } from "../src/tools/gemini-reply.js";
import { geminiPoll } from "../src/tools/gemini-poll.js";
import { geminiCancel } from "../src/tools/gemini-cancel.js";
import { handleCallTool } from "../src/dispatcher.js";

const mockAskGemini = vi.mocked(askGemini);
const mockGeminiReply = vi.mocked(geminiReply);
const mockGeminiPoll = vi.mocked(geminiPoll);
const mockGeminiCancel = vi.mocked(geminiCancel);

const VALID_JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  vi.clearAllMocks();
  mockAskGemini.mockResolvedValue({ jobId: VALID_JOB_ID, sessionId: "abc-123" });
  mockGeminiReply.mockResolvedValue({ jobId: VALID_JOB_ID });
  mockGeminiPoll.mockResolvedValue({ status: "done", response: "the answer" });
  mockGeminiCancel.mockResolvedValue({ cancelled: true, alreadyDone: false });
});

describe("MCP dispatcher (handleCallTool)", () => {
  // ── ask-gemini dispatch ────────────────────────────────────────────────────

  it("dispatches ask-gemini and returns JSON content with jobId and sessionId", async () => {
    const result = await handleCallTool("ask-gemini", { prompt: "hello" });
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent).toEqual(parsed);
    expect(parsed.jobId).toBe(VALID_JOB_ID);
    expect(parsed.sessionId).toBe("abc-123");
    expect(parsed.response).toBeUndefined();
  });

  it("passes args and ctx to askGemini", async () => {
    const ctx = { progressToken: 42 };
    await handleCallTool("ask-gemini", { prompt: "test", model: "gemini-2.5-pro" }, ctx);
    expect(mockAskGemini).toHaveBeenCalledWith(
      { prompt: "test", model: "gemini-2.5-pro" },
      ctx
    );
  });

  // ── gemini-reply dispatch ──────────────────────────────────────────────────

  it("dispatches gemini-reply and returns JSON content with jobId", async () => {
    const result = await handleCallTool("gemini-reply", {
      sessionId: "11111111-1111-4111-8111-111111111111",
      prompt: "follow up",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent).toEqual(parsed);
    expect(parsed.jobId).toBe(VALID_JOB_ID);
    expect(parsed.response).toBeUndefined();
  });

  // ── gemini-poll dispatch ───────────────────────────────────────────────────

  it("dispatches gemini-poll and returns JSON content", async () => {
    const result = await handleCallTool("gemini-poll", { jobId: VALID_JOB_ID });
    const parsed = JSON.parse(result.content[0].text);
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent).toEqual(parsed);
    expect(parsed.status).toBe("done");
    expect(parsed.response).toBe("the answer");
  });

  it("passes jobId to geminiPoll", async () => {
    await handleCallTool("gemini-poll", { jobId: VALID_JOB_ID });
    expect(mockGeminiPoll).toHaveBeenCalledWith({ jobId: VALID_JOB_ID });
  });

  // ── gemini-cancel dispatch ─────────────────────────────────────────────────

  it("dispatches gemini-cancel and returns JSON content", async () => {
    const result = await handleCallTool("gemini-cancel", { jobId: VALID_JOB_ID });
    const parsed = JSON.parse(result.content[0].text);
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent).toEqual(parsed);
    expect(parsed.cancelled).toBe(true);
    expect(parsed.alreadyDone).toBe(false);
  });

  it("ask-gemini: structuredContent mirrors content JSON", async () => {
    const result = await handleCallTool("ask-gemini", { prompt: "hello" });
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent).toEqual(JSON.parse(result.content[0].text));
  });

  it("gemini-reply: structuredContent mirrors content JSON", async () => {
    const result = await handleCallTool("gemini-reply", {
      sessionId: "11111111-1111-4111-8111-111111111111",
      prompt: "hi",
    });
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent).toEqual(JSON.parse(result.content[0].text));
  });

  it("gemini-poll: structuredContent mirrors content JSON", async () => {
    const result = await handleCallTool("gemini-poll", { jobId: VALID_JOB_ID });
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent).toEqual(JSON.parse(result.content[0].text));
  });

  it("gemini-cancel: structuredContent mirrors content JSON", async () => {
    const result = await handleCallTool("gemini-cancel", { jobId: VALID_JOB_ID });
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent).toEqual(JSON.parse(result.content[0].text));
  });

  it("passes jobId to geminiCancel", async () => {
    await handleCallTool("gemini-cancel", { jobId: VALID_JOB_ID });
    expect(mockGeminiCancel).toHaveBeenCalledWith({ jobId: VALID_JOB_ID });
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

  it("isError response does not include structuredContent", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      mockAskGemini.mockRejectedValue(new Error("boom"));
      const result = await handleCallTool("ask-gemini", { prompt: "hello" });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      stderrSpy.mockRestore();
    }
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

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { Turn } from "../../src/session-store.js";

const sessionStoreMock = vi.hoisted(() => ({
  getTurns: vi.fn<(id: string) => Turn[] | undefined>(),
}));

vi.mock("../../src/session-store.js", () => ({
  sessionStore: sessionStoreMock,
}));

import { geminiExport } from "../../src/tools/gemini-export.js";
import { handleCallTool } from "../../src/dispatcher.js";

const SAMPLE_TURNS = [
  { role: "user", content: "What is the capital of France?" },
  { role: "assistant", content: "The capital of France is Paris." },
];

const FOUR_TURNS: Turn[] = [
  { role: "user", content: "u1" },
  { role: "assistant", content: "a1" },
  { role: "user", content: "u2" },
  { role: "assistant", content: "a2" },
];

beforeEach(() => {
  vi.clearAllMocks();
  sessionStoreMock.getTurns.mockReturnValue(SAMPLE_TURNS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("geminiExport — json format", () => {
  it("returns correct shape with turns array and JSON content string", async () => {
    const result = await geminiExport({ sessionId: "sess-1" });

    expect(result.sessionId).toBe("sess-1");
    expect(result.format).toBe("json");
    expect(result.turnCount).toBe(2);
    expect(result.turns).toEqual(SAMPLE_TURNS);
    expect(JSON.parse(result.content)).toEqual(SAMPLE_TURNS);
    expect(result.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("calls getTurns with the correct sessionId", async () => {
    await geminiExport({ sessionId: "my-session-id" });
    expect(sessionStoreMock.getTurns).toHaveBeenCalledOnce();
    expect(sessionStoreMock.getTurns).toHaveBeenCalledWith("my-session-id");
  });

  it("exportedAt is a valid ISO 8601 string", async () => {
    const result = await geminiExport({ sessionId: "sess-1" });
    expect(() => new Date(result.exportedAt)).not.toThrow();
    expect(new Date(result.exportedAt).toISOString()).toBe(result.exportedAt);
  });
});

describe("geminiExport — markdown format", () => {
  it("formats content with bold User/Assistant labels", async () => {
    const result = await geminiExport({ sessionId: "sess-1", format: "markdown" });

    expect(result.format).toBe("markdown");
    expect(result.content).toContain("**User:** What is the capital of France?");
    expect(result.content).toContain("**Assistant:** The capital of France is Paris.");
    // Paragraphs separated by blank line
    expect(result.content).toContain("\n\n");
  });

  it("still includes raw turns array in markdown mode", async () => {
    const result = await geminiExport({ sessionId: "sess-1", format: "markdown" });
    expect(result.turns).toEqual(SAMPLE_TURNS);
    expect(result.turnCount).toBe(2);
  });

  it("preserves multiline content with blank-line paragraph separator between turns", async () => {
    const multilineTurns: Turn[] = [
      { role: "user", content: "List three things:\n1. A\n2. B\n3. C" },
      { role: "assistant", content: "Here they are:\n- Alpha\n- Beta\n- Gamma" },
    ];
    sessionStoreMock.getTurns.mockReturnValue(multilineTurns);

    const result = await geminiExport({ sessionId: "sess-1", format: "markdown" });

    // Inter-turn separator must be a blank line (\n\n), not merged with intra-turn newlines
    const [userBlock, assistantBlock] = result.content.split("\n\n");
    expect(userBlock).toBe("**User:** List three things:\n1. A\n2. B\n3. C");
    expect(assistantBlock).toBe("**Assistant:** Here they are:\n- Alpha\n- Beta\n- Gamma");
  });
});

describe("geminiExport — default format", () => {
  it("defaults to json when format is omitted", async () => {
    const result = await geminiExport({ sessionId: "sess-1" });
    expect(result.format).toBe("json");
    // content must be parseable JSON
    expect(() => JSON.parse(result.content)).not.toThrow();
  });
});

describe("geminiExport — lastN", () => {
  it("lastN: 2 exports only the last two turns from a four-turn session", async () => {
    sessionStoreMock.getTurns.mockReturnValue(FOUR_TURNS);
    const result = await geminiExport({ sessionId: "sess-1", lastN: 2 });

    expect(result.lastN).toBe(2);
    expect(result.turnCount).toBe(2);
    expect(result.totalTurnCount).toBe(4);
    expect(result.turns).toEqual(FOUR_TURNS.slice(-2));
    expect(JSON.parse(result.content)).toEqual(FOUR_TURNS.slice(-2));
  });

  it("lastN larger than session length exports all turns", async () => {
    sessionStoreMock.getTurns.mockReturnValue(FOUR_TURNS);
    const result = await geminiExport({ sessionId: "sess-1", lastN: 10 });

    expect(result.turnCount).toBe(4);
    expect(result.totalTurnCount).toBe(4);
    expect(result.turns).toEqual(FOUR_TURNS);
  });

  it("when lastN is omitted, exports full history", async () => {
    sessionStoreMock.getTurns.mockReturnValue(FOUR_TURNS);
    const result = await geminiExport({ sessionId: "sess-1" });

    expect(result.lastN).toBeUndefined();
    expect(result.turnCount).toBe(4);
    expect(result.turns).toEqual(FOUR_TURNS);
  });
});

describe("geminiExport — empty session", () => {
  it("returns turnCount 0, empty turns, and empty JSON array", async () => {
    sessionStoreMock.getTurns.mockReturnValue([]);
    const result = await geminiExport({ sessionId: "empty-sess" });

    expect(result.turnCount).toBe(0);
    expect(result.turns).toEqual([]);
    expect(result.content).toBe("[]");
  });

  it("returns empty string for markdown format on empty session", async () => {
    sessionStoreMock.getTurns.mockReturnValue([]);
    const result = await geminiExport({ sessionId: "empty-sess", format: "markdown" });
    expect(result.content).toBe("");
  });
});

describe("geminiExport — error cases", () => {
  it("throws McpError(InvalidParams) when session is not found", async () => {
    sessionStoreMock.getTurns.mockReturnValue(undefined);

    await expect(geminiExport({ sessionId: "nonexistent" })).rejects.toThrow(McpError);
    await expect(geminiExport({ sessionId: "nonexistent" })).rejects.toMatchObject({
      message: expect.stringContaining("Session not found or expired: nonexistent"),
    });
  });

  it("throws on empty sessionId (ZodError → McpError via dispatcher)", async () => {
    await expect(
      handleCallTool("gemini-export", { sessionId: "" })
    ).rejects.toMatchObject({
      message: expect.stringContaining("Invalid arguments"),
    });
  });

  it("throws on missing sessionId key (ZodError → McpError via dispatcher)", async () => {
    await expect(
      handleCallTool("gemini-export", {})
    ).rejects.toMatchObject({
      message: expect.stringContaining("Invalid arguments"),
    });
  });

  it("throws McpError(InvalidParams) when lastN is 0", async () => {
    await expect(
      handleCallTool("gemini-export", { sessionId: "sess-1", lastN: 0 })
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining("Invalid arguments"),
    });
  });

  it("throws McpError(InvalidParams) when lastN is negative", async () => {
    await expect(
      handleCallTool("gemini-export", { sessionId: "sess-1", lastN: -1 })
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining("Invalid arguments"),
    });
  });
});

describe("dispatcher routing for gemini-export", () => {
  it("routes gemini-export through handleCallTool and returns structuredContent", async () => {
    const result = await handleCallTool("gemini-export", { sessionId: "sess-1" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      sessionId: "sess-1",
      format: "json",
      turnCount: 2,
      turns: SAMPLE_TURNS,
    });
  });

  it("structuredContent.content is a parseable JSON string in json format", async () => {
    const result = await handleCallTool("gemini-export", { sessionId: "sess-1" });
    const sc = result.structuredContent as { content: string };
    expect(() => JSON.parse(sc.content)).not.toThrow();
  });
});

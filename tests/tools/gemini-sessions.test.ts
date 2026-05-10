import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { Turn } from "../../src/session-store.js";

const sessionStoreMock = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getTurns: vi.fn<(id: string) => Turn[] | undefined>(),
}));

vi.mock("../../src/session-store.js", () => ({
  sessionStore: sessionStoreMock,
  SESSION_TTL_MS: 3_600_000,
}));

import {
  geminiSessions,
  geminiSessionsToolDefinition,
  type GeminiSessionsListOutput,
  type GeminiSessionsExportOutput,
} from "../../src/tools/gemini-sessions.js";
import { handleCallTool } from "../../src/dispatcher.js";

const SAMPLE_TURNS: Turn[] = [
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
  sessionStoreMock.listSessions.mockReturnValue([]);
  sessionStoreMock.getTurns.mockReturnValue(SAMPLE_TURNS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── list path (no sessionId) ──────────────────────────────────────────────

describe("geminiSessions — list (no sessionId)", () => {
  it("returns empty sessions list with total 0", async () => {
    const result = (await geminiSessions({})) as GeminiSessionsListOutput;
    expect(result).toEqual({ sessions: [], total: 0 });
  });

  it("treats missing input the same as empty object", async () => {
    const result = (await geminiSessions(undefined)) as GeminiSessionsListOutput;
    expect(result).toEqual({ sessions: [], total: 0 });
  });

  it("returns sessions with expiresAt = lastAccessed + SESSION_TTL_MS", async () => {
    sessionStoreMock.listSessions.mockReturnValue([
      { id: "s1", lastAccessed: 1_000, turnCount: 2 },
      { id: "s2", lastAccessed: 2_500, turnCount: 0 },
    ]);

    const result = (await geminiSessions({})) as GeminiSessionsListOutput;

    expect(result).toEqual({
      sessions: [
        { id: "s1", lastAccessed: 1_000, turnCount: 2, expiresAt: 3_601_000 },
        { id: "s2", lastAccessed: 2_500, turnCount: 0, expiresAt: 3_602_500 },
      ],
      total: 2,
    });
  });

  it("does not call getTurns when sessionId is omitted", async () => {
    await geminiSessions({});
    expect(sessionStoreMock.getTurns).not.toHaveBeenCalled();
  });

  it("dispatcher routes gemini-sessions (list) and returns structuredContent", async () => {
    sessionStoreMock.listSessions.mockReturnValue([
      { id: "s1", lastAccessed: 10, turnCount: 1 },
    ]);

    const result = await handleCallTool("gemini-sessions", {});

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      sessions: [{ id: "s1", lastAccessed: 10, turnCount: 1, expiresAt: 3_600_010 }],
      total: 1,
    });
  });

  it("wraps listSessions() failures as McpError(InternalError)", async () => {
    sessionStoreMock.listSessions.mockImplementation(() => {
      throw new Error("database is locked");
    });

    await expect(geminiSessions({})).rejects.toThrow(McpError);
    await expect(geminiSessions({})).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining("Failed to list sessions: database is locked"),
    });
  });
});

// ── export path (with sessionId) ──────────────────────────────────────────

describe("geminiSessions — export (json format)", () => {
  it("returns correct shape with turns array and JSON content string", async () => {
    const result = (await geminiSessions({ sessionId: "sess-1" })) as GeminiSessionsExportOutput;

    expect(result.sessionId).toBe("sess-1");
    expect(result.format).toBe("json");
    expect(result.turnCount).toBe(2);
    expect(result.turns).toEqual(SAMPLE_TURNS);
    expect(JSON.parse(result.content)).toEqual(SAMPLE_TURNS);
    expect(result.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("calls getTurns with the correct sessionId", async () => {
    await geminiSessions({ sessionId: "my-session-id" });
    expect(sessionStoreMock.getTurns).toHaveBeenCalledOnce();
    expect(sessionStoreMock.getTurns).toHaveBeenCalledWith("my-session-id");
  });

  it("does not call listSessions when sessionId is provided", async () => {
    await geminiSessions({ sessionId: "sess-1" });
    expect(sessionStoreMock.listSessions).not.toHaveBeenCalled();
  });

  it("exportedAt is a valid ISO 8601 string", async () => {
    const result = (await geminiSessions({ sessionId: "sess-1" })) as GeminiSessionsExportOutput;
    expect(() => new Date(result.exportedAt)).not.toThrow();
    expect(new Date(result.exportedAt).toISOString()).toBe(result.exportedAt);
  });
});

describe("geminiSessions — export (markdown format)", () => {
  it("formats content with bold User/Assistant labels", async () => {
    const result = (await geminiSessions({ sessionId: "sess-1", format: "markdown" })) as GeminiSessionsExportOutput;

    expect(result.format).toBe("markdown");
    expect(result.content).toContain("**User:** What is the capital of France?");
    expect(result.content).toContain("**Assistant:** The capital of France is Paris.");
    expect(result.content).toContain("\n\n");
  });

  it("still includes raw turns array in markdown mode", async () => {
    const result = (await geminiSessions({ sessionId: "sess-1", format: "markdown" })) as GeminiSessionsExportOutput;
    expect(result.turns).toEqual(SAMPLE_TURNS);
    expect(result.turnCount).toBe(2);
  });

  it("preserves multiline content with blank-line paragraph separator between turns", async () => {
    const multilineTurns: Turn[] = [
      { role: "user", content: "List three things:\n1. A\n2. B\n3. C" },
      { role: "assistant", content: "Here they are:\n- Alpha\n- Beta\n- Gamma" },
    ];
    sessionStoreMock.getTurns.mockReturnValue(multilineTurns);

    const result = (await geminiSessions({ sessionId: "sess-1", format: "markdown" })) as GeminiSessionsExportOutput;

    const [userBlock, assistantBlock] = result.content.split("\n\n");
    expect(userBlock).toBe("**User:** List three things:\n1. A\n2. B\n3. C");
    expect(assistantBlock).toBe("**Assistant:** Here they are:\n- Alpha\n- Beta\n- Gamma");
  });
});

describe("geminiSessions — export (default format)", () => {
  it("defaults to json when format is omitted", async () => {
    const result = (await geminiSessions({ sessionId: "sess-1" })) as GeminiSessionsExportOutput;
    expect(result.format).toBe("json");
    expect(() => JSON.parse(result.content)).not.toThrow();
  });
});

describe("geminiSessions — export (lastN)", () => {
  it("lastN: 2 exports only the last two turns from a four-turn session", async () => {
    sessionStoreMock.getTurns.mockReturnValue(FOUR_TURNS);
    const result = (await geminiSessions({ sessionId: "sess-1", lastN: 2 })) as GeminiSessionsExportOutput;

    expect(result.lastN).toBe(2);
    expect(result.turnCount).toBe(2);
    expect(result.totalTurnCount).toBe(4);
    expect(result.turns).toEqual(FOUR_TURNS.slice(-2));
    expect(JSON.parse(result.content)).toEqual(FOUR_TURNS.slice(-2));
  });

  it("lastN larger than session length exports all turns", async () => {
    sessionStoreMock.getTurns.mockReturnValue(FOUR_TURNS);
    const result = (await geminiSessions({ sessionId: "sess-1", lastN: 10 })) as GeminiSessionsExportOutput;

    expect(result.turnCount).toBe(4);
    expect(result.totalTurnCount).toBe(4);
    expect(result.turns).toEqual(FOUR_TURNS);
  });

  it("when lastN is omitted, exports full history", async () => {
    sessionStoreMock.getTurns.mockReturnValue(FOUR_TURNS);
    const result = (await geminiSessions({ sessionId: "sess-1" })) as GeminiSessionsExportOutput;

    expect(result.lastN).toBeUndefined();
    expect(result.turnCount).toBe(4);
    expect(result.turns).toEqual(FOUR_TURNS);
  });
});

describe("geminiSessions — export (empty session)", () => {
  it("returns turnCount 0, empty turns, and empty JSON array", async () => {
    sessionStoreMock.getTurns.mockReturnValue([]);
    const result = (await geminiSessions({ sessionId: "empty-sess" })) as GeminiSessionsExportOutput;

    expect(result.turnCount).toBe(0);
    expect(result.turns).toEqual([]);
    expect(result.content).toBe("[]");
  });

  it("returns empty string for markdown format on empty session", async () => {
    sessionStoreMock.getTurns.mockReturnValue([]);
    const result = (await geminiSessions({ sessionId: "empty-sess", format: "markdown" })) as GeminiSessionsExportOutput;
    expect(result.content).toBe("");
  });
});

describe("geminiSessions — error cases", () => {
  it("throws McpError(InvalidParams) when session is not found", async () => {
    sessionStoreMock.getTurns.mockReturnValue(undefined);

    await expect(geminiSessions({ sessionId: "nonexistent" })).rejects.toThrow(McpError);
    await expect(geminiSessions({ sessionId: "nonexistent" })).rejects.toMatchObject({
      message: expect.stringContaining("Session not found or expired: nonexistent"),
    });
  });

  it("rejects empty sessionId (Zod min(1)) via dispatcher", async () => {
    await expect(
      handleCallTool("gemini-sessions", { sessionId: "" })
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining("Invalid arguments"),
    });
  });

  it("rejects lastN = 0 via dispatcher", async () => {
    await expect(
      handleCallTool("gemini-sessions", { sessionId: "sess-1", lastN: 0 })
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining("Invalid arguments"),
    });
  });

  it("rejects negative lastN via dispatcher", async () => {
    await expect(
      handleCallTool("gemini-sessions", { sessionId: "sess-1", lastN: -1 })
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining("Invalid arguments"),
    });
  });
});

describe("dispatcher routing for gemini-sessions", () => {
  it("routes gemini-sessions (export) through handleCallTool and returns structuredContent", async () => {
    const result = await handleCallTool("gemini-sessions", { sessionId: "sess-1" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      sessionId: "sess-1",
      format: "json",
      turnCount: 2,
      turns: SAMPLE_TURNS,
    });
  });

  it("structuredContent.content is a parseable JSON string in json format", async () => {
    const result = await handleCallTool("gemini-sessions", { sessionId: "sess-1" });
    const sc = result.structuredContent as { content: string };
    expect(() => JSON.parse(sc.content)).not.toThrow();
  });
});

describe("geminiSessionsToolDefinition", () => {
  it("declares oneOf in outputSchema for the list/export discriminator", () => {
    const schema = geminiSessionsToolDefinition.outputSchema as { oneOf?: unknown[] };
    expect(schema.oneOf).toBeDefined();
    expect(Array.isArray(schema.oneOf)).toBe(true);
    expect((schema.oneOf as unknown[]).length).toBe(2);
  });
});

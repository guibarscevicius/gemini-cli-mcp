import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

const sessionStoreMock = vi.hoisted(() => ({
  listSessions: vi.fn(),
}));

vi.mock("../../src/session-store.js", () => ({
  sessionStore: sessionStoreMock,
  SESSION_TTL_MS: 3_600_000,
}));

import { handleCallTool } from "../../src/dispatcher.js";
import {
  geminiListSessions,
  geminiListSessionsToolDefinition,
} from "../../src/tools/gemini-list-sessions.js";

beforeEach(() => {
  vi.clearAllMocks();
  sessionStoreMock.listSessions.mockReturnValue([]);
});

describe("geminiListSessions", () => {
  it("returns empty sessions list with total 0", async () => {
    const result = await geminiListSessions({});
    expect(result).toEqual({ sessions: [], total: 0 });
  });

  it("returns sessions with expiresAt = lastAccessed + SESSION_TTL_MS", async () => {
    sessionStoreMock.listSessions.mockReturnValue([
      { id: "s1", lastAccessed: 1_000, turnCount: 2 },
      { id: "s2", lastAccessed: 2_500, turnCount: 0 },
    ]);

    const result = await geminiListSessions({});

    expect(result).toEqual({
      sessions: [
        { id: "s1", lastAccessed: 1_000, turnCount: 2, expiresAt: 3_601_000 },
        { id: "s2", lastAccessed: 2_500, turnCount: 0, expiresAt: 3_602_500 },
      ],
      total: 2,
    });
  });

  it("dispatcher routes gemini-list-sessions and returns structuredContent", async () => {
    sessionStoreMock.listSessions.mockReturnValue([
      { id: "s1", lastAccessed: 10, turnCount: 1 },
    ]);

    const result = await handleCallTool("gemini-list-sessions", {});

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      sessions: [{ id: "s1", lastAccessed: 10, turnCount: 1, expiresAt: 3_600_010 }],
      total: 1,
    });
  });

  it("output matches geminiListSessionsToolDefinition.outputSchema shape", async () => {
    sessionStoreMock.listSessions.mockReturnValue([
      { id: "s1", lastAccessed: 10, turnCount: 1 },
    ]);

    const result = await geminiListSessions({});
    const schema = geminiListSessionsToolDefinition.outputSchema as {
      required: string[];
      properties: {
        sessions: {
          items: { required: string[] };
        };
      };
    };

    for (const key of schema.required) {
      expect(result).toHaveProperty(key);
    }
    for (const item of result.sessions) {
      for (const key of schema.properties.sessions.items.required) {
        expect(item).toHaveProperty(key);
      }
    }
  });

  it("wraps listSessions() failures as McpError(InternalError)", async () => {
    sessionStoreMock.listSessions.mockImplementation(() => {
      throw new Error("database is locked");
    });

    await expect(geminiListSessions({})).rejects.toThrow(McpError);
    await expect(geminiListSessions({})).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining("Failed to list sessions: database is locked"),
    });
  });
});

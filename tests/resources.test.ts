import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

// --- mock gemini-runner ---
const runnerMock = vi.hoisted(() => ({
  getServerStats: vi.fn(),
  GEMINI_BINARY: "gemini",
}));
vi.mock("../src/gemini-runner.js", () => ({
  getServerStats: runnerMock.getServerStats,
  GEMINI_BINARY: runnerMock.GEMINI_BINARY,
}));

// --- mock job-store ---
const jobStoreMock = vi.hoisted(() => ({
  getJobStats: vi.fn(),
  listActiveJobs: vi.fn(),
  getJob: vi.fn(),
}));
vi.mock("../src/job-store.js", () => ({
  getJobStats: jobStoreMock.getJobStats,
  listActiveJobs: jobStoreMock.listActiveJobs,
  getJob: jobStoreMock.getJob,
}));

// --- mock session-store ---
const sessionStoreMock = vi.hoisted(() => ({
  getSessionCount: vi.fn(),
  listSessions: vi.fn(),
  getSessionMeta: vi.fn(),
}));
vi.mock("../src/session-store.js", () => ({
  sessionStore: sessionStoreMock,
}));

import { readResource, STATIC_RESOURCES, RESOURCE_TEMPLATES } from "../src/resources.js";

function parseContents(result: Awaited<ReturnType<typeof readResource>>): unknown {
  const text = (result.contents[0] as { text: string }).text;
  return JSON.parse(text);
}

describe("STATIC_RESOURCES", () => {
  it("contains all 3 static URIs", () => {
    const uris = STATIC_RESOURCES.map((r) => r.uri);
    expect(uris).toContain("gemini://server/health");
    expect(uris).toContain("gemini://sessions");
    expect(uris).toContain("gemini://jobs");
  });

  it("all static resources have mimeType application/json", () => {
    for (const r of STATIC_RESOURCES) {
      expect(r.mimeType).toBe("application/json");
    }
  });
});

describe("RESOURCE_TEMPLATES", () => {
  it("contains both template URIs", () => {
    const templates = RESOURCE_TEMPLATES.map((t) => t.uriTemplate);
    expect(templates).toContain("gemini://sessions/{sessionId}");
    expect(templates).toContain("gemini://jobs/{jobId}");
  });

  it("all templates have mimeType application/json", () => {
    for (const t of RESOURCE_TEMPLATES) {
      expect(t.mimeType).toBe("application/json");
    }
  });
});

describe("readResource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runnerMock.getServerStats.mockReturnValue({
      semaphore: { active: 1, queued: 0 },
      pool: { enabled: true, ready: 2, size: 2 },
      maxConcurrent: 2,
    });
    jobStoreMock.getJobStats.mockReturnValue({ active: 1, total: 3 });
    sessionStoreMock.getSessionCount.mockReturnValue(5);
  });

  // --- health ---
  it("gemini://server/health returns valid health shape", () => {
    const result = readResource("gemini://server/health");
    const data = parseContents(result) as Record<string, unknown>;
    expect(data).toHaveProperty("binary");
    expect(data).toHaveProperty("pool");
    expect(data).toHaveProperty("concurrency");
    expect(data).toHaveProperty("jobs");
    expect(data).toHaveProperty("sessions");
    expect(data).toHaveProperty("server");
    expect((data.server as Record<string, unknown>)).toHaveProperty("uptime");
    expect((data.server as Record<string, unknown>)).toHaveProperty("version");
    expect((data.sessions as Record<string, unknown>).total).toBe(5);
    expect((data.jobs as Record<string, unknown>).active).toBe(1);
  });

  it("gemini://server/health URI is preserved in contents", () => {
    const result = readResource("gemini://server/health");
    expect(result.contents[0].uri).toBe("gemini://server/health");
    expect(result.contents[0].mimeType).toBe("application/json");
  });

  // --- sessions list ---
  it("gemini://sessions returns sessions list", () => {
    sessionStoreMock.listSessions.mockReturnValue([
      { id: "s1", lastAccessed: 1000, turnCount: 2 },
      { id: "s2", lastAccessed: 2000, turnCount: 4 },
    ]);
    const result = readResource("gemini://sessions");
    const data = parseContents(result) as { sessions: unknown[] };
    expect(data.sessions).toHaveLength(2);
    expect((data.sessions[0] as Record<string, unknown>).id).toBe("s1");
  });

  // --- jobs list ---
  it("gemini://jobs returns only pending jobs", () => {
    jobStoreMock.listActiveJobs.mockReturnValue([
      { id: "j1", createdAt: 1000 },
    ]);
    const result = readResource("gemini://jobs");
    const data = parseContents(result) as { jobs: unknown[] };
    expect(data.jobs).toHaveLength(1);
    expect((data.jobs[0] as Record<string, unknown>).id).toBe("j1");
  });

  // --- session detail ---
  it("gemini://sessions/{id} returns session with turns", () => {
    sessionStoreMock.getSessionMeta.mockReturnValue({
      lastAccessed: 9999,
      turns: [{ role: "user", content: "hi" }],
    });
    const result = readResource("gemini://sessions/abc");
    const data = parseContents(result) as Record<string, unknown>;
    expect(data.id).toBe("abc");
    expect(data.lastAccessed).toBe(9999);
    expect(data.turnCount).toBe(1);
    expect(Array.isArray(data.turns)).toBe(true);
  });

  it("gemini://sessions/{id} throws McpError when session not found", () => {
    sessionStoreMock.getSessionMeta.mockReturnValue(undefined);
    expect(() => readResource("gemini://sessions/missing")).toThrow(McpError);
    expect(() => readResource("gemini://sessions/missing")).toThrow(
      expect.objectContaining({ code: ErrorCode.InvalidParams })
    );
  });

  // --- job detail ---
  it("gemini://jobs/{id} returns job data", () => {
    jobStoreMock.getJob.mockReturnValue({
      status: "done",
      createdAt: 1234,
      partialResponse: "",
      response: "hello",
    });
    const result = readResource("gemini://jobs/j42");
    const data = parseContents(result) as Record<string, unknown>;
    expect(data.id).toBe("j42");
    expect(data.status).toBe("done");
    expect(data.response).toBe("hello");
    expect(data.error).toBeUndefined();
  });

  it("gemini://jobs/{id} omits undefined fields", () => {
    jobStoreMock.getJob.mockReturnValue({
      status: "pending",
      createdAt: 5678,
      partialResponse: "partial",
    });
    const result = readResource("gemini://jobs/j43");
    const data = parseContents(result) as Record<string, unknown>;
    expect(data.response).toBeUndefined();
    expect(data.error).toBeUndefined();
    expect(data.partialResponse).toBe("partial");
  });

  it("gemini://jobs/{id} throws McpError when job not found", () => {
    jobStoreMock.getJob.mockReturnValue(undefined);
    expect(() => readResource("gemini://jobs/nope")).toThrow(McpError);
    expect(() => readResource("gemini://jobs/nope")).toThrow(
      expect.objectContaining({ code: ErrorCode.InvalidParams })
    );
  });

  // --- unknown URI ---
  it("unknown URI throws McpError(InvalidParams)", () => {
    expect(() => readResource("gemini://unknown/resource")).toThrow(McpError);
    expect(() => readResource("gemini://unknown/resource")).toThrow(
      expect.objectContaining({ code: ErrorCode.InvalidParams })
    );
  });
});

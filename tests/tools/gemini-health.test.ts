import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/gemini-runner.js", () => ({
  discoverGeminiBinary: vi.fn(),
  getServerStats: vi.fn(),
}));

vi.mock("../../src/job-store.js", () => ({
  getJobStats: vi.fn(),
}));

vi.mock("../../src/session-store.js", () => ({
  sessionStore: {
    getSessionCount: vi.fn(),
  },
}));

import { discoverGeminiBinary, getServerStats } from "../../src/gemini-runner.js";
import { getJobStats } from "../../src/job-store.js";
import { sessionStore } from "../../src/session-store.js";
import { handleCallTool } from "../../src/dispatcher.js";
import { geminiHealth } from "../../src/tools/gemini-health.js";

const mockDiscoverGeminiBinary = vi.mocked(discoverGeminiBinary);
const mockGetServerStats = vi.mocked(getServerStats);
const mockGetJobStats = vi.mocked(getJobStats);
const mockSessionStore = vi.mocked(sessionStore);

beforeEach(() => {
  vi.clearAllMocks();
  mockDiscoverGeminiBinary.mockReturnValue("/usr/local/bin/gemini");
  mockGetServerStats.mockReturnValue({
    semaphore: { active: 2, queued: 3 },
    pool: { enabled: true, ready: 1, size: 4 },
    maxConcurrent: 4,
  });
  mockGetJobStats.mockReturnValue({ active: 5, total: 9 });
  mockSessionStore.getSessionCount.mockReturnValue(7);
  vi.spyOn(process, "uptime").mockReturnValue(12.34);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("geminiHealth", () => {
  it("returns health output with all expected fields mapped from stats providers", async () => {
    const result = await geminiHealth({});
    expect(result).toEqual({
      binary: { path: "/usr/local/bin/gemini" },
      pool: { enabled: true, ready: 1, size: 4 },
      concurrency: { max: 4, active: 2, queued: 3 },
      jobs: { active: 5, total: 9 },
      sessions: { total: 7 },
      server: { uptime: 12.34, version: "0.5.0" },
    });
  });

  it("maps fallback 'gemini' binary to null path", async () => {
    mockDiscoverGeminiBinary.mockReturnValue("gemini");
    const result = await geminiHealth({});
    expect(result.binary.path).toBeNull();
  });
});

describe("dispatcher routing for gemini-health", () => {
  it("routes gemini-health through handleCallTool and returns structuredContent", async () => {
    const result = await handleCallTool("gemini-health", {});

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      binary: { path: "/usr/local/bin/gemini" },
      pool: { enabled: true, ready: 1, size: 4 },
      concurrency: { max: 4, active: 2, queued: 3 },
      jobs: { active: 5, total: 9 },
      sessions: { total: 7 },
      server: { uptime: 12.34, version: "0.5.0" },
    });
  });
});

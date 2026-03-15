import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { version } from "../../package.json";

const runnerMock = vi.hoisted(() => ({
  geminiBinary: "/usr/local/bin/gemini",
  getServerStats: vi.fn(),
  getEnvOverrides: vi.fn(),
}));

vi.mock("../../src/gemini-runner.js", () => ({
  get GEMINI_BINARY() {
    return runnerMock.geminiBinary;
  },
  getServerStats: runnerMock.getServerStats,
  getEnvOverrides: runnerMock.getEnvOverrides,
}));

vi.mock("../../src/job-store.js", () => ({
  getJobStats: vi.fn(),
}));

vi.mock("../../src/session-store.js", () => ({
  sessionStore: {
    getSessionCount: vi.fn(),
  },
}));

import { getServerStats } from "../../src/gemini-runner.js";
import { getJobStats } from "../../src/job-store.js";
import { sessionStore } from "../../src/session-store.js";
import { handleCallTool } from "../../src/dispatcher.js";
import { geminiHealth } from "../../src/tools/gemini-health.js";

const mockGetServerStats = vi.mocked(getServerStats);
const mockGetJobStats = vi.mocked(getJobStats);
const mockSessionStore = vi.mocked(sessionStore);

beforeEach(() => {
  vi.clearAllMocks();
  runnerMock.geminiBinary = "/usr/local/bin/gemini";
  mockGetServerStats.mockReturnValue({
    semaphore: { active: 2, queued: 3 },
    pool: {
      enabled: true,
      ready: 1,
      size: 4,
      lastError: "spawn ENOENT",
      consecutiveFailures: 2,
    },
    maxConcurrent: 4,
  });
  runnerMock.getEnvOverrides.mockReturnValue({ GEMINI_MAX_CONCURRENT: 4 });
  mockGetJobStats.mockReturnValue({
    active: 5,
    total: 9,
    byStatus: { pending: 5, done: 2, error: 1, cancelled: 1 },
  });
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
      env: { GEMINI_MAX_CONCURRENT: 4 },
      pool: { enabled: true, ready: 1, size: 4, lastError: "spawn ENOENT", consecutiveFailures: 2 },
      concurrency: { max: 4, active: 2, queued: 3 },
      jobs: {
        active: 5,
        total: 9,
        byStatus: { pending: 5, done: 2, error: 1, cancelled: 1 },
      },
      sessions: { total: 7 },
      server: { uptime: 12.34, version },
    });
  });

  it("maps fallback 'gemini' binary to null path", async () => {
    runnerMock.geminiBinary = "gemini";
    const result = await geminiHealth({});
    expect(result.binary.path).toBeNull();
  });

  it("returns env as an empty object when no overrides are set", async () => {
    runnerMock.getEnvOverrides.mockReturnValue({});
    const result = await geminiHealth({});
    expect(result.env).toEqual({});
  });
});

describe("dispatcher routing for gemini-health", () => {
  it("routes gemini-health through handleCallTool and returns structuredContent", async () => {
    const result = await handleCallTool("gemini-health", {});

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      binary: { path: "/usr/local/bin/gemini" },
      env: { GEMINI_MAX_CONCURRENT: 4 },
      pool: { enabled: true, ready: 1, size: 4, lastError: "spawn ENOENT", consecutiveFailures: 2 },
      concurrency: { max: 4, active: 2, queued: 3 },
      jobs: {
        active: 5,
        total: 9,
        byStatus: { pending: 5, done: 2, error: 1, cancelled: 1 },
      },
      sessions: { total: 7 },
      server: { uptime: 12.34, version },
    });
  });
});

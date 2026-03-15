import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

vi.mock("../../src/gemini-runner.js", () => ({
  runGemini: vi.fn(),
  spawnGemini: vi.fn(),
  countFileRefs: vi.fn(() => 0),
  SemaphoreTimeoutError: class SemaphoreTimeoutError extends Error {
    constructor(timeoutMs: number) {
      super(`Gemini request timed out after ${timeoutMs}ms waiting for a concurrency slot`);
      this.name = "SemaphoreTimeoutError";
    }
  },
}));

vi.mock("../../src/job-store.js", () => ({
  createJob: vi.fn(),
  getJob: vi.fn(),
  appendChunk: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
  cancelJob: vi.fn(),
}));

vi.mock("../../src/request-map.js", () => ({
  registerRequest: vi.fn(),
  unregisterRequest: vi.fn(),
  unregisterByJobId: vi.fn(),
  getJobByRequestId: vi.fn(),
  clearMap: vi.fn(),
}));

vi.mock("../../src/tools/shared.js", () => ({
  runGeminiAsync: vi.fn(),
  waitForJob: vi.fn(),
  elicitCwdIfNeeded: vi.fn(),
  DEFAULT_WAIT_MS: 90_000,
}));

import { runGeminiAsync, waitForJob, elicitCwdIfNeeded } from "../../src/tools/shared.js";
import { countFileRefs } from "../../src/gemini-runner.js";
import {
  geminiResearch,
  geminiResearchToolDefinition,
} from "../../src/tools/gemini-research.js";

const mockRunGeminiAsync = vi.mocked(runGeminiAsync);
const mockWaitForJob = vi.mocked(waitForJob);
const mockElicitCwdIfNeeded = vi.mocked(elicitCwdIfNeeded);
const mockCountFileRefs = vi.mocked(countFileRefs);

beforeEach(() => {
  vi.clearAllMocks();
  mockElicitCwdIfNeeded.mockImplementation(async (_prompt, cwd) => cwd);
  mockRunGeminiAsync.mockResolvedValue("research response");
  mockWaitForJob.mockResolvedValue({ response: "final response" });
});

describe("geminiResearch", () => {
  it("throws ZodError when query is missing", async () => {
    await expect(geminiResearch({})).rejects.toThrow(ZodError);
  });

  it("accepts valid depth enum values", async () => {
    await expect(geminiResearch({ query: "q", depth: "quick", wait: false })).resolves.toBeDefined();
    await expect(geminiResearch({ query: "q", depth: "standard", wait: false })).resolves.toBeDefined();
    await expect(geminiResearch({ query: "q", depth: "deep", wait: false })).resolves.toBeDefined();
  });

  it("throws ZodError for invalid depth", async () => {
    await expect(geminiResearch({ query: "q", depth: "shallow" })).rejects.toThrow(ZodError);
  });

  it("prepends quick preamble", async () => {
    await geminiResearch({ query: "What is MCP?", depth: "quick", wait: false });
    expect(mockRunGeminiAsync.mock.calls[0][1]).toBe(
      "Answer the following question directly and concisely. Prefer existing knowledge; use web search only if current/real-time data is clearly needed.\n\nWhat is MCP?"
    );
    expect(mockRunGeminiAsync.mock.calls[0][2]).not.toHaveProperty("research");
  });

  it("prepends standard preamble", async () => {
    await geminiResearch({ query: "What is MCP?", depth: "standard", wait: false });
    expect(mockRunGeminiAsync.mock.calls[0][1]).toBe(
      "Research and answer the following question thoroughly. Use web search to verify facts and gather current information. Synthesize findings into a well-structured response with key findings highlighted.\n\nWhat is MCP?"
    );
  });

  it("prepends deep preamble", async () => {
    await geminiResearch({ query: "What is MCP?", depth: "deep", wait: false });
    expect(mockRunGeminiAsync.mock.calls[0][1]).toBe(
      "Conduct a comprehensive research investigation into the following question. Use multiple web searches, cross-reference sources, explore subtopics, and verify claims from independent sources. Produce a detailed report with: executive summary, key findings, supporting evidence, uncertainties or conflicting information, and actionable conclusions.\n\nWhat is MCP?"
    );
  });

  it("throws McpError when elicitation is cancelled (resolvedCwd === null)", async () => {
    mockElicitCwdIfNeeded.mockResolvedValueOnce(null);
    await expect(
      geminiResearch({ query: "@file1.ts and @file2.ts" }, { elicit: vi.fn() })
    ).rejects.toThrow(McpError);

    mockElicitCwdIfNeeded.mockResolvedValueOnce(null);
    await expect(
      geminiResearch({ query: "@file1.ts and @file2.ts" }, { elicit: vi.fn() })
    ).rejects.toThrow("cancelled by user");
  });

  it("throws McpError when elicitation unsupported and multiple @file refs present", async () => {
    mockElicitCwdIfNeeded.mockResolvedValueOnce(undefined);
    mockCountFileRefs.mockReturnValueOnce(2);
    await expect(
      geminiResearch({ query: "@file1.ts and @file2.ts" }, {})
    ).rejects.toThrow(McpError);
  });

  it("wait: true returns { jobId, response, pollIntervalMs }", async () => {
    mockWaitForJob.mockResolvedValue({ response: "done" });
    const result = await geminiResearch({ query: "q", wait: true });
    expect(result).toMatchObject({
      jobId: expect.any(String),
      response: "done",
      pollIntervalMs: 2000,
    });
  });

  it("wait: false returns { jobId, pollIntervalMs } immediately", async () => {
    const result = await geminiResearch({ query: "q", wait: false });
    expect(result).toEqual({
      jobId: expect.any(String),
      pollIntervalMs: 2000,
    });
    expect(mockWaitForJob).not.toHaveBeenCalled();
  });

  it("deep uses a larger default waitTimeoutMs than standard", async () => {
    await geminiResearch({ query: "q", depth: "standard", wait: true });
    await geminiResearch({ query: "q", depth: "deep", wait: true });

    expect(mockWaitForJob.mock.calls[0][1]).toBe(90_000);
    expect(mockWaitForJob.mock.calls[1][1]).toBe(180_000);
  });

  it("returns timeout fallback with partialResponse", async () => {
    mockWaitForJob.mockResolvedValue({ partialResponse: "partial", timedOut: true });
    const result = await geminiResearch({ query: "q", wait: true });
    expect(result).toMatchObject({
      jobId: expect.any(String),
      partialResponse: "partial",
      timedOut: true,
      pollIntervalMs: 2000,
    });
  });
});

describe("geminiResearchToolDefinition", () => {
  it("has expected name", () => {
    expect(geminiResearchToolDefinition.name).toBe("gemini-research");
  });

  it("sets annotations.openWorldHint to true", () => {
    expect(geminiResearchToolDefinition.annotations?.openWorldHint).toBe(true);
  });

  it("requires query in input schema", () => {
    expect((geminiResearchToolDefinition.inputSchema as { required?: string[] }).required).toEqual([
      "query",
    ]);
  });
});

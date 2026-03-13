import { z } from "zod";
import { createRequire } from "node:module";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { GEMINI_BINARY, getServerStats } from "../gemini-runner.js";
import { getJobStats } from "../job-store.js";
import { sessionStore } from "../session-store.js";

const GeminiHealthSchema = z.object({}).optional();
const _require = createRequire(import.meta.url);
const SERVER_VERSION: string = (_require("../../package.json") as { version: string }).version;

export interface GeminiHealthOutput {
  binary: { path: string | null };
  pool: { enabled: boolean; ready: number; size: number };
  concurrency: { max: number; active: number; queued: number };
  jobs: { active: number; total: number };
  sessions: { total: number };
  server: { uptime: number; version: string };
}

export async function geminiHealth(input: unknown): Promise<GeminiHealthOutput> {
  GeminiHealthSchema.parse(input);

  const binaryPath = GEMINI_BINARY;
  const serverStats = getServerStats();
  const jobStats = getJobStats();

  return {
    binary: { path: binaryPath === "gemini" ? null : binaryPath },
    pool: {
      enabled: serverStats.pool.enabled,
      ready: serverStats.pool.ready,
      size: serverStats.pool.size,
    },
    concurrency: {
      max: serverStats.maxConcurrent,
      active: serverStats.semaphore.active,
      queued: serverStats.semaphore.queued,
    },
    jobs: {
      active: jobStats.active,
      total: jobStats.total,
    },
    sessions: {
      total: sessionStore.getSessionCount(),
    },
    server: {
      uptime: process.uptime(),
      version: SERVER_VERSION,
    },
  };
}

export const geminiHealthToolDefinition: Tool = {
  name: "gemini-health",
  title: "Get Gemini Health",
  description:
    "Return runtime health diagnostics: binary path, pool/semaphore concurrency, active jobs, session count, and server uptime.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      binary: {
        type: "object",
        properties: {
          path: { type: ["string", "null"] },
        },
        required: ["path"],
      },
      pool: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          ready: { type: "number" },
          size: { type: "number" },
        },
        required: ["enabled", "ready", "size"],
      },
      concurrency: {
        type: "object",
        properties: {
          max: { type: "number" },
          active: { type: "number" },
          queued: { type: "number" },
        },
        required: ["max", "active", "queued"],
      },
      jobs: {
        type: "object",
        properties: {
          active: { type: "number" },
          total: { type: "number" },
        },
        required: ["active", "total"],
      },
      sessions: {
        type: "object",
        properties: {
          total: { type: "number" },
        },
        required: ["total"],
      },
      server: {
        type: "object",
        properties: {
          uptime: { type: "number" },
          version: { type: "string" },
        },
        required: ["uptime", "version"],
      },
    },
    required: ["binary", "pool", "concurrency", "jobs", "sessions", "server"],
  },
  annotations: {
    title: "Get Gemini Health",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

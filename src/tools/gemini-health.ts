import { z } from "zod";
import { createRequire } from "node:module";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { GEMINI_BINARY, getServerStats, getEnvOverrides } from "../gemini-runner.js";
import { getJobStats } from "../job-store.js";
import { sessionStore } from "../session-store.js";
import { getCapabilities, isVersionBelow, MIN_SUPPORTED_VERSION } from "../cli-capabilities.js";

const GeminiHealthSchema = z.object({}).optional();
const _require = createRequire(import.meta.url);
const SERVER_VERSION: string = (_require("../../package.json") as { version: string }).version;

export interface GeminiHealthOutput {
  binary: { path: string | null };
  env: Record<string, unknown>;
  pool: {
    enabled: boolean;
    ready: number;
    size: number;
    lastError: string | null;
    consecutiveFailures: number;
  };
  concurrency: { max: number; active: number; queued: number };
  jobs: {
    active: number;
    total: number;
    byStatus: { pending: number; done: number; error: number; cancelled: number };
  };
  sessions: { total: number };
  server: { uptime: number; version: string };
  cli: {
    version: string | null;
    minSupported: string;
    versionOk: boolean;
    detectedFlags: number;
    activeAdaptations: string[];
    detectionError: string | null;
  };
}

export async function geminiHealth(input: unknown): Promise<GeminiHealthOutput> {
  GeminiHealthSchema.parse(input);

  const binaryPath = GEMINI_BINARY;
  const serverStats = getServerStats();
  const jobStats = getJobStats();

  let caps: Awaited<ReturnType<typeof getCapabilities>> | null = null;
  try {
    caps = await getCapabilities(binaryPath);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    process.stderr.write(`[gemini-cli-mcp] health: unexpected getCapabilities error: ${msg}\n`);
  }

  const adaptations: string[] = [];
  if (caps?.hasApprovalMode) {
    adaptations.push("--approval-mode yolo (replaces --yolo)");
  }

  const versionRaw = caps?.version?.raw ?? null;
  const versionOk = caps?.version
    ? !isVersionBelow(caps.version, MIN_SUPPORTED_VERSION)
    : false;

  return {
    binary: { path: binaryPath === "gemini" ? null : binaryPath },
    env: getEnvOverrides(),
    pool: {
      enabled: serverStats.pool.enabled,
      ready: serverStats.pool.ready,
      size: serverStats.pool.size,
      lastError: serverStats.pool.lastError,
      consecutiveFailures: serverStats.pool.consecutiveFailures,
    },
    concurrency: {
      max: serverStats.maxConcurrent,
      active: serverStats.semaphore.active,
      queued: serverStats.semaphore.queued,
    },
    jobs: {
      active: jobStats.active,
      total: jobStats.total,
      byStatus: jobStats.byStatus,
    },
    sessions: {
      total: sessionStore.getSessionCount(),
    },
    server: {
      uptime: process.uptime(),
      version: SERVER_VERSION,
    },
    cli: {
      version: versionRaw,
      minSupported: MIN_SUPPORTED_VERSION.raw,
      versionOk,
      detectedFlags: caps?.flags.size ?? 0,
      activeAdaptations: adaptations,
      detectionError: caps?.error ?? null,
    },
  };
}

export const geminiHealthToolDefinition: Tool = {
  name: "gemini-health",
  title: "Get Gemini Health",
  description:
    "Return runtime diagnostics: binary path, env overrides, pool/semaphore concurrency and pool errors, job totals with per-status counts, session count, server uptime, CLI version/flag detection status, and active flag adaptations.",
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
      env: {
        type: "object",
        additionalProperties: true,
      },
      pool: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          ready: { type: "number" },
          size: { type: "number" },
          lastError: { type: ["string", "null"] },
          consecutiveFailures: { type: "number" },
        },
        required: ["enabled", "ready", "size", "lastError", "consecutiveFailures"],
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
          byStatus: {
            type: "object",
            properties: {
              pending: { type: "number" },
              done: { type: "number" },
              error: { type: "number" },
              cancelled: { type: "number" },
            },
            required: ["pending", "done", "error", "cancelled"],
          },
        },
        required: ["active", "total", "byStatus"],
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
      cli: {
        type: "object",
        properties: {
          version: { type: ["string", "null"] },
          minSupported: { type: "string" },
          versionOk: { type: "boolean" },
          detectedFlags: { type: "number" },
          activeAdaptations: { type: "array", items: { type: "string" } },
          detectionError: { type: ["string", "null"] },
        },
        required: ["version", "minSupported", "versionOk", "detectedFlags", "activeAdaptations", "detectionError"],
      },
    },
    required: ["binary", "env", "pool", "concurrency", "jobs", "sessions", "server", "cli"],
  },
  annotations: {
    title: "Get Gemini Health",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

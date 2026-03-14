import { createRequire } from "node:module";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { Resource, ResourceTemplate, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { GEMINI_BINARY, getServerStats } from "./gemini-runner.js";
import { getJobStats, listActiveJobs, getJob } from "./job-store.js";
import { sessionStore } from "./session-store.js";

const _require = createRequire(import.meta.url);
const { version: pkgVersion } = _require("../package.json") as { version: string };

export const STATIC_RESOURCES: Resource[] = [
  {
    uri: "gemini://server/health",
    name: "Server Health",
    description:
      "Runtime diagnostics: binary path, pool/semaphore concurrency, active jobs, session count, and server uptime.",
    mimeType: "application/json",
  },
  {
    uri: "gemini://sessions",
    name: "Sessions List",
    description: "All active sessions with id, lastAccessed timestamp, and turn count.",
    mimeType: "application/json",
  },
  {
    uri: "gemini://jobs",
    name: "Pending Jobs",
    description: "All currently pending jobs with id and createdAt timestamp.",
    mimeType: "application/json",
  },
];

export const RESOURCE_TEMPLATES: ResourceTemplate[] = [
  {
    uriTemplate: "gemini://sessions/{sessionId}",
    name: "Session Detail",
    description: "Full conversation history for a specific session: id, lastAccessed, turnCount, and all turns.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "gemini://jobs/{jobId}",
    name: "Job Detail",
    description: "Status and result of a specific job: id, status, createdAt, response, partialResponse, and error.",
    mimeType: "application/json",
  },
];

function toJson(uri: string, data: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function readHealth(uri: string): ReadResourceResult {
  const serverStats = getServerStats();
  const jobStats = getJobStats();
  const binaryPath = GEMINI_BINARY;
  return toJson(uri, {
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
      version: pkgVersion,
    },
  });
}

function readSessionsList(uri: string): ReadResourceResult {
  return toJson(uri, { sessions: sessionStore.listSessions() });
}

function readJobsList(uri: string): ReadResourceResult {
  return toJson(uri, { jobs: listActiveJobs() });
}

function readSession(uri: string, sessionId: string): ReadResourceResult {
  const meta = sessionStore.getSessionMeta(sessionId);
  if (!meta) {
    throw new McpError(ErrorCode.InvalidParams, `Session not found: ${sessionId}`);
  }
  return toJson(uri, {
    id: sessionId,
    lastAccessed: meta.lastAccessed,
    turnCount: meta.turns.length,
    turns: meta.turns,
  });
}

function readJob(uri: string, jobId: string): ReadResourceResult {
  const job = getJob(jobId);
  if (!job) {
    throw new McpError(ErrorCode.InvalidParams, `Job not found: ${jobId}`);
  }
  const data: Record<string, unknown> = {
    id: jobId,
    status: job.status,
    createdAt: job.createdAt,
    partialResponse: job.partialResponse,
  };
  if (job.response !== undefined) data.response = job.response;
  if (job.error !== undefined) data.error = job.error;
  return toJson(uri, data);
}

const SESSION_RE = /^gemini:\/\/sessions\/([^/]+)$/;
const JOB_RE = /^gemini:\/\/jobs\/([^/]+)$/;

export function readResource(uri: string): ReadResourceResult {
  if (uri === "gemini://server/health") return readHealth(uri);
  if (uri === "gemini://sessions") return readSessionsList(uri);
  if (uri === "gemini://jobs") return readJobsList(uri);

  const sessionMatch = SESSION_RE.exec(uri);
  if (sessionMatch) return readSession(uri, sessionMatch[1]);

  const jobMatch = JOB_RE.exec(uri);
  if (jobMatch) return readJob(uri, jobMatch[1]);

  throw new McpError(ErrorCode.InvalidParams, `Unknown resource URI: ${uri}`);
}

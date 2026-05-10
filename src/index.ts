#!/usr/bin/env node
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";

import { askGeminiToolDefinition } from "./tools/ask-gemini.js";
import { geminiReplyToolDefinition } from "./tools/gemini-reply.js";
import { geminiPollToolDefinition } from "./tools/gemini-poll.js";
import { geminiCancelToolDefinition } from "./tools/gemini-cancel.js";
import { geminiHealthToolDefinition } from "./tools/gemini-health.js";
import { geminiSessionsToolDefinition } from "./tools/gemini-sessions.js";
import { geminiBatchToolDefinition } from "./tools/gemini-batch.js";
import { geminiResearchToolDefinition } from "./tools/gemini-research.js";
import { handleCallTool } from "./dispatcher.js";
import { getJobByRequestId, unregisterRequest } from "./request-map.js";
import * as jobStore from "./job-store.js";
import { warmPool } from "./gemini-runner.js";
import { initMcpLogger, setMcpLogLevel } from "./logging.js";
import { STATIC_RESOURCES, RESOURCE_TEMPLATES, readResource } from "./resources.js";
import { listPrompts, getPrompt } from "./prompts.js";
import { sessionStore } from "./session-store.js";

const _require = createRequire(import.meta.url);
const { version: pkgVersion } = _require("../package.json") as { version: string };

type ToolServer = Pick<Server, "setRequestHandler" | "getClientCapabilities" | "elicitInput">;
type ShutdownServer = { onclose?: (() => void) | undefined };
type ShutdownSignal = "SIGTERM" | "SIGINT";
type ShutdownExit = (code?: number) => never;
type ShutdownStdin = {
  on(event: "end" | "close", listener: () => void): unknown;
  off?: (event: "end" | "close", listener: () => void) => unknown;
};
type ShutdownProcess = {
  on(event: ShutdownSignal, listener: () => void): unknown;
  exit: ShutdownExit;
  stderr: { write(chunk: string): boolean };
  stdin: ShutdownStdin;
};
type ConnectedServer = ShutdownServer & { connect(transport: StdioServerTransport): Promise<void> };
type PendingJobShutdown = (
  reason?: string,
  forceKillAfterMs?: number
) => Promise<void>;

const DEFAULT_SHUTDOWN_FORCE_KILL_MS = 2000;

export function registerToolHandlers(server: ToolServer): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      askGeminiToolDefinition,
      geminiReplyToolDefinition,
      geminiPollToolDefinition,
      geminiCancelToolDefinition,
      geminiHealthToolDefinition,
      geminiSessionsToolDefinition,
      geminiBatchToolDefinition,
      geminiResearchToolDefinition,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const progressToken = request.params._meta?.progressToken;
    const requestId = extra?.requestId as string | number | undefined;
    const clientCaps = server.getClientCapabilities();
    const ctx = {
      sendNotification: extra?.sendNotification as ((n: unknown) => Promise<void>) | undefined,
      progressToken,
      requestId,
      elicit: clientCaps?.elicitation
        ? (params: Parameters<Server["elicitInput"]>[0]) => server.elicitInput(params)
        : undefined,
    };
    return handleCallTool(name, args, ctx);
  });
}

export function createServer(): Server {
  const capabilities = {
    tools: {},
    logging: {},
    resources: { listChanged: true },
    prompts: {},
    ...({ elicitation: {} } as Record<string, unknown>),
  } as NonNullable<ConstructorParameters<typeof Server>[1]>["capabilities"];

  const server = new Server(
    { name: "gemini-cli-mcp", version: pkgVersion },
    { capabilities }
  );
  initMcpLogger(server);

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: STATIC_RESOURCES,
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: RESOURCE_TEMPLATES,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
    readResource(req.params.uri)
  );

  server.setRequestHandler(ListPromptsRequestSchema, async () =>
    listPrompts()
  );

  server.setRequestHandler(GetPromptRequestSchema, async (req) =>
    getPrompt(req.params.name, req.params.arguments)
  );

  const notifyResourceListChanged = () => {
    try {
      server.sendResourceListChanged().catch((err: unknown) => {
        process.stderr.write(
          `[gemini-cli-mcp] sendResourceListChanged failed: ${err instanceof Error ? err.message : String(err)}\n`
        );
      });
    } catch (err) {
      process.stderr.write(
        `[gemini-cli-mcp] sendResourceListChanged threw synchronously: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  };
  jobStore.setJobListChangedCallback(notifyResourceListChanged);
  sessionStore.setListChangedCallback(notifyResourceListChanged);
  server.setRequestHandler(SetLevelRequestSchema, async (req) => {
    setMcpLogLevel(req.params.level);
    return {};
  });
  registerToolHandlers(server);
  server.setNotificationHandler(CancelledNotificationSchema, async (notification) => {
    const requestId = notification.params?.requestId;
    if (requestId === undefined) {
      process.stderr.write(
        "[gemini-cli-mcp] notifications/cancelled with no requestId — ignoring\n"
      );
      return;
    }
    const jobId = getJobByRequestId(requestId);
    if (!jobId) {
      process.stderr.write(`[gemini-cli-mcp] notifications/cancelled: no job registered for requestId ${String(requestId)}\n`);
      return;
    }
    const job = jobStore.getJob(jobId);
    if (job?.status === "pending") {
      if (job.subprocess === undefined) {
        jobStore.cancelJob(jobId);
      }
    }
    if (job && job.status !== "pending") {
      process.stderr.write(`[gemini-cli-mcp] notifications/cancelled: job ${jobId} already ${job.status} — skipping kill\n`);
    }
    unregisterRequest(requestId);
  });
  return server;
}

const server = createServer();

export function registerShutdownHandlers({
  process: processRef = process,
  server: serverRef,
  shutdown,
}: {
  process?: ShutdownProcess;
  server: ShutdownServer;
  shutdown: (reason: string) => void;
}): () => void {
  let triggered = false;
  const stdin = processRef.stdin as ShutdownStdin;

  const runShutdown = (reason: string) => {
    if (triggered) return;
    triggered = true;
    shutdown(reason);
  };

  const onSigterm = () => runShutdown("SIGTERM");
  const onSigint = () => runShutdown("SIGINT");
  const onStdinEnd = () => runShutdown("stdin end");
  const onStdinClose = () => runShutdown("stdin close");

  processRef.on("SIGTERM", onSigterm);
  processRef.on("SIGINT", onSigint);
  stdin.on("end", onStdinEnd);
  stdin.on("close", onStdinClose);

  const previousOnClose = serverRef.onclose;
  serverRef.onclose = () => {
    previousOnClose?.();
    runShutdown("server close");
  };

  return () => {
    stdin.off?.("end", onStdinEnd);
    stdin.off?.("close", onStdinClose);
    serverRef.onclose = previousOnClose;
  };
}

async function main() {
  await startServer();
}

export async function startServer({
  server: serverRef = server,
  transport = new StdioServerTransport(),
  process: processRef = process,
  shutdownPendingJobs = jobStore.shutdownPendingJobs,
  warmPool: warmPoolRef = warmPool,
}: {
  server?: ConnectedServer;
  transport?: StdioServerTransport;
  process?: ShutdownProcess;
  shutdownPendingJobs?: PendingJobShutdown;
  warmPool?: typeof warmPool;
} = {}): Promise<void> {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = async (reason: string): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;

    shutdownPromise = (async () => {
      processRef.stderr.write(`[gemini-cli-mcp] received ${reason}, shutting down Gemini processes…\n`);
      await shutdownPendingJobs("Server shutting down", DEFAULT_SHUTDOWN_FORCE_KILL_MS);
      if (warmPoolRef !== null) {
        await warmPoolRef.drain();
      }
      await transport.close();
    })();

    return shutdownPromise;
  };

  registerShutdownHandlers({
    process: processRef,
    server: serverRef,
    shutdown: (reason) => {
      shutdown(reason).then(() => {
        processRef.exit(0);
      }).catch((err) => {
        processRef.stderr.write(`[gemini-cli-mcp] shutdown error: ${err instanceof Error ? err.message : String(err)}\n`);
        processRef.exit(1);
      });
    },
  });

  await serverRef.connect(transport);
  // stderr is safe to use — MCP protocol uses stdout/stdin only
  processRef.stderr.write("gemini-cli-mcp server started\n");
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  if (process.argv.includes("--setup")) {
    import("./setup.js")
      .then(({ runSetup }) => runSetup())
      .then(() => process.exit(0))
      .catch((err) => {
        process.stderr.write(`Setup error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      });
  } else {
    main().catch((err) => {
      process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
  }
}

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

vi.mock("../src/dispatcher.js", () => ({
  handleCallTool: vi.fn(),
}));

vi.mock("../src/process-group.js", () => ({
  killGroup: vi.fn(() => true),
  spawnInGroup: vi.fn(),
  setupSubreaper: vi.fn(),
}));

import { handleCallTool } from "../src/dispatcher.js";
import { createServer, registerToolHandlers, registerShutdownHandlers, startServer, handleCancelledNotification } from "../src/index.js";
import { killGroup } from "../src/process-group.js";
import * as jobStore from "../src/job-store.js";
import { registerRequest, clearMap, getJobByRequestId } from "../src/request-map.js";
import { _resetMcpLogger } from "../src/logging.js";
import { STATIC_RESOURCES, RESOURCE_TEMPLATES } from "../src/resources.js";
import { askGeminiToolDefinition } from "../src/tools/ask-gemini.js";
import { geminiReplyToolDefinition } from "../src/tools/gemini-reply.js";
import { geminiPollToolDefinition } from "../src/tools/gemini-poll.js";
import { geminiCancelToolDefinition } from "../src/tools/gemini-cancel.js";
import { geminiHealthToolDefinition } from "../src/tools/gemini-health.js";
import { geminiSessionsToolDefinition } from "../src/tools/gemini-sessions.js";
import { geminiBatchToolDefinition } from "../src/tools/gemini-batch.js";
import { geminiResearchToolDefinition } from "../src/tools/gemini-research.js";

type RequestHandler = (
  request: { params: Record<string, unknown> },
  extra?: unknown
) => Promise<unknown>;

const mockHandleCallTool = vi.mocked(handleCallTool);

describe("index wiring", () => {
  let handlers: Map<unknown, RequestHandler>;

  beforeEach(() => {
    handlers = new Map();
    vi.clearAllMocks();
    _resetMcpLogger();
    mockHandleCallTool.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });

    registerToolHandlers({
      setRequestHandler(schema, handler) {
        handlers.set(schema, handler as RequestHandler);
        return this;
      },
      getClientCapabilities() {
        return undefined;
      },
      elicitInput: vi.fn(),
    } as Parameters<typeof registerToolHandlers>[0]);
  });

  it("registers the list-tools handler with all eight tool definitions", async () => {
    const listTools = handlers.get(ListToolsRequestSchema);
    expect(listTools).toBeDefined();
    await expect(listTools!({ params: {} })).resolves.toEqual({
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
    });
  });

  it("passes request.params.arguments and ctx to handleCallTool", async () => {
    const callTool = handlers.get(CallToolRequestSchema);
    const args = { prompt: "hello" };
    const response = { content: [{ type: "text", text: "ok" }] };
    mockHandleCallTool.mockResolvedValueOnce(response);

    expect(callTool).toBeDefined();
    await expect(
      callTool!(
        {
          params: {
            name: "ask-gemini",
            arguments: args,
            args: { prompt: "wrong" },
          },
        },
        undefined // extra (no sendNotification in tests)
      )
    ).resolves.toBe(response);

    expect(mockHandleCallTool).toHaveBeenCalledWith(
      "ask-gemini",
      args,
      expect.objectContaining({ progressToken: undefined, requestId: undefined, elicit: undefined })
    );
  });

  it("passes elicit function to ctx when client supports elicitation", async () => {
    const localHandlers = new Map<unknown, RequestHandler>();
    const elicitInput = vi.fn();

    registerToolHandlers({
      setRequestHandler(schema, handler) {
        localHandlers.set(schema, handler as RequestHandler);
        return this;
      },
      getClientCapabilities() {
        return { elicitation: {} };
      },
      elicitInput,
    } as Parameters<typeof registerToolHandlers>[0]);

    const callTool = localHandlers.get(CallToolRequestSchema);
    expect(callTool).toBeDefined();
    await callTool!(
      {
        params: {
          name: "ask-gemini",
          arguments: { prompt: "hello" },
        },
      },
      undefined
    );

    expect(mockHandleCallTool).toHaveBeenCalledWith(
      "ask-gemini",
      { prompt: "hello" },
      expect.objectContaining({ elicit: expect.any(Function) })
    );
  });

  it("createServer includes logging, resources, prompts, and elicitation capabilities", () => {
    const server = createServer() as unknown as {
      _capabilities: {
        tools: Record<string, never>;
        logging: Record<string, never>;
        resources: { listChanged: boolean };
        prompts: Record<string, never>;
        elicitation: Record<string, never>;
      };
    };
    expect(server._capabilities).toEqual({
      tools: {},
      logging: {},
      resources: { listChanged: true },
      prompts: {},
      elicitation: {},
    });
  });

  it("createServer registers ListResources, ListResourceTemplates, and ReadResource handlers", async () => {
    const server = createServer() as unknown as {
      _requestHandlers: Map<string, unknown>;
    };
    const rh = server._requestHandlers;
    expect(rh.has("resources/list")).toBe(true);
    expect(rh.has("resources/templates/list")).toBe(true);
    expect(rh.has("resources/read")).toBe(true);
  });

  it("createServer registers ListPrompts and GetPrompt handlers", () => {
    const server = createServer() as unknown as {
      _requestHandlers: Map<string, unknown>;
    };
    const rh = server._requestHandlers;
    expect(rh.has("prompts/list")).toBe(true);
    expect(rh.has("prompts/get")).toBe(true);
  });

  it("ListResources handler returns STATIC_RESOURCES", async () => {
    const server = createServer() as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
    };
    const handler = server._requestHandlers.get("resources/list")!;
    const result = await handler({ method: "resources/list", params: {} });
    expect(result).toEqual({ resources: STATIC_RESOURCES });
  });

  it("ListResourceTemplates handler returns RESOURCE_TEMPLATES", async () => {
    const server = createServer() as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
    };
    const handler = server._requestHandlers.get("resources/templates/list")!;
    const result = await handler({ method: "resources/templates/list", params: {} });
    expect(result).toEqual({ resourceTemplates: RESOURCE_TEMPLATES });
  });
});

describe("registerShutdownHandlers", () => {
  const originalStdin = process.stdin;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs shutdown once when stdin ends and server closes", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const on = vi.fn();
    const stdin = { on } as unknown as NodeJS.ReadStream;
    const signalHandlers = new Map<string, () => void>();
    const processLike = {
      on: vi.fn((event: string, handler: () => void) => {
        signalHandlers.set(event, handler);
        return process;
      }),
      stdin,
    } as unknown as NodeJS.Process;
    const server = {} as { onclose?: () => void };

    const restore = registerShutdownHandlers({
      process: processLike,
      server,
      shutdown,
    });

    const endHandler = on.mock.calls.find(([event]) => event === "end")?.[1] as (() => void) | undefined;
    const closeHandler = on.mock.calls.find(([event]) => event === "close")?.[1] as (() => void) | undefined;

    expect(endHandler).toBeTypeOf("function");
    expect(closeHandler).toBeTypeOf("function");
    expect(server.onclose).toBeTypeOf("function");
    expect(signalHandlers.has("SIGINT")).toBe(true);
    expect(signalHandlers.has("SIGTERM")).toBe(true);

    endHandler?.();
    server.onclose?.();
    closeHandler?.();
    signalHandlers.get("SIGINT")?.();

    await vi.runAllTimersAsync();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith("stdin end");
    restore();
  });
});

describe("handleCancelledNotification", () => {
  const killGroupMock = vi.mocked(killGroup);

  beforeEach(() => {
    jobStore.clearJobs();
    clearMap();
    killGroupMock.mockClear();
  });

  it("kills running subprocess and cancels job (issue #120)", () => {
    const jobId = "11111111-1111-1111-1111-111111111111";
    const requestId = 42;
    jobStore.createJob(jobId);
    const job = jobStore.getJob(jobId) as ReturnType<typeof jobStore.getJob> & {
      subprocess?: ChildProcess;
    };
    const mockSubprocess = { pid: 9999, kill: vi.fn() } as unknown as ChildProcess;
    job!.subprocess = mockSubprocess;
    registerRequest(requestId, jobId);

    handleCancelledNotification({ requestId });

    expect(killGroupMock).toHaveBeenCalledWith(mockSubprocess, "SIGTERM");
    expect(jobStore.getJob(jobId)?.status).toBe("cancelled");
    expect(getJobByRequestId(requestId)).toBeUndefined();
  });

  it("cancels job without calling killGroup when subprocess has not yet spawned", () => {
    const jobId = "22222222-2222-2222-2222-222222222222";
    const requestId = 43;
    jobStore.createJob(jobId);
    registerRequest(requestId, jobId);

    handleCancelledNotification({ requestId });

    expect(killGroupMock).not.toHaveBeenCalled();
    expect(jobStore.getJob(jobId)?.status).toBe("cancelled");
    expect(getJobByRequestId(requestId)).toBeUndefined();
  });

  it("is a no-op when job is already done", () => {
    const jobId = "33333333-3333-3333-3333-333333333333";
    const requestId = 44;
    jobStore.createJob(jobId);
    jobStore.completeJob(jobId, "response");
    registerRequest(requestId, jobId);

    handleCancelledNotification({ requestId });

    expect(killGroupMock).not.toHaveBeenCalled();
    expect(jobStore.getJob(jobId)?.status).toBe("done");
    expect(getJobByRequestId(requestId)).toBeUndefined();
  });

  it("ignores notification with no requestId", () => {
    handleCancelledNotification({});
    expect(killGroupMock).not.toHaveBeenCalled();
  });

  it("ignores notification when requestId has no registered job", () => {
    handleCancelledNotification({ requestId: 999 });
    expect(killGroupMock).not.toHaveBeenCalled();
  });
});

describe("startServer", () => {
  it("registers shutdown handlers before connect resolves", async () => {
    const signalHandlers = new Map<string, () => void>();
    const stdinListeners = new Map<string, () => void>();
    const processLike = {
      on: vi.fn((event: string, listener: () => void) => {
        signalHandlers.set(event, listener);
      }),
      exit: vi.fn(),
      stderr: { write: vi.fn(() => true) },
      stdin: {
        on: vi.fn((event: string, listener: () => void) => {
          stdinListeners.set(event, listener);
        }),
        off: vi.fn(),
      },
    } as any;
    const transport = { close: vi.fn().mockResolvedValue(undefined) } as any;
    const connectStarted = Promise.withResolvers<void>();
    const connectDone = Promise.withResolvers<void>();
    const server = {
      connect: vi.fn(async () => {
        connectStarted.resolve();
        await connectDone.promise;
      }),
    } as any;
    const shutdownPendingJobs = vi.fn().mockResolvedValue(undefined);
    const warmPool = null;

    const startPromise = startServer({
      server,
      transport,
      process: processLike,
      shutdownPendingJobs,
      warmPool,
    });

    await connectStarted.promise;

    expect(signalHandlers.has("SIGINT")).toBe(true);
    expect(signalHandlers.has("SIGTERM")).toBe(true);
    expect(stdinListeners.has("end")).toBe(true);
    expect(stdinListeners.has("close")).toBe(true);

    signalHandlers.get("SIGTERM")?.();
    await Promise.resolve();

    expect(shutdownPendingJobs).toHaveBeenCalledWith("Server shutting down", 2000);

    connectDone.resolve();
    await startPromise;
  });
});

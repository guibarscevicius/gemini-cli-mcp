import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

vi.mock("../src/dispatcher.js", () => ({
  handleCallTool: vi.fn(),
}));

import { handleCallTool } from "../src/dispatcher.js";
import { createServer, registerToolHandlers, setIdleStateTrackerForTests } from "../src/index.js";
import { _resetMcpLogger } from "../src/logging.js";
import { STATIC_RESOURCES, RESOURCE_TEMPLATES } from "../src/resources.js";
import { askGeminiToolDefinition } from "../src/tools/ask-gemini.js";
import { geminiReplyToolDefinition } from "../src/tools/gemini-reply.js";
import { geminiPollToolDefinition } from "../src/tools/gemini-poll.js";
import { geminiCancelToolDefinition } from "../src/tools/gemini-cancel.js";
import { geminiHealthToolDefinition } from "../src/tools/gemini-health.js";
import { geminiListSessionsToolDefinition } from "../src/tools/gemini-list-sessions.js";
import { geminiExportToolDefinition } from "../src/tools/gemini-export.js";
import { geminiBatchToolDefinition } from "../src/tools/gemini-batch.js";
import { geminiResearchToolDefinition } from "../src/tools/gemini-research.js";

type RequestHandler = (
  request: { params: Record<string, unknown> },
  extra?: unknown
) => Promise<unknown>;

const mockHandleCallTool = vi.mocked(handleCallTool);

describe("index wiring", () => {
  let handlers: Map<unknown, RequestHandler>;
  let tracker: {
    noteActivity: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    updateActiveJobs: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    handlers = new Map();
    vi.clearAllMocks();
    _resetMcpLogger();
    tracker = {
      noteActivity: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      updateActiveJobs: vi.fn(),
    };
    setIdleStateTrackerForTests(tracker);
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

  it("registers the list-tools handler with all nine tool definitions", async () => {
    const listTools = handlers.get(ListToolsRequestSchema);
    expect(listTools).toBeDefined();
    await expect(listTools!({ params: {} })).resolves.toEqual({
      tools: [
        askGeminiToolDefinition,
        geminiReplyToolDefinition,
        geminiPollToolDefinition,
        geminiCancelToolDefinition,
        geminiHealthToolDefinition,
        geminiListSessionsToolDefinition,
        geminiExportToolDefinition,
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
    expect(tracker.noteActivity).toHaveBeenCalledTimes(1);
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
    expect(tracker.noteActivity).toHaveBeenCalledTimes(1);
  });

  it("marks ListTools activity", async () => {
    const listTools = handlers.get(ListToolsRequestSchema);
    expect(listTools).toBeDefined();

    await listTools!({ params: {} });

    expect(tracker.noteActivity).toHaveBeenCalledTimes(1);
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
    expect(tracker.noteActivity).toHaveBeenCalled();
  });

  it("ListResourceTemplates handler returns RESOURCE_TEMPLATES", async () => {
    const server = createServer() as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
    };
    const handler = server._requestHandlers.get("resources/templates/list")!;
    const result = await handler({ method: "resources/templates/list", params: {} });
    expect(result).toEqual({ resourceTemplates: RESOURCE_TEMPLATES });
    expect(tracker.noteActivity).toHaveBeenCalled();
  });

  it("marks resource, prompt, and settings requests as activity", async () => {
    const server = createServer() as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
    };

    await server._requestHandlers.get("resources/list")!({
      method: "resources/list",
      params: {},
    });
    await server._requestHandlers.get("resources/templates/list")!({
      method: "resources/templates/list",
      params: {},
    });
    await server._requestHandlers.get("resources/read")!({
      method: "resources/read",
      params: { uri: STATIC_RESOURCES[0]?.uri },
    });
    await server._requestHandlers.get("prompts/list")!({
      method: "prompts/list",
      params: {},
    });
    await server._requestHandlers.get("prompts/get")!({
      method: "prompts/get",
      params: {
        name: "code-review",
        arguments: { files: "src/index.ts" },
      },
    });
    await server._requestHandlers.get("logging/setLevel")!({
      method: "logging/setLevel",
      params: { level: "info" },
    });

    expect(tracker.noteActivity).toHaveBeenCalledTimes(6);
  });
});

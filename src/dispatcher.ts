/**
 * Pure tool dispatcher — no server setup, safe to import in tests.
 *
 * Extracted from index.ts so that tests can exercise the dispatch logic
 * directly without triggering StdioServerTransport I/O setup.
 */
import { ZodError } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { askGemini } from "./tools/ask-gemini.js";
import { geminiReply } from "./tools/gemini-reply.js";
import { geminiPoll } from "./tools/gemini-poll.js";
import { geminiCancel } from "./tools/gemini-cancel.js";
import { geminiHealth } from "./tools/gemini-health.js";
import { geminiExport } from "./tools/gemini-export.js";

export interface ToolCallContext {
  /**
   * When both sendNotification and progressToken are provided, streaming chunks
   * are forwarded as notifications/progress events. Either alone is silently ignored.
   */
  sendNotification?: (n: unknown) => Promise<void>;
  progressToken?: string | number;
  /** MCP JSON-RPC request id. When provided, the handler registers a requestId->jobId
   *  mapping so notifications/cancelled can abort the right subprocess. The fire-and-forget
   *  chain (or GC sweep) owns cleanup via unregisterRequest / unregisterByJobId. */
  requestId?: string | number;
}

export type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: true;
};

/**
 * Dispatch a CallTool request to the appropriate handler.
 *
 * Error contract:
 *   - Unknown tool name        → throws McpError(MethodNotFound)
 *   - Invalid input (Zod)      → throws McpError(InvalidParams) with field-level detail
 *   - McpError from handler    → re-thrown as-is
 *   - Any other Error          → returned as isError response + logged to stderr
 */
export async function handleCallTool(
  name: string,
  args: unknown,
  ctx: ToolCallContext = {}
): Promise<ToolResponse> {
  try {
    switch (name) {
      case "ask-gemini": {
        const result = await askGemini(args, ctx);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }

      case "gemini-reply": {
        const result = await geminiReply(args, ctx);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }

      case "gemini-poll": {
        const result = await geminiPoll(args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }

      case "gemini-cancel": {
        const result = await geminiCancel(args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }

      case "gemini-health": {
        const result = await geminiHealth(args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }

      case "gemini-export": {
        const result = await geminiExport(args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (err) {
    // Protocol-level errors: re-throw so the MCP SDK encodes them as JSON-RPC errors.
    // If caught here, the ErrorCode is discarded and the host receives an opaque isError
    // content response - breaking clients that branch on error codes.
    if (err instanceof McpError) throw err;

    // Input validation failure: surface field-level details as a protocol error
    // rather than an opaque isError response, so hosts can distinguish bad input
    // from runtime failures.
    if (err instanceof ZodError) {
      const detail = err.errors
        .map((e) => `${e.path.join(".") || "input"}: ${e.message}`)
        .join("; ");
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments: ${detail}`);
    }

    // Unexpected runtime error — log to stderr for debugging, return as tool error
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? `\n${err.stack}` : "";
    process.stderr.write(
      `[gemini-cli-mcp] Unexpected error in tool "${name}": ${message}${stack}\n`
    );
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

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

export type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
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
  args: unknown
): Promise<ToolResponse> {
  try {
    switch (name) {
      case "ask-gemini": {
        const result = await askGemini(args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "gemini-reply": {
        const result = await geminiReply(args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (err) {
    // Protocol-level errors: re-throw so the MCP SDK can encode them correctly
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
    process.stderr.write(
      `[gemini-cli-mcp] Unexpected error in tool "${name}": ${message}\n`
    );
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

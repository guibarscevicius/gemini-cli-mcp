import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Timeout for a single Gemini subprocess call
const TIMEOUT_MS = 60_000;

export interface GeminiOptions {
  model?: string;
  cwd?: string;
}

/** Injectable executor type — override in tests to avoid spawning a real subprocess. */
export type GeminiExecutor = (
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string; timeout: number; maxBuffer: number }
) => Promise<{ stdout: string }>;

const defaultExecutor: GeminiExecutor = (args, opts) =>
  execFileAsync("gemini", args, opts) as Promise<{ stdout: string }>;

/**
 * Runs `gemini` as a subprocess with no shell interpolation.
 *
 * Security properties (mitigates CVE-2026-0755-class command injection):
 *  - execFile() passes args directly to execve() — no shell, no metacharacter risk
 *  - args array is built programmatically, never string-concatenated
 *  - env is restricted to HOME + PATH only
 *  - --yolo auto-approves Gemini's own tool use (prevents hanging in non-interactive mode)
 *  - --output-format json gives structured, parseable output
 */
export async function runGemini(
  prompt: string,
  opts: GeminiOptions = {},
  executor: GeminiExecutor = defaultExecutor
): Promise<string> {
  const args: string[] = [
    "--yolo",
    "--output-format",
    "json",
    "--prompt",
    prompt,
  ];

  if (opts.model) {
    args.push("--model", opts.model);
  }

  let stdout: string;
  try {
    const result = await executor(args, {
      // Restrict inherited environment to only what Gemini CLI needs for auth
      env: {
        HOME: process.env.HOME ?? "",
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      },
      cwd: opts.cwd, // undefined = MCP server CWD; set to enable relative @file paths
      timeout: TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10 MB — generous for large responses
    });
    stdout = result.stdout;
  } catch (err: unknown) {
    // execFile throws on non-zero exit; include stderr in message if available
    const execErr = err as { stderr?: string; message?: string };
    const detail = execErr.stderr?.trim() || execErr.message || String(err);
    throw new Error(`gemini process failed: ${detail}`);
  }

  return parseGeminiOutput(stdout);
}

export interface GeminiJsonOutput {
  // The Gemini CLI --output-format json shape (verified empirically).
  // Field names may differ across CLI versions — the fallback chain handles this.
  response?: string;
  text?: string;
  content?: string;
  error?: string;
  // Unused stats fields omitted
}

/**
 * Exported for unit testing. Parse the raw JSON stdout from `gemini --output-format json`.
 * Throws descriptive errors for all failure modes so callers can diagnose issues.
 */
export function parseGeminiOutput(raw: string): string {
  let parsed: GeminiJsonOutput;
  try {
    parsed = JSON.parse(raw) as GeminiJsonOutput;
  } catch {
    // If JSON parse fails, the raw stdout shape is unknown — surface it clearly
    // so the caller (and developer) can see it and update field names.
    throw new Error(
      `gemini returned non-JSON output. Raw stdout:\n${raw.slice(0, 2000)}`
    );
  }

  if (parsed.error) {
    throw new Error(`gemini error: ${parsed.error}`);
  }

  // Try known field names in priority order
  const text = parsed.response ?? parsed.text ?? parsed.content;
  if (typeof text === "string") {
    return text;
  }

  // Unknown shape — dump it so the developer can add the correct field name
  throw new Error(
    `gemini JSON output has unexpected shape. Parsed object:\n${JSON.stringify(parsed, null, 2)}`
  );
}

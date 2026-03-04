import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// 60 s - generous for large file analysis; increase if prompts regularly time out
const TIMEOUT_MS = 60_000;

export interface GeminiOptions {
  model?: string;
  cwd?: string;
}

/** Injectable executor type — override in tests to avoid spawning a real subprocess. */
export type GeminiExecutor = (
  args: string[],
  opts: { env: Record<string, string>; cwd?: string; timeout: number; maxBuffer: number }
) => Promise<{ stdout: string }>;

const defaultExecutor: GeminiExecutor = (args, opts) =>
  execFileAsync("gemini", args, opts) as Promise<{ stdout: string }>;

/**
 * Runs `gemini` as a subprocess with no shell interpolation.
 *
 * Security properties (mitigates CVE-2026-0755-class command injection):
 *  - execFile() passes args directly to execve() — no shell, no metacharacter risk
 *  - args array is built programmatically, never string-concatenated
 *  - env is restricted to HOME and PATH only; all other inherited env vars
 *    (API keys, tokens, secrets) are stripped. Note: HOME is required for
 *    Gemini CLI OAuth credential access (~/.config/gemini); it is not a
 *    sandbox boundary.
 *  - --yolo auto-approves Gemini's own tool use (prevents hanging in non-interactive mode)
 *  - --output-format json gives structured, parseable output
 */
export async function runGemini(
  prompt: string,
  opts: GeminiOptions = {},
  executor: GeminiExecutor = defaultExecutor
): Promise<string> {
  const homeDir = process.env.HOME;
  if (!homeDir) {
    throw new Error(
      "HOME environment variable is not set. " +
        "The Gemini CLI requires HOME to locate OAuth credentials (~/.config/gemini)."
    );
  }

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
        HOME: homeDir,
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      },
      cwd: opts.cwd, // undefined = MCP server CWD; set to enable relative @file paths
      timeout: TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10 MB — generous for large responses
    });
    stdout = result.stdout;
  } catch (err: unknown) {
    // execFile throws on non-zero exit; include stderr in message if available
    const execErr = err as { code?: string; stderr?: string; message?: string };
    const detail = execErr.stderr?.trim() || execErr.message || String(err);
    if (execErr.code === "ENOENT") {
      throw new Error(
        "gemini binary not found. Is the Gemini CLI installed and on PATH?",
        { cause: err }
      );
    }
    // Gemini CLI emits "Path not in workspace" for workspace boundary violations.
    // If this hint stops appearing, check whether the CLI error wording has changed.
    const workspaceHint = detail.includes("Path not in workspace")
      ? " — pass cwd pointing to the project root containing your @file targets"
      : "";
    throw new Error(`gemini process failed: ${detail}${workspaceHint}`, { cause: err });
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // If JSON parse fails, the raw stdout shape is unknown — surface it clearly
    // so the caller (and developer) can see it and update field names.
    throw new Error(
      `gemini returned non-JSON output. Raw stdout:\n${raw.slice(0, 2000)}`
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `gemini process returned unexpected JSON shape (${typeof parsed}): ${raw.slice(0, 200)}`
    );
  }

  const output = parsed as GeminiJsonOutput;

  if (output.error) {
    // Gemini CLI emits "Path not in workspace" for workspace boundary violations.
    // If this hint stops appearing, check whether the CLI error wording has changed.
    const workspaceHint = output.error.includes("Path not in workspace")
      ? " — pass cwd pointing to the project root containing your @file targets"
      : "";
    throw new Error(`gemini error: ${output.error}${workspaceHint}`);
  }

  // Try known field names in priority order
  const text = output.response ?? output.text ?? output.content;
  if (typeof text === "string") {
    return text;
  }

  // Unknown shape — dump it so the developer can add the correct field name
  throw new Error(
    `gemini JSON output has unexpected shape. Parsed object:\n${JSON.stringify(output, null, 2)}`
  );
}

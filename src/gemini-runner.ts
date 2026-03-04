import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { glob } from "glob";

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
 * Matches @file tokens where @ is preceded by whitespace or start of string.
 * Requires the path portion to contain at least one `/` or `.` character —
 * this excludes bare @mentions and most email addresses.
 * Trailing sentence punctuation (,;:!?)] is excluded from the path capture.
 *
 * Capture group: [1] = path after @.
 */
const FILE_REF_RE = /(?:^|(?<=\s))@([^\s@,;:!?)\]]*[/.][^\s@,;:!?)\]]*)/g;

/** Count the number of @file tokens in a prompt. */
function countFileRefs(prompt: string): number {
  return [...prompt.matchAll(FILE_REF_RE)].length;
}

/**
 * Expand 2+ @file tokens in a prompt by reading the files and appending a
 * REFERENCE block. Single @file tokens are left untouched so the CLI handles
 * them natively (workspace boundary enforcement, etc.).
 *
 * The original @token text is preserved in the prompt; file contents are
 * appended in a `[REFERENCE_CONTENT_START] ... [REFERENCE_CONTENT_END]` block
 * and are NOT inlined at the token position.
 *
 * Throws if any referenced file is not found, is a directory, or resolves
 * (following symlinks) to a path outside `cwd`.
 */
export async function expandFileRefs(prompt: string, cwd: string): Promise<string> {
  const matches = [...prompt.matchAll(FILE_REF_RE)];
  if (matches.length < 2) return prompt;

  const cwdResolved = nodePath.resolve(cwd);
  let realCwd: string;
  try {
    realCwd = await realpath(cwdResolved);
  } catch (err) {
    throw new Error(`cwd does not exist or is not accessible: ${cwdResolved}`, { cause: err });
  }

  const sections: string[] = [];

  for (const match of matches) {
    const rawPath = match[1]; // capture group 1 is the path after @

    let filePaths: string[];
    if (/[*?{]/.test(rawPath)) {
      try {
        filePaths = await glob(rawPath, { cwd: realCwd, absolute: true, nodir: true });
      } catch (err) {
        throw new Error(
          `Failed to expand glob pattern @${rawPath} in ${realCwd}: ${(err as Error).message}`,
          { cause: err }
        );
      }
      if (filePaths.length === 0) {
        throw new Error(`File not found: @${rawPath} — no files matched in ${realCwd}`);
      }
    } else {
      filePaths = [nodePath.resolve(realCwd, rawPath)];
    }

    for (const absPath of filePaths) {
      // realpath() follows symlinks — prevents a symlink inside cwd from escaping the workspace
      let realAbsPath: string;
      try {
        realAbsPath = await realpath(absPath);
      } catch (err) {
        const code = (err as { code?: string }).code;
        const detail = code === "EACCES" ? "permission denied" : "does not exist";
        throw new Error(`File not found: @${rawPath} — ${absPath} ${detail}`, { cause: err });
      }

      if (!realAbsPath.startsWith(realCwd + nodePath.sep) && realAbsPath !== realCwd) {
        throw new Error(
          `Path not in workspace: @${rawPath} resolves to ${realAbsPath} which is outside ${realCwd}`
        );
      }

      const readErrorDetails: Record<string, string> = {
        EISDIR: "is a directory — use a glob pattern like @src/**/*.ts",
        EACCES: "permission denied",
      };
      let content: string;
      try {
        content = await readFile(realAbsPath, "utf-8");
      } catch (err) {
        const code = (err as { code?: string }).code ?? "unknown";
        const detail = readErrorDetails[code] ?? `read failed (${code})`;
        throw new Error(`Cannot read @${rawPath} — ${absPath} ${detail}`, { cause: err });
      }

      const relPath = nodePath.relative(realCwd, realAbsPath);
      sections.push(`Content from @${relPath}:\n${content}`);
    }
  }

  // Sentinel delimiters give the model a clear boundary for injected content.
  // The "Content from @<relPath>:" header preserves the original @token reference.
  const referenceBlock = `\n\n[REFERENCE_CONTENT_START]\n${sections.join("\n\n")}\n[REFERENCE_CONTENT_END]`;
  return prompt + referenceBlock;
}

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

  // Guard: multiple @file tokens need cwd to resolve paths
  if (!opts.cwd && countFileRefs(prompt) >= 2) {
    throw new Error(
      "Multiple @file tokens require the cwd option — pass the project root directory."
    );
  }

  // Expand multiple @file references ourselves; single @file still goes through CLI
  const expandedPrompt = opts.cwd
    ? await expandFileRefs(prompt, opts.cwd)
    : prompt;

  const args: string[] = [
    "--yolo",
    "--output-format",
    "json",
    "--prompt",
    expandedPrompt,
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
      // Sets subprocess working directory. For single @file prompts the CLI resolves
      // the path relative to this; for 2+ @file prompts expandFileRefs() has already
      // inlined the content above, so the CLI no longer needs to resolve @file itself.
      cwd: opts.cwd,
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

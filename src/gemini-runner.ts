import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { escape as escapeGlob, glob } from "glob";

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
 * Two-phase @file extraction (greedy regex → balanced-delimiter state machine).
 *
 * Phase 1 — GREEDY_AT_RE: captures everything after `@` up to whitespace, `@`,
 * `,`, or `;`. Intentionally over-captures so that paths containing `()` and
 * `[]` (Next.js route groups, dynamic segments, SvelteKit params) are not
 * truncated by the regex.
 *
 * Phase 2 — extractBalancedPath(): walks the captured token tracking `()` and
 * `[]` depth. Unmatched trailing `)` or `]` at depth 0 are stripped as
 * punctuation. Trailing `:!?` are also stripped.
 *
 * This mirrors the CommonMark spec's approach for parsing URLs with balanced
 * parentheses.
 */
const GREEDY_AT_RE = /(?:^|(?<=\s))@([^\s@,;]+)/g;

/**
 * Strip unmatched trailing `)` / `]` and trailing punctuation from a
 * greedily-captured @file token.
 *
 * Walks left-to-right tracking depth for `()` and `[]` pairs. At the end,
 * trims any trailing characters that are unmatched closers or sentence
 * punctuation (`:!?`).
 */
function extractBalancedPath(raw: string): string {
  let parenDepth = 0;
  let bracketDepth = 0;
  let end = raw.length;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") {
      if (parenDepth > 0) parenDepth--;
      // else: unmatched — will be trimmed from the end
    } else if (ch === "[") bracketDepth++;
    else if (ch === "]") {
      if (bracketDepth > 0) bracketDepth--;
    }
  }

  // Trim unmatched trailing closers and punctuation from the right
  while (end > 0) {
    const ch = raw[end - 1];
    if (ch === ")" && parenDepth <= 0) {
      // Count unmatched closing parens remaining in suffix
      let unmatchedClose = 0;
      let d = 0;
      for (let i = 0; i < end; i++) {
        if (raw[i] === "(") d++;
        else if (raw[i] === ")") {
          if (d > 0) d--;
          else unmatchedClose++;
        }
      }
      if (unmatchedClose > 0) { end--; continue; }
      break;
    }
    if (ch === "]" && bracketDepth <= 0) {
      let unmatchedClose = 0;
      let d = 0;
      for (let i = 0; i < end; i++) {
        if (raw[i] === "[") d++;
        else if (raw[i] === "]") {
          if (d > 0) d--;
          else unmatchedClose++;
        }
      }
      if (unmatchedClose > 0) { end--; continue; }
      break;
    }
    if (":!?".includes(ch)) { end--; continue; }
    break;
  }

  return raw.slice(0, end);
}

/** Result from extracting a single @file reference. */
interface FileRef {
  path: string;
  index: number;
}

/**
 * Extract @file references from a prompt using the two-phase approach.
 * Returns only tokens whose path contains at least one `/` or `.` — this
 * rejects bare @mentions (e.g. @alice) and most email-like patterns.
 */
function extractFileRefs(text: string): FileRef[] {
  const refs: FileRef[] = [];
  // Reset lastIndex for global regex
  GREEDY_AT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GREEDY_AT_RE.exec(text)) !== null) {
    const balanced = extractBalancedPath(match[1]);
    if (/[/.]/.test(balanced)) {
      refs.push({ path: balanced, index: match.index });
    }
  }
  return refs;
}

/** Count the number of @file tokens in a prompt. */
function countFileRefs(prompt: string): number {
  return extractFileRefs(prompt).length;
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

/**
 * Escape `[]` in path segments that are not glob wildcards, so that literal
 * directory names like `[slug]` are not interpreted as glob character classes.
 *
 * Splits the path on `/`, and for each segment that does NOT contain `*`, `?`,
 * or `{`, escapes it with `glob.escape()`. Segments that contain wildcards are
 * left untouched so the glob engine can interpret them.
 */
function escapeGlobSegments(rawPath: string): string {
  return rawPath
    .split("/")
    .map((seg) => (/[*?{]/.test(seg) ? seg : escapeGlob(seg)))
    .join("/");
}

export async function expandFileRefs(prompt: string, cwd: string): Promise<string> {
  const refs = extractFileRefs(prompt);
  if (refs.length < 2) return prompt;

  const cwdResolved = nodePath.resolve(cwd);
  let realCwd: string;
  try {
    realCwd = await realpath(cwdResolved);
  } catch (err) {
    throw new Error(`cwd does not exist or is not accessible: ${cwdResolved}`, { cause: err });
  }

  const sections: string[] = [];

  for (const ref of refs) {
    const rawPath = ref.path;

    let filePaths: string[];
    if (/[*?{]/.test(rawPath)) {
      try {
        filePaths = await glob(escapeGlobSegments(rawPath), { cwd: realCwd, absolute: true, nodir: true });
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

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { escape as escapeGlob, glob } from "glob";

export class GeminiOutputError extends Error {
  constructor(message: string, public sanitizedMessage: string) {
    super(message);
    this.name = "GeminiOutputError";
  }
}

// 300 s - allows Gemini 2.5 Pro deep-reasoning tasks (can take 2–3 min before first token)
const TIMEOUT_MS = 300_000;

// Linux MAX_ARG_STRLEN = PAGE_SIZE × 32 = 131,072 bytes (~128 KB) caps any single exec arg.
// Prompts larger than this threshold are written to a temp file and referenced via @path
// so the CLI reads from disk, completely bypassing the per-argument kernel limit.
const LARGE_PROMPT_THRESHOLD = 110 * 1024; // 110 KB — 15% below the ~127 KB measured ceiling

class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private readonly max: number) {}

  acquire(timeoutMs?: number): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const slot = () => {
        if (timer) clearTimeout(timer);
        this.running++;
        resolve();
      };

      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const index = this.queue.indexOf(slot);
          if (index !== -1) {
            this.queue.splice(index, 1);
            reject(
              new Error(
                `Gemini request timed out after ${timeoutMs}ms waiting for concurrency slot`
              )
            );
          }
        }, timeoutMs);
      }

      this.queue.push(slot);
    });
  }

  release(): void {
    if (this.running <= 0) return; // defensive: should never be called without a matching acquire
    this.running--;
    this.queue.shift()?.();
  }
}

const MAX_CONCURRENT = parseInt(process.env.GEMINI_MAX_CONCURRENT ?? "2", 10);
if (!Number.isFinite(MAX_CONCURRENT) || MAX_CONCURRENT < 1) {
  throw new Error(
    `GEMINI_MAX_CONCURRENT must be a positive integer, got "${process.env.GEMINI_MAX_CONCURRENT}". ` +
      "Use 1 for strict serialization or omit to use the default (2)."
  );
}
const QUEUE_TIMEOUT_MS = parseInt(process.env.GEMINI_QUEUE_TIMEOUT_MS ?? "60000", 10);
const semaphore = new Semaphore(MAX_CONCURRENT);

const MAX_RETRIES = parseInt(process.env.GEMINI_MAX_RETRIES ?? "3", 10);
const RETRY_BASE_MS = parseInt(process.env.GEMINI_RETRY_BASE_MS ?? "1000", 10);

const CACHE_TTL_MS = Math.trunc(Number(process.env.GEMINI_CACHE_TTL_MS ?? "300000"));
if (CACHE_TTL_MS < 0 || !Number.isFinite(CACHE_TTL_MS)) {
  throw new Error("GEMINI_CACHE_TTL_MS must be a non-negative integer (0 = disabled)");
}
const CACHE_MAX_ENTRIES = Math.trunc(Number(process.env.GEMINI_CACHE_MAX_ENTRIES ?? "50"));
if (CACHE_MAX_ENTRIES < 1 || !Number.isFinite(CACHE_MAX_ENTRIES)) {
  throw new Error("GEMINI_CACHE_MAX_ENTRIES must be a positive integer");
}

interface CacheEntry { response: string; expiresAt: number; }
const cache = new Map<string, CacheEntry>();

/** @internal Clears all cached entries. Exposed for test isolation only — not part of the public API. */
export function clearCache(): void {
  cache.clear();
}

function cacheKey(prompt: string, opts: GeminiOptions): string {
  return createHash("sha256")
    .update(JSON.stringify({ prompt, model: opts.model ?? "", cwd: opts.cwd ?? "" }))
    .digest("hex");
}

function isRetryable(err: unknown): boolean {
  // GeminiOutputError covers all parse failures (non-JSON, unexpected shape, etc.).
  // Check by name as well as instanceof to support cross-module-reset scenarios in tests
  // where vi.resetModules() produces a fresh class identity.
  if (err instanceof GeminiOutputError) return true;
  if (err instanceof Error && err.name === "GeminiOutputError") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("429") || msg.includes("ETIMEDOUT");
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number
): Promise<{ result: T; retryCount: number }> {
  let retryCount = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return { result: await fn(), retryCount };
    } catch (err) {
      if (attempt === maxAttempts || !isRetryable(err)) {
        if (err && typeof err === "object") {
          (err as { retryCount?: number }).retryCount = retryCount;
        }
        throw err;
      }
      retryCount++;
      const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1) + Math.random() * 500, 10_000);
      process.stderr.write(
        `[gemini-runner] retry ${attempt + 1}/${maxAttempts} after ${Math.round(delay)}ms (${(err as Error).message.slice(0, 60)})\n`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error("unreachable");
}

export interface GeminiOptions {
  model?: string;
  cwd?: string;
  tool?: string;
  sessionId?: string;
}

/** Injectable executor type — override in tests to avoid spawning a real subprocess. */
export type GeminiExecutor = (
  args: string[],
  opts: { env: Record<string, string>; cwd?: string; timeout: number; maxBuffer: number },
  onChunk?: (text: string) => void
) => Promise<{ stdout: string }>;

/**
 * Spawn `gemini` with `--output-format stream-json` and parse NDJSON events.
 *
 * Parses `message` events (role=assistant, delta=true) into chunks, waits for
 * a `result` event to signal completion, and handles error/process-level failures.
 * Returns a `ChildProcess` so callers can store it for cancellation.
 */
export function spawnGemini(
  args: string[],
  spawnOpts: { env: Record<string, string>; cwd?: string; timeout: number },
  onChunk: (text: string) => void,
  onDone: (fullText: string) => void,
  onError: (err: Error) => void
): ChildProcess {
  const cp = spawn("gemini", args, {
    env: spawnOpts.env,
    cwd: spawnOpts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Close stdin immediately — Gemini CLI reads from --prompt, not stdin
  cp.stdin?.end();

  let accumulated = "";
  let lineBuffer = "";
  let settled = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    fn();
  };

  timeoutHandle = setTimeout(() => {
    cp.kill("SIGTERM");
    settle(() =>
      onError(new Error(`Gemini subprocess timed out after ${spawnOpts.timeout}ms`))
    );
  }, spawnOpts.timeout);

  cp.stdout?.on("data", (data: Buffer) => {
    lineBuffer += data.toString("utf8");
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";

    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed) continue;

      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        // Non-JSON line (debug output etc.) — skip
        continue;
      }

      type StreamEvent = {
        type?: string;
        role?: string;
        content?: string;
        delta?: boolean;
        status?: string;
        error?: unknown;
        message?: string;
      };
      const e = event as StreamEvent;

      if (e.type === "message" && e.role === "assistant" && typeof e.content === "string") {
        accumulated += e.content;
        onChunk(e.content);
      } else if (e.type === "result") {
        if (e.status === "success") {
          settle(() => onDone(accumulated));
        } else {
          // status === "error"
          const errDetail =
            typeof e.error === "string"
              ? e.error
              : typeof e.message === "string"
                ? e.message
                : "gemini result error";
          settle(() => onError(new GeminiOutputError(errDetail, errDetail)));
        }
      } else if (e.type === "error") {
        const errDetail = typeof e.message === "string" ? e.message : "gemini error event";
        settle(() => onError(new GeminiOutputError(errDetail, errDetail)));
      }
    }
  });

  // Drain stderr to prevent the subprocess from blocking on a full pipe
  cp.stderr?.on("data", () => {});

  cp.on("error", (err) => {
    const detail = err.message;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      settle(() =>
        onError(
          new Error("gemini binary not found. Is the Gemini CLI installed and on PATH?", {
            cause: err,
          })
        )
      );
    } else {
      settle(() =>
        onError(new Error(`gemini process error: ${detail}`, { cause: err }))
      );
    }
  });

  cp.on("close", (code) => {
    if (settled) return;
    if (code === 0) {
      // No result event received — treat accumulated as the response
      settle(() => onDone(accumulated));
    } else {
      settle(() =>
        onError(
          new GeminiOutputError(
            `gemini process exited with code ${code}`,
            `gemini process exited with code ${code}`
          )
        )
      );
    }
  });

  return cp;
}

const defaultExecutor: GeminiExecutor = (args, opts, onChunk) =>
  new Promise<{ stdout: string }>((resolve, reject) => {
    spawnGemini(
      args,
      { env: opts.env, cwd: opts.cwd, timeout: opts.timeout },
      onChunk ?? (() => {}),
      (fullText) => resolve({ stdout: fullText }),
      reject
    );
  });

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
 * Inspired by CommonMark's balanced-parenthesis counting for link destinations
 * (spec §6.7), but extended to handle `[]` and to trim (rather than reject)
 * unmatched trailing closers.
 */
const GREEDY_AT_RE = /(?:^|(?<=\s))@([^\s@,;]+)/g;

/**
 * Strip unmatched trailing `)` / `]` and trailing punctuation from a
 * greedily-captured @file token.
 *
 * For each trailing `)` or `]`, re-scans `raw[0..end)` to check whether it
 * has a matching opener. Unmatched trailing closers and trailing `:!?` are
 * trimmed. Inspired by CommonMark's balanced-parenthesis counting for link
 * destinations (spec §6.7), but extended to handle `[]` and to trim (rather
 * than reject) unmatched trailing closers.
 */
function extractBalancedPath(raw: string): string {
  let end = raw.length;

  // Trim unmatched trailing closers and punctuation from the right
  while (end > 0) {
    const ch = raw[end - 1];
    if (ch === ")" || ch === "]") {
      const open = ch === ")" ? "(" : "[";
      let depth = 0;
      for (let i = 0; i < end; i++) {
        if (raw[i] === open) depth++;
        else if (raw[i] === ch) depth--;
      }
      // depth < 0 means more closers than openers — trailing one is unmatched
      if (depth < 0) { end--; continue; }
      break;
    }
    if (".:!?".includes(ch)) { end--; continue; }
    break;
  }

  return raw.slice(0, end);
}

/**
 * Extract @file references from a prompt using the two-phase approach.
 * Returns only tokens whose path contains at least one `/` or `.` — this
 * rejects bare @mentions (e.g. @alice) and most email-like patterns.
 */
function extractFileRefs(text: string): string[] {
  const paths: string[] = [];
  // Reset lastIndex for global regex
  GREEDY_AT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GREEDY_AT_RE.exec(text)) !== null) {
    const balanced = extractBalancedPath(match[1]);
    if (/[/.]/.test(balanced)) {
      paths.push(balanced);
    }
  }
  return paths;
}

/** Count the number of @file tokens in a prompt. */
function countFileRefs(prompt: string): number {
  return extractFileRefs(prompt).length;
}

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

/**
 * Expand 2+ @file tokens in a prompt by reading the files and appending a
 * REFERENCE block. Single @file tokens are left untouched so the CLI handles
 * them natively (workspace boundary enforcement, etc.).
 *
 * @tokens in the prompt are masked (@ stripped) after expansion to prevent the
 * Gemini CLI from re-expanding them; file contents are appended in a
 * `[REFERENCE_CONTENT_START] ... [REFERENCE_CONTENT_END]` block and are NOT
 * inlined at the token position.
 *
 * Throws if any referenced file is not found, is a directory, or resolves
 * (following symlinks) to a path outside `cwd`.
 */
export async function expandFileRefs(prompt: string, cwd: string): Promise<string> {
  const fileRefs = extractFileRefs(prompt);
  if (fileRefs.length < 2) return prompt;

  const cwdResolved = nodePath.resolve(cwd);
  let realCwd: string;
  try {
    realCwd = await realpath(cwdResolved);
  } catch (err) {
    throw new Error(`cwd does not exist or is not accessible: ${cwdResolved}`, { cause: err });
  }

  const sections: string[] = [];

  for (const rawPath of fileRefs) {

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

  // Mask @tokens in the prompt text to prevent double expansion by the CLI
  // We use a replacement function with the same regex to ensure consistency.
  GREEDY_AT_RE.lastIndex = 0;
  const maskedPrompt = prompt.replace(GREEDY_AT_RE, (match, pathToken) => {
    const balanced = extractBalancedPath(pathToken);
    if (/[/.]/.test(balanced)) {
      // Replace the matched token (including @) with just the balanced path.
      // We keep the rest of the original token if any (punctuation that was trimmed).
      return match.replace(`@${balanced}`, balanced);
    }
    return match;
  });

  // Sentinel delimiters give the model a clear boundary for injected content.
  // The "Content from @<relPath>:" header preserves the original @token reference.
  const referenceBlock = `\n\n[REFERENCE_CONTENT_START]\n${sections.join("\n\n")}\n[REFERENCE_CONTENT_END]`;
  return maskedPrompt + referenceBlock;
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
  executor: GeminiExecutor = defaultExecutor,
  onChunk?: (text: string) => void
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
  let expandedPrompt = prompt;
  if (opts.cwd) {
    expandedPrompt = await expandFileRefs(prompt, opts.cwd);
  }

  // Cache check: stateless ask-gemini calls only (sessions are never cached).
  // Note: single-@file prompts use the file path (not content) in the key — if the
  // file changes, a stale response may be served until TTL expires.
  const isCacheable = CACHE_TTL_MS > 0 && !opts.sessionId;
  // Compute key once here and reuse at the store site — avoids a second SHA-256
  // over a potentially large expandedPrompt.
  const key = isCacheable ? cacheKey(expandedPrompt, opts) : "";
  if (isCacheable) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.response;
    }
  }

  const args: string[] = [
    "--yolo",
    "--output-format",
    "stream-json",
  ];

  if (opts.model) {
    args.push("--model", opts.model);
  }

  // Large-prompt bypass: Linux MAX_ARG_STRLEN (~128 KB) caps any single exec argument.
  // Prompts above the threshold are written to a temp file and passed as @<path> so the
  // CLI reads from disk — completely bypasses the per-argument kernel limit.
  let tempPromptFile: string | null = null;
  const bypassUsed = expandedPrompt.length > LARGE_PROMPT_THRESHOLD;
  if (bypassUsed) {
    tempPromptFile = nodePath.join(
      os.tmpdir(),
      `gemini-prompt-${randomUUID()}.txt`
    );
    // mode 0o600: restrict to owner only — the expanded prompt can contain
    // sensitive source code that must not be world-readable in /tmp.
    await writeFile(tempPromptFile, expandedPrompt, { encoding: "utf8", mode: 0o600 });
    // --include-directories lets the CLI read outside the project workspace (/tmp is
    // outside any project cwd, so the workspace boundary check would otherwise reject it).
    // This grants the CLI access to all files under os.tmpdir(), not just the prompt
    // file. This is acceptable because expandFileRefs() has already inlined or rejected
    // every @file reference — the CLI will not encounter further @-refs to resolve.
    args.push(
      "--include-directories",
      os.tmpdir(),
      "--prompt",
      `@${tempPromptFile}`
    );
  } else {
    args.push("--prompt", expandedPrompt);
  }

  let acquired = false;
  try {
    await semaphore.acquire(QUEUE_TIMEOUT_MS);
    acquired = true;
    const startTime = Date.now();

    let response: string;
    let retryCount = 0;

    try {
      ({ result: response, retryCount } = await withRetry(async () => {
        let stdout: string;
        try {
          const result = await executor(
            args,
            {
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
              maxBuffer: 100 * 1024 * 1024, // 100 MB — large code-analysis responses can exceed 10 MB
            },
            onChunk
          );
          stdout = result.stdout;
        } catch (err: unknown) {
          // GeminiOutputError (from spawnGemini's NDJSON parser or test mocks): re-throw as-is.
          if (err instanceof GeminiOutputError) throw err;

          const execErr = err as { code?: string; stderr?: string; message?: string };

          // ENOENT: gemini binary not on PATH.
          if (execErr.code === "ENOENT") {
            throw new Error(
              "gemini binary not found. Is the Gemini CLI installed and on PATH?",
              { cause: err }
            );
          }

          // Errors with a `stderr` property are old-style execFile errors (or test mocks).
          // Errors from spawnGemini are already properly formatted Error instances without `stderr`.
          // Re-wrap if `stderr` present; otherwise pass through.
          if (execErr.stderr !== undefined) {
            const detail = execErr.stderr.trim() || execErr.message || String(err);
            const workspaceHint = detail.includes("Path not in workspace")
              ? " — pass cwd pointing to the project root containing your @file targets"
              : "";
            throw new Error(`gemini process failed: ${detail}${workspaceHint}`, { cause: err });
          }

          // Already-formatted errors from spawnGemini or other sources: re-throw.
          throw err;
        }

        // executor returns accumulated response text directly (parsed from stream-json)
        return stdout;
      }, MAX_RETRIES > 0 ? MAX_RETRIES + 1 : 1));
    } catch (err) {
      const homeDir = process.env.HOME ?? "";
      let telemetryError: string;
      if (err instanceof GeminiOutputError) {
        telemetryError = err.sanitizedMessage;
      } else if (err instanceof Error) {
        telemetryError = err.message;
      } else {
        telemetryError = String(err);
      }

      // Sanitize telemetry: replace absolute home path with ~ to avoid leaking username.
      // Use split/join instead of new RegExp(homeDir) — homeDir may contain regex
      // metacharacters (e.g. /home/user.name) that would corrupt the pattern.
      if (homeDir) {
        telemetryError = telemetryError.split(homeDir).join("~");
      }

      const retryCountFromError =
        typeof (err as { retryCount?: unknown }).retryCount === "number"
          ? ((err as { retryCount: number }).retryCount ?? retryCount)
          : retryCount;


      if (process.env.GEMINI_STRUCTURED_LOGS === "1") {
        process.stderr.write(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: "gemini_request",
            tool: opts.tool ?? null,
            model: opts.model ?? "default",
            promptBytes: expandedPrompt.length,
            responseBytes: 0,
            durationMs: Date.now() - startTime,
            sessionId: opts.sessionId ?? null,
            bypassUsed,
            retryCount: retryCountFromError,
            status: "error",
            error: telemetryError,
          }) + "\n"
        );
      }

      throw err;
    }

    if (process.env.GEMINI_STRUCTURED_LOGS === "1") {
      process.stderr.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "gemini_request",
          tool: opts.tool ?? null,
          model: opts.model ?? "default",
          promptBytes: expandedPrompt.length,
          responseBytes: response.length,
          durationMs: Date.now() - startTime,
          sessionId: opts.sessionId ?? null,
          bypassUsed,
          retryCount,
          status: "ok",
          error: null,
        }) + "\n"
      );
    }

    // Store result in cache before returning
    if (isCacheable) {
      if (cache.size >= CACHE_MAX_ENTRIES) {
        // FIFO eviction: delete the oldest-inserted entry
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, { response, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    return response;
  } finally {
    if (acquired) {
      semaphore.release();
    }

    // Always clean up the temp file — even if execution fails.
    if (tempPromptFile) {
      await unlink(tempPromptFile).catch((e) => {
        process.stderr.write(
          `[gemini-runner] warning: failed to delete temp prompt file ${tempPromptFile}: ${e}\n`
        );
      });
    }
  }
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
    throw new GeminiOutputError(
      `gemini returned non-JSON output. Raw stdout:\n${raw.slice(0, 2000)}`,
      "gemini returned non-JSON output"
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GeminiOutputError(
      `gemini process returned unexpected JSON shape (${typeof parsed}): ${raw.slice(0, 200)}`,
      "gemini process returned unexpected JSON shape"
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
  throw new GeminiOutputError(
    `gemini JSON output has unexpected shape. Parsed object:\n${JSON.stringify(output, null, 2)}`,
    "gemini JSON output has unexpected shape"
  );
}

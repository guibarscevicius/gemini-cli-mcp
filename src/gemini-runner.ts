import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readFile, realpath, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { escape as escapeGlob, glob } from "glob";
import pLimit from "p-limit";
import { WarmProcessPool, type WarmProcess } from "./warm-pool.js";
import { mcpLog } from "./logging.js";

export class GeminiOutputError extends Error {
  constructor(message: string, public sanitizedMessage: string) {
    super(message);
    this.name = "GeminiOutputError";
  }
}

export class SemaphoreTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Gemini request timed out after ${timeoutMs}ms waiting for a concurrency slot`);
    this.name = "SemaphoreTimeoutError";
  }
}

// Configurable via GEMINI_SUBPROCESS_TIMEOUT_MS (default 1200 s / 20 min).
// Complex code review tasks with tool calls routinely take 5–15 min.
const TIMEOUT_MS = parseInt(process.env.GEMINI_SUBPROCESS_TIMEOUT_MS ?? "1200000", 10);

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
            reject(new SemaphoreTimeoutError(timeoutMs));
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

  stats(): { active: number; queued: number } {
    return { active: this.running, queued: this.queue.length };
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

// ── Warm process pool ──────────────────────────────────────────────────────
// Pre-spawns Gemini processes so the ~12–17 s cold-start cost is paid in advance.
// Requests with a custom --model fall back to cold spawn (pool processes use
// the default model).  Single @file refs also fall back (stdin mode cannot
// forward the @file token to the CLI for workspace-aware resolution).
//
// Env vars:
//   GEMINI_POOL_ENABLED     "1" (default) | "0" to disable
//   GEMINI_POOL_SIZE        default = GEMINI_MAX_CONCURRENT
//   GEMINI_POOL_STARTUP_MS  estimated CLI startup time; prompt writes are delayed until this
//                           many ms after spawn so the CLI is ready to process input (default 12000)
const POOL_ENABLED = (process.env.GEMINI_POOL_ENABLED ?? "1") !== "0";
const POOL_SIZE = parseInt(process.env.GEMINI_POOL_SIZE ?? String(MAX_CONCURRENT), 10);
const POOL_STARTUP_MS = parseInt(process.env.GEMINI_POOL_STARTUP_MS ?? "12000", 10);

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") {
      process.stderr.write(
        `[gemini-cli-mcp] warning: cannot read ${dir}: ${(err as Error).message}\n`
      );
    }
    return [];
  }
}

export function discoverGeminiBinary(): string {
  const explicit = process.env.GEMINI_BINARY;
  if (explicit) return explicit;

  const home = os.homedir();
  const candidates: string[] = [];

  // nvm — sort descending so latest version wins
  const nvmVersions = readdirSafe(nodePath.join(home, ".nvm/versions/node")).sort().reverse();
  for (const v of nvmVersions) {
    candidates.push(nodePath.join(home, `.nvm/versions/node/${v}/bin/gemini`));
  }

  // fnm
  const fnmVersions = readdirSafe(nodePath.join(home, ".fnm/node-versions")).sort().reverse();
  for (const v of fnmVersions) {
    candidates.push(nodePath.join(home, `.fnm/node-versions/${v}/installation/bin/gemini`));
  }

  // volta
  candidates.push(nodePath.join(home, ".volta/bin/gemini"));

  // asdf
  const asdfVersions = readdirSafe(nodePath.join(home, ".asdf/installs/nodejs")).sort().reverse();
  for (const v of asdfVersions) {
    candidates.push(nodePath.join(home, `.asdf/installs/nodejs/${v}/bin/gemini`));
  }

  // Homebrew (Apple Silicon + Intel)
  candidates.push("/opt/homebrew/bin/gemini", "/usr/local/bin/gemini");

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      process.stderr.write(`[gemini-cli-mcp] auto-discovered gemini at: ${candidate}\n`);
      return candidate;
    }
  }

  return "gemini"; // fallback to PATH; cold-spawn gives a clear ENOENT; warm pool detects after 5 failures
}

export const GEMINI_BINARY: string = discoverGeminiBinary();

export let warmPool: WarmProcessPool | null = null;

// Suppress pool init during --setup: the pool would try to spawn gemini immediately,
// producing ENOENT noise if gemini isn't installed yet (exactly the case --setup handles).
const SETUP_MODE = process.argv.includes("--setup");

if (POOL_ENABLED && !SETUP_MODE) {
  const geminiConfigDir = nodePath.join(os.homedir(), ".config", "gemini");
  const isFirstRun = !existsSync(geminiConfigDir);
  const effectiveStartupMs = isFirstRun
    ? Math.max(Math.round(POOL_STARTUP_MS * 2.5), 30_000)
    : POOL_STARTUP_MS;
  if (isFirstRun) {
    process.stderr.write(
      `[gemini-cli-mcp] first run detected — increased pool startup to ${effectiveStartupMs}ms\n`
    );
  }
  warmPool = new WarmProcessPool(
    Number.isFinite(POOL_SIZE) && POOL_SIZE >= 1 ? POOL_SIZE : MAX_CONCURRENT,
    ["--yolo", "--output-format", "stream-json"],
    {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    },
    effectiveStartupMs,
    GEMINI_BINARY
  );
}

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

const DEFAULT_SESSION_DB = nodePath.join(os.homedir(), ".gemini-cli-mcp", "sessions.db");

function parseIntOverride(key: string, defaultValue: number): number | string | undefined {
  const raw = process.env[key];
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  const value: number | string = Number.isFinite(parsed) ? parsed : raw;
  return value === defaultValue ? undefined : value;
}

export function getEnvOverrides(): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};

  if (MAX_CONCURRENT !== 2) overrides.GEMINI_MAX_CONCURRENT = MAX_CONCURRENT;
  const maxRetriesOverride = parseIntOverride("GEMINI_MAX_RETRIES", 3);
  if (maxRetriesOverride !== undefined) overrides.GEMINI_MAX_RETRIES = maxRetriesOverride;
  const retryBaseOverride = parseIntOverride("GEMINI_RETRY_BASE_MS", 1000);
  if (retryBaseOverride !== undefined) overrides.GEMINI_RETRY_BASE_MS = retryBaseOverride;
  const queueTimeoutOverride = parseIntOverride("GEMINI_QUEUE_TIMEOUT_MS", 60000);
  if (queueTimeoutOverride !== undefined) overrides.GEMINI_QUEUE_TIMEOUT_MS = queueTimeoutOverride;

  if (process.env.GEMINI_POOL_ENABLED !== undefined && POOL_ENABLED !== true) {
    overrides.GEMINI_POOL_ENABLED = POOL_ENABLED;
  }
  if (process.env.GEMINI_POOL_SIZE !== undefined) {
    const effectivePoolSize = Number.isFinite(POOL_SIZE) && POOL_SIZE >= 1 ? POOL_SIZE : MAX_CONCURRENT;
    if (effectivePoolSize !== MAX_CONCURRENT) {
      overrides.GEMINI_POOL_SIZE = effectivePoolSize;
    }
  }
  const poolStartupOverride = parseIntOverride("GEMINI_POOL_STARTUP_MS", 12000);
  if (poolStartupOverride !== undefined) overrides.GEMINI_POOL_STARTUP_MS = poolStartupOverride;

  if (CACHE_TTL_MS !== 300000) overrides.GEMINI_CACHE_TTL_MS = CACHE_TTL_MS;
  if (CACHE_MAX_ENTRIES !== 50) overrides.GEMINI_CACHE_MAX_ENTRIES = CACHE_MAX_ENTRIES;

  const maxHistoryOverride = parseIntOverride("GEMINI_MAX_HISTORY_TURNS", 20);
  if (maxHistoryOverride !== undefined) overrides.GEMINI_MAX_HISTORY_TURNS = maxHistoryOverride;
  const jobTtlOverride = parseIntOverride("GEMINI_JOB_TTL_MS", 300000);
  if (jobTtlOverride !== undefined) overrides.GEMINI_JOB_TTL_MS = jobTtlOverride;
  const jobGcOverride = parseIntOverride("GEMINI_JOB_GC_MS", 60000);
  if (jobGcOverride !== undefined) overrides.GEMINI_JOB_GC_MS = jobGcOverride;

  const sessionDb = process.env.GEMINI_SESSION_DB ?? DEFAULT_SESSION_DB;
  if (sessionDb !== DEFAULT_SESSION_DB) overrides.GEMINI_SESSION_DB = sessionDb;

  if (process.env.GEMINI_BINARY) overrides.GEMINI_BINARY = process.env.GEMINI_BINARY;

  return overrides;
}

export function getServerStats() {
  return {
    semaphore: semaphore.stats(),
    pool: {
      enabled: POOL_ENABLED,
      ready: warmPool?.readyCount ?? 0,
      size: warmPool?.size ?? 0,
      lastError: warmPool?.lastError ?? null,
      consecutiveFailures: warmPool?.consecutiveFailures ?? 0,
    },
    maxConcurrent: MAX_CONCURRENT,
  };
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
      const errorMsg = err instanceof Error ? err.message : String(err);
      const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1) + Math.random() * 500, 10_000);
      process.stderr.write(
        `[gemini-runner] retry ${attempt + 1}/${maxAttempts} after ${Math.round(delay)}ms (${errorMsg.slice(0, 60)})\n`
      );
      mcpLog("warning", "retry", {
        event: "retry_attempt",
        attempt: attempt + 1,
        maxAttempts,
        delayMs: delay,
        reason: errorMsg.slice(0, 120),
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error("unreachable");
}

// shared NDJSON event shape used by both runWithWarmProcess and spawnGemini
type StreamEvent = {
  type?: string;
  role?: string;
  content?: string;
  delta?: boolean;
  status?: string;
  error?: unknown;
  message?: unknown;
};

// extract structured error detail from a result:error or type:error event,
// handling string, object, and missing error/message fields
function extractErrorDetail(
  e: { error?: unknown; message?: unknown },
  rawEvent: unknown
): string {
  if (typeof e.error === "string") return e.error;
  if (typeof e.message === "string") return e.message;
  if (e.error != null) return JSON.stringify(e.error);
  if (e.message != null) return JSON.stringify(e.message);

  process.stderr.write(
    `[gemini-cli-mcp] unrecognized error event: ${JSON.stringify(rawEvent)}\n`
  );
  return "gemini error (unknown)";
}

export interface GeminiOptions {
  model?: string;
  cwd?: string;
  tool?: string;
  sessionId?: string;
  expandRefs?: boolean;
}

/** Injectable executor type — override in tests to avoid spawning a real subprocess. */
export type GeminiExecutor = (
  args: string[],
  opts: { env: Record<string, string>; cwd?: string; timeout: number },
  onChunk?: (text: string) => void
) => Promise<{ stdout: string }>;

/**
 * Drive a pre-spawned warm process: write prompt to stdin, close it, then
 * parse NDJSON events from stdout incrementally as they arrive.
 *
 * The warm process may have accumulated leading newlines from the keepalive
 * timer; they appear in the user message content but do not affect response
 * quality (the CLI ignores empty lines).
 */
export function runWithWarmProcess(
  wp: WarmProcess,
  prompt: string,
  timeoutMs: number,
  onChunk: ((text: string) => void) | undefined
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const cp = wp.cp;
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
      try {
        cp.kill("SIGTERM");
        setTimeout(() => { try { cp.kill("SIGKILL"); } catch { /* already dead */ } }, 5000);
      } catch { /* already dead */ }
      settle(() => reject(new Error(`Gemini warm process timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

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
          if (process.env.GEMINI_STRUCTURED_LOGS === "1") {
            process.stderr.write(
              `[gemini-cli-mcp] skipped non-JSON line: ${trimmed.slice(0, 120)}\n`
            );
          }
          continue;
        }

        const e = event as StreamEvent;

        if (e.type === "message" && e.role === "assistant" && typeof e.content === "string") {
          accumulated += e.content;
          onChunk?.(e.content);
        } else if (e.type === "result") {
          if (e.status === "success") {
            settle(() => resolve(accumulated));
          } else {
            const errDetail = extractErrorDetail(e, event);
            settle(() => reject(new GeminiOutputError(errDetail, errDetail)));
          }
        } else if (e.type === "error") {
          const errDetail = extractErrorDetail(e, event);
          settle(() => reject(new GeminiOutputError(errDetail, errDetail)));
        }
      }
    });

    cp.on("error", (err) => {
      settle(() => reject(new Error(`gemini warm process error: ${err.message}`, { cause: err })));
    });

    cp.on("close", (code, signal) => {
      if (settled) return;
      if (code === 0) {
        settle(() => resolve(accumulated));
      } else {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        settle(() =>
          reject(
            new GeminiOutputError(
              `gemini warm process exited with ${reason}`,
              `gemini warm process exited with ${reason}`
            )
          )
        );
      }
    });

    // Write prompt + EOF to trigger processing, delaying until the process is
    // expected to have fully started.  The delay is max(0, wp.readyAt - now):
    //   • 0 when the process has already been running for ≥ startupMs (steady state)
    //   • positive only for the very first requests after server startup, when the
    //     pool processes are still initializing — writing too early means the prompt
    //     sits in the OS pipe buffer and the CLI only reads it after startup completes
    //     anyway, but the explicit wait keeps the timeout clock more accurate.
    // Keepalive newlines may already be buffered in stdin; they are harmless to
    // response content (the CLI ignores empty lines).
    const startupWaitMs = Math.max(0, wp.readyAt - Date.now());
    const writePrompt = () => {
      cp.stdin?.write(prompt + "\n");
      cp.stdin?.end();
    };
    if (startupWaitMs > 0) {
      setTimeout(writePrompt, startupWaitMs);
    } else {
      writePrompt();
    }
  });
}

/**
 * Spawn `gemini` with `--output-format stream-json` and parse NDJSON events.
 *
 * Parses `message` events (role=assistant) into chunks, waits for
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
  const cp = spawn(GEMINI_BINARY, args, {
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
    setTimeout(() => { try { cp.kill("SIGKILL"); } catch { /* already dead */ } }, 5000);
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
        if (process.env.GEMINI_STRUCTURED_LOGS === "1") {
          process.stderr.write(
            `[gemini-cli-mcp] skipped non-JSON line: ${trimmed.slice(0, 120)}\n`
          );
        }
        continue;
      }

      const e = event as StreamEvent;

      if (e.type === "message" && e.role === "assistant" && typeof e.content === "string") {
        accumulated += e.content;
        onChunk(e.content);
      } else if (e.type === "result") {
        if (e.status === "success") {
          settle(() => onDone(accumulated));
        } else {
          const errDetail = extractErrorDetail(e, event);
          settle(() => onError(new GeminiOutputError(errDetail, errDetail)));
        }
      } else if (e.type === "error") {
        const errDetail = extractErrorDetail(e, event);
        settle(() => onError(new GeminiOutputError(errDetail, errDetail)));
      }
    }
  });

  // buffer last 4 KB of stderr for diagnostics on non-zero exit
  let stderrTail = "";
  cp.stderr?.on("data", (data: Buffer) => {
    stderrTail = (stderrTail + data.toString("utf8")).slice(-4096);
  });

  cp.on("error", (err) => {
    const detail = err.message;
    if ((err as { code?: string }).code === "ENOENT") {
      settle(() =>
        onError(
          new Error(`gemini binary not found at '${GEMINI_BINARY}'. Run: gemini-cli-mcp --setup`, {
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

  cp.on("close", (code, signal) => {
    if (settled) return;
    if (code === 0) {
      // No result event received — treat accumulated as the response
      settle(() => onDone(accumulated));
    } else {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      const detail = stderrTail.trim();
      const msg = detail
        ? `gemini process exited with ${reason}: ${detail}`
        : `gemini process exited with ${reason}`;
      settle(() =>
        onError(new GeminiOutputError(msg, `gemini process exited with ${reason}`))
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
 * Characters that signal the token is NOT a file path — used to reject
 * framework template syntax (@click.prevent="save"), shell pipes (@cmd|grep),
 * angle-bracket patterns (@foo<div>), and similar false positives.  (#38)
 *
 * `=` / `"` / `'` → attribute bindings (Vue, Angular, Svelte)
 * `<` / `>`       → HTML/JSX angle brackets
 * `|`             → shell pipes
 * `` ` ``         → template literals / inline code
 */
const NON_PATH_CHARS_RE = /[='"<>|`]/;

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
    // Skip tokens containing characters that signal non-file-path context —
    // catches Vue/Angular template syntax (@click.prevent="..."), shell pipes,
    // string delimiters, and similar false positives.  (#38)
    if (NON_PATH_CHARS_RE.test(match[1])) {
      if (process.env.GEMINI_STRUCTURED_LOGS === "1") {
        process.stderr.write(JSON.stringify({
          event: "file_ref_skipped",
          token: match[1].slice(0, 80),
          reason: "non_path_chars",
        }) + "\n");
      }
      continue;
    }
    const balanced = extractBalancedPath(match[1]);
    if (/[/.]/.test(balanced)) {
      paths.push(balanced);
    }
  }
  return paths;
}

/** Count the number of @file tokens in a prompt. */
export function countFileRefs(prompt: string): number {
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

  const limit = pLimit(8);
  const sectionGroups = await Promise.all(
    fileRefs.map((rawPath) =>
      limit(async () => {
        let filePaths: string[];
        if (/[*?{]/.test(rawPath)) {
          try {
            filePaths = await glob(escapeGlobSegments(rawPath), {
              cwd: realCwd,
              absolute: true,
              nodir: true,
            });
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

        return Promise.all(
          filePaths.map(async (absPath) => {
            // realpath() follows symlinks — prevents a symlink inside cwd from escaping the workspace
            let realAbsPath: string;
            try {
              realAbsPath = await realpath(absPath);
            } catch (err) {
              const code = (err as { code?: string }).code;
              const detail = code === "EACCES" ? "permission denied" : "does not exist";
              throw new Error(`File not found: @${rawPath} — ${absPath} ${detail}`, { cause: err });
            }

            const cwdPrefix = realCwd.endsWith(nodePath.sep) ? realCwd : realCwd + nodePath.sep;
            if (!realAbsPath.startsWith(cwdPrefix) && realAbsPath !== realCwd) {
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
            return `Content from @${relPath}:\n${content}`;
          })
        );
      })
    )
  );
  const sections = sectionGroups.flat();

  // Mask @tokens in the prompt text to prevent double expansion by the CLI
  // We use a replacement function with the same regex to ensure consistency.
  GREEDY_AT_RE.lastIndex = 0;
  const maskedPrompt = prompt.replace(GREEDY_AT_RE, (match, pathToken) => {
    // Apply the same non-path filter as extractFileRefs — without this,
    // framework tokens like @click.prevent="save" get their @ stripped.  (#38)
    if (NON_PATH_CHARS_RE.test(pathToken)) return match;
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
 *  - --output-format stream-json gives structured, parseable NDJSON output
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
  if (opts.expandRefs !== false && !opts.cwd && countFileRefs(prompt) >= 2) {
    throw new Error(
      "Multiple @file tokens require the cwd option — pass the project root directory."
    );
  }

  // Expand multiple @file references ourselves; single @file still goes through CLI
  let expandedPrompt = prompt;
  if (opts.cwd && opts.expandRefs !== false) {
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

  // Use warm pool when: pool is enabled, no custom model, and the expanded
  // prompt has no remaining @file refs (single-ref prompts without cwd are
  // left for the CLI to resolve; stdin mode cannot forward @-tokens).
  const usePool =
    POOL_ENABLED &&
    warmPool !== null &&
    !opts.model &&
    countFileRefs(expandedPrompt) === 0;

  // Build cold-spawn args (only needed when not using the pool).
  const args: string[] = usePool
    ? []
    : ["--yolo", "--output-format", "stream-json"];

  if (!usePool && opts.model) {
    args.push("--model", opts.model);
  }

  // Large-prompt bypass: Linux MAX_ARG_STRLEN (~128 KB) caps any single exec argument.
  // Prompts above the threshold are written to a temp file and passed as @<path> so the
  // CLI reads from disk — completely bypasses the per-argument kernel limit.
  // Not needed for the warm pool path (prompt is written to stdin, not as an exec arg).
  let tempPromptFile: string | null = null;
  const bypassUsed = !usePool && expandedPrompt.length > LARGE_PROMPT_THRESHOLD;
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
  } else if (!usePool) {
    args.push("--prompt", expandedPrompt);
  }

  let acquired = false;
  const startTime = Date.now();
  try {
    let response: string;
    let retryCount = 0;

    // Both paths respect GEMINI_MAX_CONCURRENT — the semaphore caps the number of
    // in-flight Gemini subprocesses regardless of warm-pool vs cold-spawn mode.
    await semaphore.acquire(QUEUE_TIMEOUT_MS);
    acquired = true;

    if (usePool) {
      // ── Warm pool path ──────────────────────────────────────────────────
      // Pool.acquire() is inside withRetry so each retry gets a fresh process.
      try {
        ({ result: response, retryCount } = await withRetry(async () => {
          const wp = await warmPool!.acquire(QUEUE_TIMEOUT_MS);
          return runWithWarmProcess(wp, expandedPrompt, TIMEOUT_MS, onChunk);
        }, MAX_RETRIES > 0 ? MAX_RETRIES + 1 : 1));
      } catch (err) {
        const homeDirForTelemetry = process.env.HOME ?? "";
        let telemetryError: string;
        if (err instanceof GeminiOutputError) {
          telemetryError = err.sanitizedMessage;
        } else if (err instanceof Error) {
          telemetryError = err.message;
        } else {
          telemetryError = String(err);
        }
        if (homeDirForTelemetry) {
          telemetryError = telemetryError.split(homeDirForTelemetry).join("~");
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
              bypassUsed: false,
              retryCount: retryCountFromError,
              status: "error",
              error: telemetryError,
            }) + "\n"
          );
        }
        throw err;
      }
    } else {
      // ── Cold spawn path ─────────────────────────────────────────────────
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
        const homeDirForTelemetry = process.env.HOME ?? "";
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
        if (homeDirForTelemetry) {
          telemetryError = telemetryError.split(homeDirForTelemetry).join("~");
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

        // prepend model after telemetry so aggregation keys stay clean
        if (opts.model && err instanceof Error) {
          err.message = `(model: ${opts.model}) ${err.message}`;
        }
        throw err;
      }
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

/** @deprecated No longer used — output parsing migrated to inline NDJSON in spawnGemini/runWithWarmProcess. Retained for downstream consumers. */
export interface GeminiJsonOutput {
  response?: string;
  text?: string;
  content?: string;
  error?: string;
}

/** @deprecated No longer used in production — see GeminiJsonOutput. */
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

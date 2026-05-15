import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { WarmProcessPool, type WarmProcess } from "./warm-pool.js";
import { mcpLog } from "./logging.js";
import { getCapabilities, buildBaseArgs, GEMINI_CHILD_ENV_OVERRIDES } from "./cli-capabilities.js";
import { spawnInGroup, killGroup } from "./process-group.js";
import { reapOrphans } from "./orphan-reaper.js";
import { MAX_CONCURRENT, QUEUE_TIMEOUT_MS, semaphore } from "./concurrency.js";
import { GEMINI_BINARY } from "./binary-discovery.js";
import { countFileRefs, expandFileRefs, LARGE_PROMPT_THRESHOLD } from "./prompt-prep.js";
import { cache, cacheKey, CACHE_TTL_MS, CACHE_MAX_ENTRIES } from "./response-cache.js";

// Re-export at original paths so consumers (resources.ts, index.ts, tools/*, setup.ts)
// don't need to update import sites — the file split (#109) is mechanical.
export { Semaphore, SemaphoreTimeoutError } from "./concurrency.js";
export { discoverGeminiBinary, GEMINI_BINARY } from "./binary-discovery.js";
export { expandFileRefs, countFileRefs } from "./prompt-prep.js";
export { clearCache } from "./response-cache.js";

export class GeminiOutputError extends Error {
  constructor(message: string, public sanitizedMessage: string) {
    super(message);
    this.name = "GeminiOutputError";
  }
}

// 300 s - allows Gemini 2.5 Pro deep-reasoning tasks (can take 2–3 min before first token)
const TIMEOUT_MS = 300_000;

// ── Warm process pool ──────────────────────────────────────────────────────
// Pre-spawns Gemini processes so the ~12–17 s cold-start cost is paid in advance.
// Requests with a custom --model fall back to cold spawn (pool processes use
// the default model).  Single @file refs also fall back (stdin mode cannot
// forward the @file token to the CLI for workspace-aware resolution).
//
// Env vars:
//   GEMINI_POOL_ENABLED          "1" (default) | "0" to disable
//   GEMINI_POOL_SIZE             default = 1 (one warm slot per server; idle eviction lets
//                                larger values relax during quiet windows)
//   GEMINI_POOL_STARTUP_MS       estimated CLI startup time; prompt writes are delayed until this
//                                many ms after spawn so the CLI is ready to process input (default 12000)
//   GEMINI_POOL_IDLE_TIMEOUT_MS  shrink the pool to GEMINI_POOL_MIN_SIZE after this many ms with no
//                                acquire() calls (default 300000 = 5 min; 0 disables eviction)
//   GEMINI_POOL_MIN_SIZE         floor the pool can shrink to during idle eviction (default 0,
//                                must be ≤ GEMINI_POOL_SIZE)
const POOL_ENABLED = (process.env.GEMINI_POOL_ENABLED ?? "1") !== "0";
const POOL_SIZE = parseInt(process.env.GEMINI_POOL_SIZE ?? "1", 10);
const POOL_STARTUP_MS = parseInt(process.env.GEMINI_POOL_STARTUP_MS ?? "12000", 10);
const POOL_IDLE_TIMEOUT_MS = parseInt(process.env.GEMINI_POOL_IDLE_TIMEOUT_MS ?? "300000", 10);
const POOL_MIN_SIZE = parseInt(process.env.GEMINI_POOL_MIN_SIZE ?? "0", 10);
// Validate pool config only when the pool is enabled — disabled-pool users with
// stale/invalid GEMINI_POOL_* env vars must not crash the server.
if (POOL_ENABLED) {
  if (!Number.isFinite(POOL_SIZE) || POOL_SIZE < 1) {
    throw new Error(
      `GEMINI_POOL_SIZE must be a positive integer, got "${process.env.GEMINI_POOL_SIZE}". ` +
        "Use 1 (default) for minimal footprint, or a larger value combined with idle eviction."
    );
  }
  if (!Number.isFinite(POOL_IDLE_TIMEOUT_MS) || POOL_IDLE_TIMEOUT_MS < 0) {
    throw new Error(
      `GEMINI_POOL_IDLE_TIMEOUT_MS must be a non-negative integer, got "${process.env.GEMINI_POOL_IDLE_TIMEOUT_MS}". ` +
        "Use 0 to disable idle eviction or a positive value (ms) to enable."
    );
  }
  if (!Number.isFinite(POOL_MIN_SIZE) || POOL_MIN_SIZE < 0) {
    throw new Error(
      `GEMINI_POOL_MIN_SIZE must be a non-negative integer, got "${process.env.GEMINI_POOL_MIN_SIZE}".`
    );
  }
  if (POOL_MIN_SIZE > POOL_SIZE) {
    throw new Error(
      `GEMINI_POOL_MIN_SIZE (${POOL_MIN_SIZE}) cannot exceed GEMINI_POOL_SIZE (${POOL_SIZE}).`
    );
  }
}

export let warmPool: WarmProcessPool | null = null;

// Suppress pool init during --setup: the pool would try to spawn gemini immediately,
// producing ENOENT noise if gemini isn't installed yet (exactly the case --setup handles).
const SETUP_MODE = process.argv.includes("--setup");

// Issue #99 — orphan reaper. Fire-and-forget at module load, before pool init.
// The strict subreaper-set membership filter inside reapOrphans ensures it
// cannot false-positive on our own newborn pool members (their PPID is our
// PID, never one of our root-owned ancestors), so this is safe to run
// concurrently with the WarmProcessPool constructor below. Gated by
// GEMINI_ORPHAN_REAPER (default on; set to "0" to disable).
if (!SETUP_MODE && process.env.GEMINI_ORPHAN_REAPER !== "0") {
  const log =
    process.env.GEMINI_STRUCTURED_LOGS === "1"
      ? (event: Record<string, unknown>) => {
          process.stderr.write(JSON.stringify(event) + "\n");
        }
      : undefined;
  void reapOrphans({
    signature: ["--yolo", "--output-format", "stream-json"],
    log,
  })
    .then(({ reaped, failed }) => {
      // failed > 0 means matched orphans we couldn't signal (e.g., EPERM,
      // SIGKILL didn't take). Discarding the count would let an entirely
      // failing reaper look identical to a clean run. Per-pid detail is in
      // the structured log; this is the must-see headline.
      if (failed > 0) {
        process.stderr.write(
          `[gemini-cli-mcp] orphan reaper: ${reaped} reaped, ${failed} failed ` +
            `(enable GEMINI_STRUCTURED_LOGS=1 for per-pid detail)\n`,
        );
      }
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `[gemini-cli-mcp] orphan reaper failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
}

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
  // The args here MUST match the orphan-reaper signature on line 183 and
  // PGREP_PATTERN in scripts/verify-pool-logic.mjs. If you change them, update
  // all three sites — there's no automated coupling.
  warmPool = new WarmProcessPool(
    POOL_SIZE,
    ["--yolo", "--output-format", "stream-json"],
    {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      ...GEMINI_CHILD_ENV_OVERRIDES,
    },
    effectiveStartupMs,
    GEMINI_BINARY,
    POOL_IDLE_TIMEOUT_MS,
    POOL_MIN_SIZE
  );
}

// Kick off CLI capability detection (non-blocking) — logs version on success.
// Pool args stay hardcoded for this server lifetime; detection informs cold-spawn
// arg selection in runGemini().
if (!SETUP_MODE) {
  getCapabilities(GEMINI_BINARY).then((caps) => {
    if (caps.version) process.stderr.write(`[gemini-cli-mcp] gemini CLI v${caps.version.raw} detected\n`);
    if (caps.error) process.stderr.write(`[gemini-cli-mcp] CLI detection: ${caps.error}\n`);
  }, (err) => {
    process.stderr.write(`[gemini-cli-mcp] CLI detection failed unexpectedly: ${(err as Error).message ?? err}\n`);
  });
}

const MAX_RETRIES = parseInt(process.env.GEMINI_MAX_RETRIES ?? "3", 10);
const RETRY_BASE_MS = parseInt(process.env.GEMINI_RETRY_BASE_MS ?? "1000", 10);

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
  if (process.env.GEMINI_POOL_SIZE !== undefined && POOL_SIZE !== 1) {
    overrides.GEMINI_POOL_SIZE = POOL_SIZE;
  }
  const poolIdleTimeoutOverride = parseIntOverride("GEMINI_POOL_IDLE_TIMEOUT_MS", 300000);
  if (poolIdleTimeoutOverride !== undefined) overrides.GEMINI_POOL_IDLE_TIMEOUT_MS = poolIdleTimeoutOverride;
  const poolMinSizeOverride = parseIntOverride("GEMINI_POOL_MIN_SIZE", 0);
  if (poolMinSizeOverride !== undefined) overrides.GEMINI_POOL_MIN_SIZE = poolMinSizeOverride;
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
  if (process.env.GEMINI_MODELS) overrides.GEMINI_MODELS = process.env.GEMINI_MODELS;

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
      killGroup(cp, "SIGTERM");
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
 * Parses `message` events (role=assistant) into chunks, waits for a `result`
 * event to signal completion, and handles error/process-level failures.
 * Returns a `ChildProcess` so callers can store it for cancellation.
 *
 * Callback contract: `onChunk`, `onDone`, and `onError` are mutually exclusive
 * once a terminal outcome is reached. An internal `settled` flag (see `settle()`
 * below) ensures only the first of `onDone`/`onError` runs and that no further
 * `onChunk` fires after settlement.
 *
 * @param args      Argv array for the gemini CLI (no shell expansion).
 * @param spawnOpts `env` is merged with {@link GEMINI_CHILD_ENV_OVERRIDES};
 *                  `timeout` is enforced via internal `setTimeout` that kills
 *                  the process group on expiry.
 * @param onChunk   Called per assistant message event with the new text fragment.
 * @param onDone    Called once with the accumulated text when the CLI emits a
 *                  `result` event.
 * @param onError   Called once with a spawn/parse/timeout failure.
 */
export function spawnGemini(
  args: string[],
  spawnOpts: { env: Record<string, string>; cwd?: string; timeout: number },
  onChunk: (text: string) => void,
  onDone: (fullText: string) => void,
  onError: (err: Error) => void
): ChildProcess {
  const cp = spawnInGroup(GEMINI_BINARY, args, {
    env: { ...spawnOpts.env, ...GEMINI_CHILD_ENV_OVERRIDES },
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
    killGroup(cp, "SIGTERM");
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
 * Runs `gemini` as a subprocess with no shell interpolation.
 *
 * Security properties (mitigates CVE-2026-0755-class command injection):
 *  - `child_process.spawn` is invoked with an argv array (via `spawnInGroup`
 *    → `spawnGemini`); the shell is never involved, so metacharacters in
 *    user input cannot be reinterpreted by /bin/sh.
 *  - args array is built programmatically, never string-concatenated
 *  - env is restricted to HOME and PATH only; all other inherited env vars
 *    (API keys, tokens, secrets) are stripped. Note: HOME is required for
 *    Gemini CLI OAuth credential access (~/.config/gemini); it is not a
 *    sandbox boundary.
 *  - --yolo auto-approves Gemini's own tool use (prevents hanging in non-interactive mode)
 *  - --output-format stream-json gives structured, parseable NDJSON output
 *
 * @param prompt    User prompt; `@file` references are expanded in-place when
 *                  the heuristic in {@link prepareLargePrompt} fires.
 * @param opts      Optional {@link GeminiOptions} (model, cwd, timeout, …).
 * @param executor  Override the spawn path. Defaults to `defaultExecutor`,
 *                  which calls {@link spawnGemini}. Tests substitute this to
 *                  inject deterministic streams.
 * @param onChunk   Streams assistant message fragments as they arrive.
 * @param lifecycle Extension point used by `tools/shared.ts:runGeminiAsync`
 *                  to capture the live `ChildProcess` for cancellation and
 *                  to be notified when the subprocess exits.
 */
export async function runGemini(
  prompt: string,
  opts: GeminiOptions = {},
  executor: GeminiExecutor = defaultExecutor,
  onChunk?: (text: string) => void,
  lifecycle?: {
    onProcessStart?: (cp: ChildProcess) => void;
    onProcessEnd?: () => void;
  }
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
  // Uses detected CLI capabilities to adapt flags (e.g. --approval-mode vs --yolo).
  let caps: import("./cli-capabilities.js").CliCapabilities | null = null;
  if (!usePool) {
    try {
      caps = await getCapabilities(GEMINI_BINARY);
    } catch (err) {
      process.stderr.write(`[gemini-cli-mcp] capability detection failed, using fallback args: ${(err as Error).message ?? err}\n`);
    }
  }
  const args: string[] = usePool ? [] : buildBaseArgs(caps);

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
          lifecycle?.onProcessStart?.(wp.cp);
          try {
            return await runWithWarmProcess(wp, expandedPrompt, TIMEOUT_MS, onChunk);
          } finally {
            lifecycle?.onProcessEnd?.();
          }
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

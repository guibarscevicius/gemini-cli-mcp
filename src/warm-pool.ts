/**
 * WarmProcessPool — pre-spawned Gemini CLI process pool.
 *
 * Each pool process is spawned without --prompt, with stdin kept open.
 * Periodic keepalive newlines (every KEEPALIVE_INTERVAL_MS) prevent the CLI
 * from exiting on its ~14 s stdin-idle timeout.
 *
 * When a request arrives the caller writes the prompt to stdin and closes it
 * (EOF). The CLI processes the accumulated input, exits cleanly, and flushes
 * all buffered NDJSON to stdout in one shot.  A replacement process is spawned
 * immediately so the pool is replenished for the next request.
 *
 * Each WarmProcess carries a `readyAt` timestamp (spawnedAt + startupMs).
 * runWithWarmProcess() delays the prompt write until that timestamp so the CLI
 * has time to fully initialize before receiving input.  The delay is zero for
 * processes that have already aged past startupMs (steady-state requests).
 *
 * Measured latency improvement (vs cold spawn):
 *   cold spawn  → first-byte ~13.6 s, total ~17 s
 *   warm process → first-byte ~0.9 s, total ~4.4 s  (≈ 12 s savings)
 */

import { type ChildProcess } from "node:child_process";
import { mcpLog } from "./logging.js";
import { spawnInGroup, killGroup } from "./process-group.js";

/** Interval between keepalive writes to each idle process (ms). */
const KEEPALIVE_INTERVAL_MS = 5_000;

export interface WarmProcess {
  cp: ChildProcess;
  pid: number | undefined;
  /** Absolute timestamp (Date.now()) after which the CLI is expected to be fully started. */
  readyAt: number;
}

type Waiter = {
  resolve: (wp: WarmProcess) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

type ReadyEntry = {
  wp: WarmProcess;
  keepAliveInterval: ReturnType<typeof setInterval>;
};

export class WarmProcessPool {
  private readonly ready: ReadyEntry[] = [];
  private readonly waiters: Waiter[] = [];
  private draining = false;
  private evicting = false;
  private consecutiveSpawnFailures = 0;
  private lastSpawnError: string | null = null;
  private lastAcquireAt: number = Date.now();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly MAX_CONSECUTIVE_FAILURES = 5;

  /**
   * @param poolSize       Number of processes to keep warm.
   * @param baseArgs       Args to pass to every spawned `gemini` process (no --prompt).
   * @param env            Restricted env for the subprocess (HOME + PATH).
   * @param startupMs      Estimated CLI startup time (ms).  Prompt writes are delayed until
   *                       this many ms after spawn, so the CLI is ready to process input.
   *                       Defaults to 0 (no delay) — production code passes the env-configured value.
   * @param binary         Path to the `gemini` binary (default: "gemini" via PATH).
   * @param idleTimeoutMs  After this many ms with no acquire(), the pool shrinks to `minSize`.
   *                       Defaults to 0 (eviction disabled).
   * @param minSize        Floor the pool can shrink to during idle eviction. Must be ≤ `poolSize`.
   *                       Defaults to 0 (full eviction when idle).
   */
  constructor(
    private readonly poolSize: number,
    private readonly baseArgs: string[],
    private readonly env: Record<string, string>,
    private readonly startupMs: number = 0,
    private readonly binary: string = "gemini",
    private readonly idleTimeoutMs: number = 0,
    private readonly minSize: number = 0
  ) {
    if (this.minSize < 0 || this.idleTimeoutMs < 0) {
      throw new Error("WarmProcessPool: minSize and idleTimeoutMs must be non-negative");
    }
    if (this.minSize > this.poolSize) {
      throw new Error(
        `WarmProcessPool: minSize (${this.minSize}) cannot exceed poolSize (${this.poolSize})`
      );
    }
    for (let i = 0; i < poolSize; i++) {
      this._spawnAndEnqueue();
    }
    if (this.idleTimeoutMs > 0) {
      this.idleTimer = setInterval(() => this._evictIfIdle(), this.idleTimeoutMs);
      // Don't keep the event loop alive solely for eviction checks — the
      // server's other timers (job GC, session-store etc.) anchor the loop.
      this.idleTimer.unref?.();
    }
  }

  /** Spawn one warm process and either give it to a waiting caller or enqueue it. */
  private _spawnAndEnqueue(): void {
    if (this.draining || this.evicting) return;

    const cp = spawnInGroup(this.binary, this.baseArgs, {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const wp: WarmProcess = { cp, pid: cp.pid, readyAt: Date.now() + this.startupMs };

    // listen for first stderr output as a readiness heuristic — the CLI writes
    // to stderr during startup (version info, auth checks, etc.). When we see
    // any output the process is likely past initialization (not guaranteed).
    const onStderrReady = () => {
      wp.readyAt = Date.now();
    };
    cp.stderr?.once("data", onStderrReady);
    // Drain remaining stderr so a full pipe buffer never stalls the subprocess.
    cp.stderr?.on("data", () => {});

    // Keepalive: send a bare newline every KEEPALIVE_INTERVAL_MS so the CLI
    // does not exit with "No input provided via stdin" after ~14 s idle.
    const keepAliveInterval = setInterval(() => {
      if (cp.exitCode === null && cp.stdin?.writable) {
        cp.stdin.write("\n");
      } else {
        clearInterval(keepAliveInterval);
      }
    }, KEEPALIVE_INTERVAL_MS);

    // If the process exits while still in the ready queue (e.g. unexpected
    // crash or auth failure), remove it and replenish.
    const onExitOrError = (err?: Error) => {
      clearInterval(keepAliveInterval);
      if (err) {
        this.lastSpawnError = err.message;
      }
      const idx = this.ready.findIndex((r) => r.wp === wp);
      if (idx !== -1) {
        this.ready.splice(idx, 1);
        if (!this.draining) {
          // Check for ENOENT (binary not found) — avoid infinite spawn loop
          if ((err as { code?: string } | undefined)?.code === "ENOENT") {
            this.consecutiveSpawnFailures++;
            if (this.consecutiveSpawnFailures >= WarmProcessPool.MAX_CONSECUTIVE_FAILURES) {
              process.stderr.write(
                `[gemini-cli-mcp] warm pool: gemini binary not found at '${this.binary}' — ` +
                `pool disabled after ${WarmProcessPool.MAX_CONSECUTIVE_FAILURES} consecutive failures\n`
              );
              mcpLog("warning", "pool", {
                event: "pool_disabled",
                reason: "binary not found",
                consecutiveFailures: WarmProcessPool.MAX_CONSECUTIVE_FAILURES,
              });
              // Reject any waiters that would otherwise hang indefinitely, then
              // permanently disable the pool so future acquire() calls fail fast.
              this.draining = true;
              for (const waiter of this.waiters) {
                if (waiter.timer !== undefined) clearTimeout(waiter.timer);
                waiter.reject(new Error("Gemini process pool disabled: gemini binary not found"));
              }
              this.waiters.length = 0;
              return;
            }
          } else {
            this.consecutiveSpawnFailures = 0;
          }
          this._spawnAndEnqueue();
        }
      }
    };

    cp.on("exit", () => onExitOrError());
    cp.on("error", (err) => onExitOrError(err));

    // If a caller is already waiting, hand it over immediately.
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      clearInterval(keepAliveInterval);
      cp.stderr?.removeListener("data", onStderrReady);
      this.consecutiveSpawnFailures = 0;
      waiter.resolve(wp);
      // Spawn a replacement so pool capacity is maintained.
      if (!this.draining) this._spawnAndEnqueue();
    } else {
      this.ready.push({ wp, keepAliveInterval });
    }
  }

  /**
   * Acquire a warm process.
   *
   * Resolves immediately if one is available; otherwise queues the request
   * until a process becomes ready (up to `timeoutMs` milliseconds).
   * A replacement process is spawned immediately upon acquisition.
   */
  acquire(timeoutMs?: number): Promise<WarmProcess> {
    if (this.draining) {
      return Promise.reject(new Error("Gemini process pool is shutting down"));
    }

    this.lastAcquireAt = Date.now();

    if (this.ready.length > 0) {
      const { wp, keepAliveInterval } = this.ready.shift()!;
      clearInterval(keepAliveInterval);
      this.consecutiveSpawnFailures = 0;
      // Spawn replacement before returning so the next caller doesn't wait.
      if (!this.draining) this._spawnAndEnqueue();
      return Promise.resolve(wp);
    }

    return new Promise<WarmProcess>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) {
            this.waiters.splice(idx, 1);
            reject(
              new Error(
                `Gemini request timed out after ${timeoutMs}ms waiting for warm process`
              )
            );
          }
        }, timeoutMs);
      }
      this.waiters.push(waiter);

      // Pool is empty (idle eviction shrank below 1, or every slot is in flight
      // and no spawn is queued). Trigger a spawn now — `_spawnAndEnqueue`
      // checks the waiter queue at the end of its body and hands the new
      // process directly to the waiter we just pushed.
      //
      // Skip when poolSize is 0 (a deliberately empty pool, used in tests for
      // the timeout/drain rejection paths). A zero-size pool never spawns.
      if (!this.draining && !this.evicting && this.poolSize > 0) {
        this._spawnAndEnqueue();
      }
    });
  }

  /**
   * Evict ready processes down to `minSize` if the pool has been idle for at
   * least `idleTimeoutMs`. Called by the idle-check interval.
   *
   * The eviction loop is fully synchronous. Two layers of defense prevent the
   * killed workers from being respawned:
   *  1. Primary: `ready.shift()` removes the entry BEFORE `killGroup`, so when
   *     the async `exit` event fires later, `onExitOrError` finds `idx === -1`
   *     and skips its replenishment branch.
   *  2. Secondary: the `evicting` flag suppresses the spawn that `acquire()`
   *     would otherwise trigger on an empty pool — without it, an `acquire()`
   *     racing the kill loop would immediately respawn what we just removed.
   * The flag is set/cleared inside `try/finally` so an exception in `killGroup`
   * cannot leave the pool stuck in `evicting === true`.
   */
  private _evictIfIdle(): void {
    if (this.draining) return;
    if (Date.now() - this.lastAcquireAt < this.idleTimeoutMs) return;
    if (this.ready.length <= this.minSize) return;

    const before = this.ready.length;
    this.evicting = true;
    try {
      while (this.ready.length > this.minSize) {
        const entry = this.ready.shift()!;
        clearInterval(entry.keepAliveInterval);
        if (entry.wp.cp.exitCode === null) {
          killGroup(entry.wp.cp, "SIGTERM");
        }
      }
    } finally {
      this.evicting = false;
    }
    mcpLog("info", "pool", {
      event: "idle_eviction",
      evicted: before - this.ready.length,
      remaining: this.ready.length,
      idleMs: Date.now() - this.lastAcquireAt,
    });
  }

  /** Kill all ready processes and reject all pending waiters (graceful shutdown). */
  async drain(): Promise<void> {
    this.draining = true;

    if (this.idleTimer !== null) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }

    // Reject all pending waiters immediately.
    for (const waiter of this.waiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(new Error("Gemini process pool is shutting down"));
    }
    this.waiters.length = 0;

    // Snapshot and clear ready queue before killing, so the pool's own "exit"
    // listener (which checks this.ready) does not splice during iteration.
    const entries = this.ready.splice(0);
    const exits = entries.map(({ wp, keepAliveInterval }) => {
      clearInterval(keepAliveInterval);
      if (wp.cp.exitCode !== null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        wp.cp.on("exit", () => resolve());
        wp.cp.on("error", () => resolve());
        // killGroup never throws: it returns false when the child is already
        // exited or the group-signal failed (e.g. ESRCH). In either case the
        // promise must resolve so drain() does not hang.
        if (!killGroup(wp.cp, "SIGTERM")) resolve();
      });
    });

    await Promise.all(exits);
  }

  /** Number of idle (ready) processes currently in the pool. */
  get readyCount(): number {
    return this.ready.length;
  }

  /** Configured pool size. */
  get size(): number {
    return this.poolSize;
  }

  /** Most recent spawn/runtime error observed while replenishing the pool. */
  get lastError(): string | null {
    return this.lastSpawnError;
  }

  /** Consecutive ENOENT spawn failures while replenishing the pool. */
  get consecutiveFailures(): number {
    return this.consecutiveSpawnFailures;
  }
}

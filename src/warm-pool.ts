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

import { spawn, type ChildProcess } from "node:child_process";

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
  private consecutiveSpawnFailures = 0;
  private static readonly MAX_CONSECUTIVE_FAILURES = 5;

  /**
   * @param poolSize   Number of processes to keep warm (default: GEMINI_MAX_CONCURRENT).
   * @param baseArgs   Args to pass to every spawned `gemini` process (no --prompt).
   * @param env        Restricted env for the subprocess (HOME + PATH).
   * @param startupMs  Estimated CLI startup time (ms).  Prompt writes are delayed until
   *                   this many ms after spawn, so the CLI is ready to process input.
   *                   Defaults to 0 (no delay) — production code passes the env-configured value.
   */
  constructor(
    private readonly poolSize: number,
    private readonly baseArgs: string[],
    private readonly env: Record<string, string>,
    private readonly startupMs: number = 0
  ) {
    for (let i = 0; i < poolSize; i++) {
      this._spawnAndEnqueue();
    }
  }

  /** Spawn one warm process and either give it to a waiting caller or enqueue it. */
  private _spawnAndEnqueue(): void {
    if (this.draining) return;

    const cp = spawn("gemini", this.baseArgs, {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Drain stderr so a full pipe buffer never stalls the subprocess.
    cp.stderr?.on("data", () => {});

    const wp: WarmProcess = { cp, pid: cp.pid, readyAt: Date.now() + this.startupMs };

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
      const idx = this.ready.findIndex((r) => r.wp === wp);
      if (idx !== -1) {
        this.ready.splice(idx, 1);
        if (!this.draining) {
          // Check for ENOENT (binary not found) — avoid infinite spawn loop
          if ((err as { code?: string } | undefined)?.code === "ENOENT") {
            this.consecutiveSpawnFailures++;
            if (this.consecutiveSpawnFailures >= WarmProcessPool.MAX_CONSECUTIVE_FAILURES) {
              process.stderr.write(
                `[gemini-cli-mcp] warm pool: gemini binary not found — ` +
                `pool disabled after ${WarmProcessPool.MAX_CONSECUTIVE_FAILURES} consecutive failures\n`
              );
              return; // stop replenishing
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
      this.consecutiveSpawnFailures = 0;
      waiter.resolve(wp);
      // Spawn a replacement so pool capacity is maintained.
      if (!this.draining) this._spawnAndEnqueue();
    } else {
      this.consecutiveSpawnFailures = 0;
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

    if (this.ready.length > 0) {
      const { wp, keepAliveInterval } = this.ready.shift()!;
      clearInterval(keepAliveInterval);
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
    });
  }

  /** Kill all ready processes and reject all pending waiters (graceful shutdown). */
  async drain(): Promise<void> {
    this.draining = true;

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
        try { wp.cp.kill("SIGTERM"); } catch { resolve(); }
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
}

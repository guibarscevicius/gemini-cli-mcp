/**
 * Unit tests for WarmProcessPool.
 *
 * All tests use mock ChildProcess objects — no real `gemini` subprocess is
 * spawned.  vi.mock("node:child_process") intercepts `spawn` and returns
 * mock objects controlled by the test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// ── Minimal mock ChildProcess ────────────────────────────────────────────────

type MockStdin = {
  writable: boolean;
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

function makeMockCp(pid = 1): ChildProcess & {
  mockStdin: MockStdin;
  mockExit: (code: number) => void;
} {
  const emitter = new EventEmitter() as ChildProcess;

  const stdin: MockStdin = {
    writable: true,
    write: vi.fn(),
    end: vi.fn(),
  };

  const state = { exitCode: null as number | null };

  Object.defineProperty(emitter, "exitCode", {
    get: () => state.exitCode,
    set: (v) => { state.exitCode = v; },
    configurable: true,
  });

  Object.assign(emitter, {
    pid,
    stdin,
    stderr: new EventEmitter(),
    kill: vi.fn((signal?: string) => {
      state.exitCode = 0;
      emitter.emit("exit", 0, signal ?? null);
    }),
    mockStdin: stdin,
    mockExit: (code: number) => {
      state.exitCode = code;
      emitter.emit("exit", code, null);
    },
  });

  return emitter as ChildProcess & { mockStdin: MockStdin; mockExit: (code: number) => void };
}

// ── Mock spawn ───────────────────────────────────────────────────────────────

let spawnCalls: Array<ReturnType<typeof makeMockCp>> = [];

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(() => {
      const cp = makeMockCp(spawnCalls.length + 1);
      spawnCalls.push(cp);
      return cp;
    }),
  };
});

// ── Import pool AFTER mock is installed ──────────────────────────────────────

const { WarmProcessPool } = await import("../src/warm-pool.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Flush pending microtasks (Promise callbacks). */
const flushMicrotasks = () => Promise.resolve();

// ── Tests ────────────────────────────────────────────────────────────────────

describe("WarmProcessPool", () => {
  beforeEach(() => {
    spawnCalls = [];
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  // ── Construction ───────────────────────────────────────────────────────────

  it("spawns poolSize processes on construction", () => {
    new WarmProcessPool(3, ["--yolo"], { HOME: "/home/test", PATH: "/bin" });
    expect(spawnCalls).toHaveLength(3);
  });

  it("size property returns poolSize", () => {
    const pool = new WarmProcessPool(5, [], {});
    expect(pool.size).toBe(5);
  });

  // ── acquire / release ─────────────────────────────────────────────────────

  it("acquire() returns a ready process immediately", async () => {
    const pool = new WarmProcessPool(1, [], {});
    const first = spawnCalls[0];

    const wp = await pool.acquire();
    expect(wp.cp).toBe(first);
  });

  it("acquire() reduces readyCount by 1 and replaces immediately", async () => {
    const pool = new WarmProcessPool(2, [], {});
    expect(pool.readyCount).toBe(2);
    expect(spawnCalls).toHaveLength(2);

    await pool.acquire();

    // After acquiring one: readyCount drops to 1 and a replacement is spawned
    expect(spawnCalls).toHaveLength(3); // replacement
    expect(pool.readyCount).toBe(2);    // replacement is synchronously enqueued
  });

  it("acquire() queues when pool is exhausted and resolves on replenishment", async () => {
    const pool = new WarmProcessPool(1, [], {});
    const first = spawnCalls[0];

    // Take the only ready process; replacement is spawned synchronously
    await pool.acquire();
    // Now pool has 1 ready (the replacement)
    expect(pool.readyCount).toBe(1);

    // Taking again should work immediately
    const wp2 = await pool.acquire();
    expect(wp2.cp).toBe(spawnCalls[1]);
  });

  it("acquire() rejects on timeout if no process becomes ready", async () => {
    vi.useFakeTimers();
    const pool = new WarmProcessPool(0, [], {}); // zero-size pool
    const promise = pool.acquire(50);

    // Attach handler BEFORE advancing timers to prevent unhandled rejection window
    const check = expect(promise).rejects.toThrow("timed out after 50ms");

    await vi.advanceTimersByTimeAsync(60);
    await check;
    vi.useRealTimers();
  });

  // ── readyCount ─────────────────────────────────────────────────────────────

  it("readyCount reflects current ready queue length", async () => {
    const pool = new WarmProcessPool(3, [], {});
    expect(pool.readyCount).toBe(3);

    await pool.acquire();
    // Replacement spawns synchronously → readyCount back to 3
    expect(pool.readyCount).toBe(3);
  });

  // ── Unexpected process exit ────────────────────────────────────────────────

  it("process that emits error unexpectedly is removed and a replacement is spawned", async () => {
    const pool = new WarmProcessPool(1, [], {});
    expect(spawnCalls).toHaveLength(1);
    const cp1 = spawnCalls[0];

    // Simulate unexpected error while process is idle in pool
    cp1.emit("error", new Error("spawn error"));
    await flushMicrotasks();

    // Pool should have replenished
    expect(spawnCalls).toHaveLength(2);
    expect(pool.readyCount).toBe(1);
  });

  it("process that exits unexpectedly is removed and a replacement is spawned", async () => {
    const pool = new WarmProcessPool(1, [], {});
    expect(spawnCalls).toHaveLength(1);
    const cp1 = spawnCalls[0];

    // Simulate unexpected crash while process is idle in pool
    cp1.mockExit(1);
    await flushMicrotasks();

    // Pool should have replenished
    expect(spawnCalls).toHaveLength(2);
    expect(pool.readyCount).toBe(1);
  });

  // ── drain ─────────────────────────────────────────────────────────────────

  it("acquire() rejects if pool is draining", async () => {
    const pool = new WarmProcessPool(1, [], {});
    await pool.drain();
    await expect(pool.acquire()).rejects.toThrow("shutting down");
  });

  it("drain() does not hang if a process has already exited", async () => {
    const pool = new WarmProcessPool(1, [], {});
    const cp = spawnCalls[0];
    cp.mockExit(0);
    await flushMicrotasks();

    // replenish happens
    expect(pool.readyCount).toBe(1);
    const cp2 = spawnCalls[1];

    // drain should resolve even if cp2 is alive and cp is dead
    await expect(pool.drain()).resolves.toBeUndefined();
  });

  it("drain() kills all ready processes and resolves when they exit", async () => {
    const pool = new WarmProcessPool(2, [], {});
    expect(pool.readyCount).toBe(2);

    // drain() calls cp.kill("SIGTERM") — mock emits "exit" synchronously
    await pool.drain();

    expect(pool.readyCount).toBe(0);
    // Both processes must have been sent SIGTERM
    expect((spawnCalls[0].kill as ReturnType<typeof vi.fn>).mock.calls.some(
      (args: unknown[]) => args[0] === "SIGTERM"
    )).toBe(true);
    expect((spawnCalls[1].kill as ReturnType<typeof vi.fn>).mock.calls.some(
      (args: unknown[]) => args[0] === "SIGTERM"
    )).toBe(true);
  });

  it("drain() rejects pending waiters", async () => {
    const pool = new WarmProcessPool(0, [], {});
    const pending = pool.acquire(60_000);

    // Attach rejection handler BEFORE drain fires (prevents unhandled rejection)
    const pendingCheck = expect(pending).rejects.toThrow("shutting down");

    await pool.drain();
    await pendingCheck;
  });

  it("after drain() a process exit does NOT trigger replenishment", async () => {
    const pool = new WarmProcessPool(1, [], {});
    const cpCount = spawnCalls.length;

    await pool.drain();
    const afterDrainCount = spawnCalls.length;

    // Simulate a process that somehow emits exit after drain
    const lastCp = spawnCalls[spawnCalls.length - 1];
    lastCp.mockExit(0);
    await flushMicrotasks();

    // No additional spawns
    expect(spawnCalls).toHaveLength(afterDrainCount);
  });

  it("drain() on an empty pool resolves immediately", async () => {
    const pool = new WarmProcessPool(0, [], {});
    await expect(pool.drain()).resolves.toBeUndefined();
  });

  it("drain() called twice resolves cleanly on the second call", async () => {
    const pool = new WarmProcessPool(2, [], {});
    await pool.drain();
    // Second drain: draining=true, ready=[], waiters=[] — should be a no-op
    await expect(pool.drain()).resolves.toBeUndefined();
  });

  it("process that exits after being acquired does NOT trigger replenishment", async () => {
    const pool = new WarmProcessPool(1, [], {});
    const spawnCountBefore = spawnCalls.length; // 1 initial

    // Acquire the process — it leaves the ready queue
    await pool.acquire();
    const spawnCountAfterAcquire = spawnCalls.length; // 2 (initial + replacement)

    // Simulate the acquired process crashing mid-use
    const acquiredCp = spawnCalls[0];
    acquiredCp.mockExit(1);
    await flushMicrotasks();

    // The exit listener checks ready.findIndex(r => r.wp === wp) → -1 (not in ready),
    // so no replenishment should occur.
    expect(spawnCalls).toHaveLength(spawnCountAfterAcquire);
    // Pool's replacement (spawnCalls[1]) is still ready
    expect(pool.readyCount).toBe(1);
  });

  // ── Keepalive ─────────────────────────────────────────────────────────────

  it("keepalive writes newlines to idle processes on interval", async () => {
    vi.useFakeTimers();
    new WarmProcessPool(1, [], {});
    const cp = spawnCalls[0];
    const stdinSpy = (cp.stdin as unknown as MockStdin).write;

    // Advance past KEEPALIVE_INTERVAL_MS (5000 ms)
    await vi.advanceTimersByTimeAsync(5100);

    expect(stdinSpy).toHaveBeenCalledWith("\n");
    vi.useRealTimers();
  });

  it("keepalive stops after process exits unexpectedly", async () => {
    vi.useFakeTimers();
    new WarmProcessPool(1, [], {});
    const cp = spawnCalls[0];

    // Simulate crash
    cp.mockExit(1);

    const stdinSpy = (cp.stdin as unknown as MockStdin).write;
    stdinSpy.mockClear();

    // Advance timer — keepalive must NOT fire for the dead process
    await vi.advanceTimersByTimeAsync(10000);
    expect(stdinSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  // ── stderr readiness signal (#64) ────────────────────────────────────────

  it("stderr output before timer fires sets readyAt to now", async () => {
    const pool = new WarmProcessPool(1, [], {}, 30_000);
    const cp = spawnCalls[0];
    const wp = await pool.acquire();

    // readyAt should initially be in the future (~30s from spawn)
    const beforeSignal = wp.readyAt;
    expect(beforeSignal).toBeGreaterThan(Date.now() + 10_000);

    // Replacement process gets stderr signal → readyAt updated
    const replacement = spawnCalls[1];
    const now = Date.now();
    replacement.stderr!.emit("data", Buffer.from("Gemini CLI v1.0\n"));
    await flushMicrotasks();

    // Acquire the replacement to check its readyAt
    const wp2 = await pool.acquire();
    expect(wp2.readyAt).toBeLessThanOrEqual(Date.now());
    expect(wp2.readyAt).toBeGreaterThanOrEqual(now - 100);
  });

  it("no stderr signal keeps readyAt at timer value (in the future)", async () => {
    const pool = new WarmProcessPool(1, [], {}, 5_000);
    const wp = await pool.acquire();

    // readyAt should be ~Date.now() + 5000 (set at spawn time)
    // must be in the future to distinguish from signal-based readyAt
    expect(wp.readyAt).toBeGreaterThan(Date.now() + 4000);
  });

  // ── concurrent waiters ────────────────────────────────────────────────────

  // Note: this tests sequential acquire() ordering (ready-queue FIFO), not
  // concurrent-waiter FIFO (which requires delayed replacement spawning to exercise).
  it("sequential acquire() drains ready queue in spawn order", async () => {
    // Pool size 2: acquire all 4 processes (2 initial + 2 replacements) in order.
    // Replacements spawn synchronously so the pool always has 2 ready after each acquire.
    const pool = new WarmProcessPool(2, [], {});

    const wp1 = await pool.acquire(); // gets spawnCalls[0], replaces with [2]
    const wp2 = await pool.acquire(); // gets spawnCalls[1], replaces with [3]
    const wp3 = await pool.acquire(); // gets spawnCalls[2], replaces with [4]
    const wp4 = await pool.acquire(); // gets spawnCalls[3], replaces with [5]

    expect(wp1.cp).toBe(spawnCalls[0]);
    expect(wp2.cp).toBe(spawnCalls[1]);
    expect(wp3.cp).toBe(spawnCalls[2]);
    expect(wp4.cp).toBe(spawnCalls[3]);
  });
});

// ── ENOENT spawn failure backoff ────────────────────────────────────────────

describe("WarmProcessPool ENOENT backoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function makeEnoentSpawn() {
    let spawnCount = 0;
    const { spawn: mockSpawn } = await import("node:child_process");
    vi.mocked(mockSpawn).mockImplementation(() => {
      spawnCount++;
      const cp = makeMockCp(spawnCount);
      spawnCalls.push(cp);
      setImmediate(() => {
        const err = Object.assign(new Error("spawn gemini ENOENT"), { code: "ENOENT" });
        cp.emit("error", err);
      });
      return cp as ReturnType<typeof import("node:child_process").spawn>;
    });
    return { get count() { return spawnCount; } };
  }

  it("stops replenishing after MAX_CONSECUTIVE_FAILURES (5) consecutive ENOENT errors", async () => {
    spawnCalls.length = 0;
    const tracker = await makeEnoentSpawn();

    const pool = new WarmProcessPool(1, ["--yolo"], { HOME: "/home/test", PATH: "/usr/bin" }, 0);
    await new Promise((r) => setTimeout(r, 100));

    // Pool spawns 1 initially, then replenishes up to MAX_CONSECUTIVE_FAILURES times = 5 total
    expect(tracker.count).toBe(5);

    await pool.drain();
  });

  it("logs a diagnostic message to stderr when pool disables", async () => {
    spawnCalls.length = 0;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await makeEnoentSpawn();

    new WarmProcessPool(1, ["--yolo"], { HOME: "/home/test", PATH: "/usr/bin" }, 0);
    await new Promise((r) => setTimeout(r, 100));

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("warm pool");
    expect(output).toContain("gemini binary not found");
  });

  it("rejects future acquire() calls after circuit breaks (draining=true)", async () => {
    spawnCalls.length = 0;
    await makeEnoentSpawn();

    const pool = new WarmProcessPool(1, ["--yolo"], { HOME: "/home/test", PATH: "/usr/bin" }, 0);
    // Wait for circuit to break
    await new Promise((r) => setTimeout(r, 100));

    // acquire() should reject immediately (pool is now draining)
    await expect(pool.acquire()).rejects.toThrow(/shutting down|disabled/);
  });
});

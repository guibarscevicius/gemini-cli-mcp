/**
 * Unit tests for the process-group helpers.
 *
 * The helpers branch on `process.platform`, captured at module load. To test
 * the Windows branch on a Linux CI, the test stubs `process.platform` BEFORE
 * importing the module via `vi.resetModules()` + dynamic import — the same
 * pattern documented in CLAUDE.md for module-level singletons.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// ── Mock spawn ───────────────────────────────────────────────────────────────

let lastSpawnArgs: { command: string; args: readonly string[]; options: Record<string, unknown> } | null = null;

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn((command: string, args: readonly string[], options: Record<string, unknown>) => {
      lastSpawnArgs = { command, args, options };
      return new EventEmitter() as ChildProcess;
    }),
  };
});

beforeEach(() => {
  lastSpawnArgs = null;
});

// ── Helper: build a mock ChildProcess with a controllable exitCode ───────────

function makeMockCp(opts: { pid?: number; exitCode?: number | null } = {}): ChildProcess {
  const cp = new EventEmitter() as ChildProcess;
  Object.assign(cp, {
    pid: opts.pid ?? 12345,
    exitCode: opts.exitCode ?? null,
    kill: vi.fn(),
  });
  return cp;
}

// ── POSIX branch ─────────────────────────────────────────────────────────────

describe("process-group helpers (POSIX)", () => {
  // The module's POSIX const is captured at load time; on Linux/macOS CI it
  // resolves to true without any stubbing.

  it("spawnInGroup passes detached:true on POSIX", async () => {
    const { spawnInGroup } = await import("../src/process-group.js");
    spawnInGroup("echo", ["hi"], { stdio: "ignore" });
    expect(lastSpawnArgs).not.toBeNull();
    expect(lastSpawnArgs!.options.detached).toBe(true);
    expect(lastSpawnArgs!.options.stdio).toBe("ignore");
  });

  it("killGroup signals the negative pid (process group) on POSIX", async () => {
    const { killGroup } = await import("../src/process-group.js");
    const cp = makeMockCp({ pid: 7777 });
    const spy = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      const ok = killGroup(cp, "SIGTERM");
      expect(ok).toBe(true);
      expect(spy).toHaveBeenCalledWith(-7777, "SIGTERM");
      // Falls back to cp.kill should NOT happen on POSIX
      expect((cp.kill as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("killGroup defaults the signal to SIGTERM", async () => {
    const { killGroup } = await import("../src/process-group.js");
    const cp = makeMockCp({ pid: 8888 });
    const spy = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      killGroup(cp);
      expect(spy).toHaveBeenCalledWith(-8888, "SIGTERM");
    } finally {
      spy.mockRestore();
    }
  });

  it("killGroup returns false (and never throws) when process.kill throws ESRCH", async () => {
    const { killGroup } = await import("../src/process-group.js");
    const cp = makeMockCp({ pid: 9999 });
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    try {
      expect(() => killGroup(cp, "SIGTERM")).not.toThrow();
      expect(killGroup(cp, "SIGTERM")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("killGroup returns false when the child has already exited", async () => {
    const { killGroup } = await import("../src/process-group.js");
    const cp = makeMockCp({ pid: 1, exitCode: 0 });
    const spy = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      expect(killGroup(cp)).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("killGroup returns false when pid is undefined (spawn never produced a PID)", async () => {
    const { killGroup } = await import("../src/process-group.js");
    const cp = new EventEmitter() as ChildProcess;
    Object.assign(cp, { pid: undefined, exitCode: null, kill: vi.fn() });
    const spy = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      expect(killGroup(cp)).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// ── Windows branch (simulated) ───────────────────────────────────────────────
//
// process.platform is captured at module load, so we stub it BEFORE the
// dynamic import. resetModules() ensures we get a fresh module evaluation
// where POSIX = false. After the test, restore platform and reset modules
// again so other suites see the real platform.

describe("process-group helpers (Windows simulated)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    vi.resetModules();
  });

  it("spawnInGroup omits detached on Windows", async () => {
    const { spawnInGroup } = await import("../src/process-group.js");
    spawnInGroup("cmd", ["/c", "echo hi"], { stdio: "ignore" });
    expect(lastSpawnArgs).not.toBeNull();
    expect(lastSpawnArgs!.options.detached).toBe(false);
  });

  it("killGroup falls back to cp.kill(signal) on Windows", async () => {
    const { killGroup } = await import("../src/process-group.js");
    const cp = makeMockCp({ pid: 4321 });
    const processKillSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      const ok = killGroup(cp, "SIGTERM");
      expect(ok).toBe(true);
      expect((cp.kill as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("SIGTERM");
      // process.kill MUST NOT be invoked on Windows — negative-PID groups don't exist.
      expect(processKillSpy).not.toHaveBeenCalled();
    } finally {
      processKillSpy.mockRestore();
    }
  });

  it("killGroup returns false when cp.kill throws on Windows", async () => {
    const { killGroup } = await import("../src/process-group.js");
    const cp = makeMockCp({ pid: 5555 });
    (cp.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("kill failed");
    });
    expect(() => killGroup(cp, "SIGTERM")).not.toThrow();
    expect(killGroup(cp, "SIGTERM")).toBe(false);
  });
});

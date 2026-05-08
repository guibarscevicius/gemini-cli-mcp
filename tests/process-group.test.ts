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

function makeMockCp(opts: {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
} = {}): ChildProcess {
  const cp = new EventEmitter() as ChildProcess;
  Object.assign(cp, {
    pid: opts.pid ?? 12345,
    exitCode: opts.exitCode ?? null,
    signalCode: opts.signalCode ?? null,
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
    const cp = makeMockCp({ pid: 12345, exitCode: 0 });
    const spy = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      expect(killGroup(cp)).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("killGroup returns false when the child was already signal-killed (signalCode set)", async () => {
    // Issue #96 follow-up: when a child is killed by signal, Node leaves
    // exitCode === null and sets signalCode. Without this guard, killGroup
    // would re-signal a group whose PID may have been recycled.
    const { killGroup } = await import("../src/process-group.js");
    const cp = makeMockCp({ pid: 12345, exitCode: null, signalCode: "SIGTERM" });
    const spy = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      expect(killGroup(cp)).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("killGroup refuses to signal pid <= 1 (catastrophic-kill guard)", async () => {
    // process.kill(-1, sig) signals every process the user can reach;
    // process.kill(-0, sig) signals this process group. Both would be devastating.
    const { killGroup } = await import("../src/process-group.js");
    const spy = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      expect(killGroup(makeMockCp({ pid: 0 }))).toBe(false);
      expect(killGroup(makeMockCp({ pid: 1 }))).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("killGroup logs unexpected (non-ESRCH) errno to stderr", async () => {
    // Real misconfigurations (EPERM, EINVAL) should never silently masquerade
    // as "child already exited" — drain would resolve while the group is alive.
    const { killGroup } = await import("../src/process-group.js");
    const cp = makeMockCp({ pid: 9999 });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    try {
      expect(killGroup(cp, "SIGTERM")).toBe(false);
      const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(output).toContain("EPERM");
      expect(output).toContain("group -9999");
    } finally {
      killSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("killGroup stays silent on ESRCH (group already gone is the expected race)", async () => {
    const { killGroup } = await import("../src/process-group.js");
    const cp = makeMockCp({ pid: 9999 });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    try {
      expect(killGroup(cp, "SIGTERM")).toBe(false);
      // ESRCH is the documented benign case; no log should be emitted.
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
      stderrSpy.mockRestore();
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

  it("spawnInGroup passes detached:false on Windows", async () => {
    // Note: the helper always sets `detached`. On POSIX it's true, on Windows
    // it's false. The test name reflects the assertion, not an "omitted" key.
    const { spawnInGroup } = await import("../src/process-group.js");
    spawnInGroup("cmd", ["/c", "echo hi"], { stdio: "ignore" });
    expect(lastSpawnArgs).not.toBeNull();
    expect(lastSpawnArgs!.options.detached).toBe(false);
    // On Windows the setpriv wrapper must never apply — process group / pdeathsig
    // are POSIX-only concepts and `setpriv` would not exist anyway.
    expect(lastSpawnArgs!.command).toBe("cmd");
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
    // Stub stderr so the (expected) unexpected-error log doesn't pollute test output.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => killGroup(cp, "SIGTERM")).not.toThrow();
      expect(killGroup(cp, "SIGTERM")).toBe(false);
      // Non-ESRCH errors are logged on Windows just as on POSIX.
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ── PR_SET_PDEATHSIG wrapper (issue #97) ─────────────────────────────────────
//
// On Linux, `setpriv --pdeathsig TERM -- <cmd>` makes the kernel deliver
// SIGTERM to the child the moment its parent dies — the safety net that runs
// even when our JS shutdown handler doesn't (SIGKILL, OOM, hard crash).
//
// `_setSetprivPathForTest` is a test-only export that overrides the
// module-level cached probe so we can deterministically simulate
// "setpriv installed" / "setpriv missing" without relying on the host.

describe("spawnInGroup setpriv pdeathsig wrap (Linux)", () => {
  const originalDisable = process.env.GEMINI_DISABLE_PDEATHSIG;

  beforeEach(() => {
    delete process.env.GEMINI_DISABLE_PDEATHSIG;
  });

  afterEach(async () => {
    if (originalDisable === undefined) delete process.env.GEMINI_DISABLE_PDEATHSIG;
    else process.env.GEMINI_DISABLE_PDEATHSIG = originalDisable;
    // Restore real probe result for any subsequent suite.
    const { _setSetprivPathForTest } = await import("../src/process-group.js");
    _setSetprivPathForTest(undefined);
  });

  it("wraps the command with `setpriv --pdeathsig TERM --` when setpriv is available on Linux", async () => {
    if (process.platform !== "linux") return; // simulator only — Linux semantics
    const { spawnInGroup, _setSetprivPathForTest } = await import("../src/process-group.js");
    _setSetprivPathForTest("/usr/bin/setpriv");
    spawnInGroup("gemini", ["--yolo"], { stdio: "ignore" });
    expect(lastSpawnArgs).not.toBeNull();
    expect(lastSpawnArgs!.command).toBe("/usr/bin/setpriv");
    expect(lastSpawnArgs!.args).toEqual(["--pdeathsig", "TERM", "--", "gemini", "--yolo"]);
    // Process-group leadership must still apply — the setpriv shim becomes the
    // group leader and the real CLI inherits the group, so killGroup() works.
    expect(lastSpawnArgs!.options.detached).toBe(true);
    // Caller-supplied options are preserved.
    expect(lastSpawnArgs!.options.stdio).toBe("ignore");
  });

  it("falls through (no wrap) when setpriv is not installed on Linux", async () => {
    if (process.platform !== "linux") return;
    const { spawnInGroup, _setSetprivPathForTest } = await import("../src/process-group.js");
    _setSetprivPathForTest(null);
    spawnInGroup("gemini", ["--yolo"], { stdio: "ignore" });
    expect(lastSpawnArgs!.command).toBe("gemini");
    expect(lastSpawnArgs!.args).toEqual(["--yolo"]);
    expect(lastSpawnArgs!.options.detached).toBe(true);
  });

  it("falls through (no wrap) when GEMINI_DISABLE_PDEATHSIG=1 even if setpriv is available", async () => {
    if (process.platform !== "linux") return;
    process.env.GEMINI_DISABLE_PDEATHSIG = "1";
    const { spawnInGroup, _setSetprivPathForTest } = await import("../src/process-group.js");
    _setSetprivPathForTest("/usr/bin/setpriv");
    spawnInGroup("gemini", ["--yolo"], { stdio: "ignore" });
    expect(lastSpawnArgs!.command).toBe("gemini");
    expect(lastSpawnArgs!.args).toEqual(["--yolo"]);
  });

  it("falls through (no wrap) when GEMINI_DISABLE_PDEATHSIG is set to any non-'1' value? (only '1' disables)", async () => {
    // Documents the contract: only the literal string "1" disables. "true",
    // "yes", or empty string DO NOT disable — matches the codebase convention
    // for env-var booleans (see GEMINI_POOL_ENABLED, GEMINI_STRUCTURED_LOGS).
    if (process.platform !== "linux") return;
    process.env.GEMINI_DISABLE_PDEATHSIG = "true"; // not "1"
    const { spawnInGroup, _setSetprivPathForTest } = await import("../src/process-group.js");
    _setSetprivPathForTest("/usr/bin/setpriv");
    spawnInGroup("gemini", ["--yolo"], { stdio: "ignore" });
    // "true" is not "1" — wrap remains active
    expect(lastSpawnArgs!.command).toBe("/usr/bin/setpriv");
  });
});

describe("spawnInGroup setpriv wrap is Linux-only", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    vi.resetModules();
  });

  it("does NOT wrap on macOS even if a setpriv path is configured", async () => {
    // setpriv (util-linux) does not exist on macOS; even hypothetically forcing
    // a path must not cause us to invoke a non-existent shim.
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    vi.resetModules();
    const { spawnInGroup, _setSetprivPathForTest } = await import("../src/process-group.js");
    _setSetprivPathForTest("/usr/bin/setpriv"); // hypothetical; should be ignored
    spawnInGroup("gemini", ["--yolo"], { stdio: "ignore" });
    expect(lastSpawnArgs!.command).toBe("gemini");
    expect(lastSpawnArgs!.args).toEqual(["--yolo"]);
    expect(lastSpawnArgs!.options.detached).toBe(true); // POSIX still applies
  });
});


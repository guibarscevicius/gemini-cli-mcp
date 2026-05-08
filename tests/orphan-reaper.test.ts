/**
 * Unit tests for the startup orphan reaper (issue #99).
 *
 * The reaper has two layers:
 *   1. Platform adapters (`listLinuxProcesses` / `listMacosProcesses`) — read
 *      the OS process table and yield a normalized {pid, ppid, uid, cmdline,
 *      ageSeconds}[].
 *   2. Business logic (`reapOrphans`) — filter by PPID==1 + UID + cmdline
 *      signature, SIGTERM all matches, wait, SIGKILL survivors, emit
 *      structured-log events.
 *
 * The business-logic tests inject a fake `listProcesses` and `kill` so they
 * never touch the real OS. The adapter tests mock `node:fs` (for /proc) and
 * `node:child_process` (for `ps`) at the module level.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetSubreaperCacheForTest, type OrphanProcess } from "../src/orphan-reaper.js";

// ── Module-level mocks for adapter tests ─────────────────────────────────────

const fsMock = vi.hoisted(() => ({
  readdirSync: vi.fn<(path: string) => string[]>(),
  readFileSync: vi.fn<(path: string, opts?: unknown) => string | Buffer>(),
}));
const execFileMock = vi.hoisted(() =>
  vi.fn<(
    cmd: string,
    args: string[],
    opts: unknown,
    cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
  ) => void>(),
);

vi.mock("node:fs", () => ({
  readdirSync: fsMock.readdirSync,
  readFileSync: fsMock.readFileSync,
}));
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

beforeEach(() => {
  fsMock.readdirSync.mockReset();
  fsMock.readFileSync.mockReset();
  execFileMock.mockReset();
});

afterEach(() => {
  // Module-level subreaper cache populates on first call to
  // getDefaultSubreaperPids() and persists for the rest of the process.
  // Without this reset, tests that omit `subreaperPids` (e.g. the default
  // regression guard) would see whatever the first such test cached,
  // making them order-dependent.
  _resetSubreaperCacheForTest();
});

// ── reapOrphans business logic ───────────────────────────────────────────────

describe("reapOrphans (business logic)", () => {
  it("returns {reaped:0,failed:0} when no candidate processes are found", async () => {
    const { reapOrphans } = await import("../src/orphan-reaper.js");
    const result = await reapOrphans({
      signature: ["--yolo"],
      listProcesses: async () => [],
      getuid: () => 1000,
      kill: () => true,
    });
    expect(result).toEqual({ reaped: 0, failed: 0 });
  });

  it("filters out processes with PPID !== 1 (only orphans are reaped)", async () => {
    // A live MCP server's own pool member has PPID == its own PID, never 1.
    // The strict PPID==1 filter is what makes module-load fire-and-forget safe.
    const { reapOrphans } = await import("../src/orphan-reaper.js");
    const killSpy = vi.fn(() => true);
    const result = await reapOrphans({
      signature: ["--yolo"],
      listProcesses: async () => [
        { pid: 1234, ppid: 999, uid: 1000, cmdline: "gemini --yolo", ageSeconds: 60 },
      ],
      getuid: () => 1000,
      kill: killSpy,
      forceKillDelayMs: 0,
    });
    expect(result).toEqual({ reaped: 0, failed: 0 });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("filters out processes belonging to other users (UID mismatch — never cross-user kill)", async () => {
    const { reapOrphans } = await import("../src/orphan-reaper.js");
    const killSpy = vi.fn(() => true);
    const result = await reapOrphans({
      signature: ["--yolo"],
      listProcesses: async () => [
        { pid: 1234, ppid: 1, uid: 2000, cmdline: "gemini --yolo", ageSeconds: 60 },
      ],
      getuid: () => 1000,
      kill: killSpy,
      forceKillDelayMs: 0,
    });
    expect(result).toEqual({ reaped: 0, failed: 0 });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("filters out processes whose cmdline does not contain the signature", async () => {
    const { reapOrphans } = await import("../src/orphan-reaper.js");
    const killSpy = vi.fn(() => true);
    const result = await reapOrphans({
      signature: ["--yolo", "--output-format", "stream-json"],
      listProcesses: async () => [
        { pid: 1234, ppid: 1, uid: 1000, cmdline: "node server.js --yolo", ageSeconds: 60 },
      ],
      getuid: () => 1000,
      kill: killSpy,
      forceKillDelayMs: 0,
    });
    // cmdline lacks "--output-format" and "stream-json" — does not match.
    expect(result).toEqual({ reaped: 0, failed: 0 });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("refuses to signal pid <= 1 even if filter logic somehow yielded one", async () => {
    // Catastrophic-kill guard mirrored from killGroup() in process-group.ts —
    // process.kill(0/1, sig) would hit every process the user can reach.
    const { reapOrphans } = await import("../src/orphan-reaper.js");
    const killSpy = vi.fn(() => true);
    await reapOrphans({
      signature: ["--yolo"],
      listProcesses: async () => [
        { pid: 1, ppid: 1, uid: 1000, cmdline: "gemini --yolo", ageSeconds: 0 },
        { pid: 0, ppid: 1, uid: 1000, cmdline: "gemini --yolo", ageSeconds: 0 },
      ],
      getuid: () => 1000,
      kill: killSpy,
      forceKillDelayMs: 0,
    });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("SIGTERMs matching orphans, then re-lists and SIGKILLs survivors", async () => {
    const { reapOrphans } = await import("../src/orphan-reaper.js");
    // Calls in order:
    //   listProcesses() → [1234, 5678]
    //   kill(1234, SIGTERM) → true
    //   kill(5678, SIGTERM) → true
    //   listProcesses() → [5678 only]  (1234 died from SIGTERM, well-behaved)
    //   kill(5678, SIGKILL) → true
    const orphan = (pid: number, age: number): OrphanProcess => ({
      pid,
      ppid: 1,
      uid: 1000,
      cmdline: "gemini --yolo",
      ageSeconds: age,
    });
    const listProcesses = vi
      .fn<() => Promise<OrphanProcess[]>>()
      .mockResolvedValueOnce([orphan(1234, 60), orphan(5678, 90)])
      .mockResolvedValueOnce([orphan(5678, 92)]); // only 5678 survives
    const callLog: Array<[number, NodeJS.Signals | 0]> = [];
    const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      callLog.push([pid, signal]);
      return true;
    });
    const result = await reapOrphans({
      signature: ["--yolo"],
      listProcesses,
      getuid: () => 1000,
      kill,
      forceKillDelayMs: 0,
    });
    expect(result).toEqual({ reaped: 2, failed: 0 });
    expect(callLog).toEqual([
      [1234, "SIGTERM"],
      [5678, "SIGTERM"],
      [5678, "SIGKILL"],
    ]);
    expect(listProcesses).toHaveBeenCalledTimes(2);
  });

  it("counts a process as failed when SIGKILL also fails", async () => {
    const { reapOrphans } = await import("../src/orphan-reaper.js");
    const orphan: OrphanProcess = {
      pid: 1234,
      ppid: 1,
      uid: 1000,
      cmdline: "gemini --yolo",
      ageSeconds: 60,
    };
    const listProcesses = vi
      .fn<() => Promise<OrphanProcess[]>>()
      .mockResolvedValueOnce([orphan])
      .mockResolvedValueOnce([orphan]); // still there → SIGKILL escalation
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === "SIGTERM") return true;
      if (signal === "SIGKILL") return false; // perms / weird kernel state
      return false;
    });
    const result = await reapOrphans({
      signature: ["--yolo"],
      listProcesses,
      getuid: () => 1000,
      kill,
      forceKillDelayMs: 0,
    });
    expect(result).toEqual({ reaped: 0, failed: 1 });
  });

  it("emits structured-log events per signal sent (SIGTERM and SIGKILL)", async () => {
    const { reapOrphans } = await import("../src/orphan-reaper.js");
    const events: Array<Record<string, unknown>> = [];
    const log = (e: Record<string, unknown>) => events.push(e);
    const orphan: OrphanProcess = {
      pid: 1234,
      ppid: 1,
      uid: 1000,
      cmdline: "gemini --yolo --output-format stream-json",
      ageSeconds: 120,
    };
    const listProcesses = vi
      .fn<() => Promise<OrphanProcess[]>>()
      .mockResolvedValueOnce([orphan])
      .mockResolvedValueOnce([orphan]); // survivor → triggers SIGKILL
    await reapOrphans({
      signature: ["--yolo"],
      listProcesses,
      getuid: () => 1000,
      kill: () => true,
      log,
      forceKillDelayMs: 0,
    });
    // One event for SIGTERM + one for SIGKILL escalation.
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      event: "orphan_reaped",
      pid: 1234,
      signal: "SIGTERM",
      age_seconds: 120,
    });
    expect(events[1]).toMatchObject({
      event: "orphan_reaped",
      pid: 1234,
      signal: "SIGKILL",
      age_seconds: 120,
    });
    // Each event has an ISO timestamp and the cmdline (truncated for safety).
    for (const e of events) {
      expect(typeof e.ts).toBe("string");
      expect(e.cmdline).toContain("gemini --yolo");
    }
  });

  it("absorbs per-pid errors silently (one bad pid does not abort the sweep)", async () => {
    const { reapOrphans } = await import("../src/orphan-reaper.js");
    const kill = vi.fn((pid: number, _signal: NodeJS.Signals | 0) => {
      if (pid === 1234) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      return true;
    });
    const result = await reapOrphans({
      signature: ["--yolo"],
      listProcesses: async () => [
        { pid: 1234, ppid: 1, uid: 1000, cmdline: "gemini --yolo", ageSeconds: 60 },
        { pid: 5678, ppid: 1, uid: 1000, cmdline: "gemini --yolo", ageSeconds: 90 },
      ],
      getuid: () => 1000,
      kill,
      forceKillDelayMs: 0,
    });
    // 1234 fails (kill threw on SIGTERM); 5678 succeeds.
    expect(result.reaped).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("does NOT SIGKILL a PID whose cmdline no longer matches (PID-reuse race protection)", async () => {
    // Between SIGTERM and SIGKILL the kernel may reuse a freed PID for an
    // unrelated same-user process. The re-list step must filter by signature
    // again, not just liveness, so SIGKILL never lands on the wrong target.
    const { reapOrphans } = await import("../src/orphan-reaper.js");
    const killSpy = vi.fn(() => true);
    const listProcesses = vi
      .fn<() => Promise<OrphanProcess[]>>()
      .mockResolvedValueOnce([
        { pid: 4242, ppid: 1, uid: 1000, cmdline: "gemini --yolo --output-format stream-json", ageSeconds: 60 },
      ])
      // Re-list: same PID is now an unrelated process (kernel reused 4242)
      .mockResolvedValueOnce([
        { pid: 4242, ppid: 1234, uid: 1000, cmdline: "vim notes.md", ageSeconds: 0 },
      ]);
    const result = await reapOrphans({
      signature: ["--yolo", "--output-format", "stream-json"],
      listProcesses,
      getuid: () => 1000,
      kill: killSpy,
      forceKillDelayMs: 0,
    });
    // SIGTERM goes out (we believed it was the orphan at the time), but
    // SIGKILL must not fire on the recycled PID.
    expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(4242, "SIGKILL");
    // Counted as reaped — either the original orphan died (best case) or we
    // dodged the race; both are correct outcomes for the user.
    expect(result).toEqual({ reaped: 1, failed: 0 });
  });

  it("logs adapter failure to stderr + structured log when listProcesses() rejects", async () => {
    // A fully-broken reaper that returned {0,0} silently would be invisible.
    // The sweep is a safety net; silent breakage of a safety net defeats it.
    const { reapOrphans } = await import("../src/orphan-reaper.js");
    const events: Array<Record<string, unknown>> = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await reapOrphans({
        signature: ["--yolo"],
        listProcesses: async () => {
          throw Object.assign(new Error("EACCES /proc"), { code: "EACCES" });
        },
        getuid: () => 1000,
        kill: () => true,
        log: (e) => events.push(e),
      });
      expect(result).toEqual({ reaped: 0, failed: 0 });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event: "orphan_reaper_list_failed" });
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const written = String(stderrSpy.mock.calls[0]?.[0] ?? "");
      expect(written).toContain("orphan reaper");
      expect(written).toContain("EACCES");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("skips SIGKILL escalation when the re-list call fails (conservative fallback)", async () => {
    // If the re-list itself fails, we cannot safely SIGKILL — we'd be
    // guessing about cmdline match. The sweep returns based on SIGTERM
    // success and the next startup catches any stragglers.
    const { reapOrphans } = await import("../src/orphan-reaper.js");
    const killSpy = vi.fn(() => true);
    const listProcesses = vi
      .fn<() => Promise<OrphanProcess[]>>()
      .mockResolvedValueOnce([
        { pid: 1234, ppid: 1, uid: 1000, cmdline: "gemini --yolo", ageSeconds: 60 },
      ])
      .mockRejectedValueOnce(new Error("re-list failed"));
    const result = await reapOrphans({
      signature: ["--yolo"],
      listProcesses,
      getuid: () => 1000,
      kill: killSpy,
      forceKillDelayMs: 0,
    });
    expect(killSpy).toHaveBeenCalledWith(1234, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(1234, "SIGKILL");
    expect(result).toEqual({ reaped: 1, failed: 0 });
  });

  it("returns {reaped:0,failed:0} on unsupported platforms (no listProcesses default)", async () => {
    const { reapOrphans } = await import("../src/orphan-reaper.js");
    // platform "win32" has no default listProcesses — must no-op.
    const result = await reapOrphans({
      signature: ["--yolo"],
      getuid: () => 1000,
      kill: () => true,
      platform: "win32",
    });
    expect(result).toEqual({ reaped: 0, failed: 0 });
  });

  it("reaps orphans whose PPID is a subreaper ancestor (e.g. WSL2 /init), not just PID 1", async () => {
    // WSL2 (and systemd-user / containers) install per-namespace subreapers
    // via prctl(PR_SET_CHILD_SUBREAPER). Orphans get reparented to the
    // nearest subreaper, NOT PID 1. Discovered during integration testing
    // on WSL2 where orphans landed at PID 748339 (the user-namespace init).
    const { reapOrphans } = await import("../src/orphan-reaper.js");
    const killSpy = vi.fn(() => true);
    const result = await reapOrphans({
      signature: ["--yolo"],
      // Caller injects the discovered subreaper set; in production this is
      // computed by walking /proc/self's parent chain for root-owned PIDs.
      subreaperPids: new Set<number>([1, 748339, 748338]),
      listProcesses: async () => [
        { pid: 875306, ppid: 748339, uid: 1000, cmdline: "node gemini --yolo", ageSeconds: 30 },
      ],
      getuid: () => 1000,
      kill: killSpy,
      forceKillDelayMs: 0,
    });
    expect(result.reaped).toBe(1);
    expect(killSpy).toHaveBeenCalledWith(875306, "SIGTERM");
  });

  it("does NOT reap a process whose PPID is a non-subreaper ancestor (sibling MCP server safety)", async () => {
    // A second MCP server's warm-pool members have PPID == that-MCP's PID,
    // which is user-owned (not root-owned), so it's NOT in the subreaper set.
    // The filter must spare them.
    const { reapOrphans } = await import("../src/orphan-reaper.js");
    const killSpy = vi.fn(() => true);
    const result = await reapOrphans({
      signature: ["--yolo"],
      subreaperPids: new Set<number>([1, 748339]), // only root-owned ancestors
      listProcesses: async () => [
        // PPID 858414 is some live user-owned process (e.g., another MCP server)
        { pid: 999999, ppid: 858414, uid: 1000, cmdline: "gemini --yolo", ageSeconds: 5 },
      ],
      getuid: () => 1000,
      kill: killSpy,
      forceKillDelayMs: 0,
    });
    expect(result).toEqual({ reaped: 0, failed: 0 });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("default subreaperPids set always contains PID 1 (regression guard for non-WSL2 systems)", async () => {
    // On bare Linux without subreapers, orphans go to PID 1. The default
    // subreaper-set discovery must always seed {1}, otherwise we'd miss
    // every orphan on a vanilla system.
    const { reapOrphans } = await import("../src/orphan-reaper.js");
    const killSpy = vi.fn(() => true);
    const result = await reapOrphans({
      signature: ["--yolo"],
      // No explicit subreaperPids — fall through to platform default.
      listProcesses: async () => [
        { pid: 1234, ppid: 1, uid: 1000, cmdline: "gemini --yolo", ageSeconds: 60 },
      ],
      getuid: () => 1000,
      kill: killSpy,
      forceKillDelayMs: 0,
    });
    expect(result.reaped).toBe(1);
    expect(killSpy).toHaveBeenCalledWith(1234, "SIGTERM");
  });
});

// ── listLinuxProcesses adapter (mocked /proc) ────────────────────────────────

describe("listLinuxProcesses (Linux /proc adapter)", () => {
  it("reads /proc, parses stat/status/cmdline, computes ageSeconds from uptime", async () => {
    fsMock.readdirSync.mockImplementation((path) => {
      if (path === "/proc") return ["1", "2", "1234", "5678", "self", "cpuinfo", "abc"];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    fsMock.readFileSync.mockImplementation((path) => {
      const p = String(path);
      if (p === "/proc/uptime") return "12345.67 9876.54";
      if (p === "/proc/1234/stat") {
        // Field 4 = ppid (1), field 22 = starttime in clock ticks since boot.
        // `(comm)` may contain spaces — we parse the LAST `)` to skip the comm.
        // 100 Hz default clock; starttime 1000 → process started 10s after boot
        // → age = 12345.67 - 10 = 12335.67 seconds (~3.4 hours).
        return `1234 (gemini) S 1 1234 1234 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 1000 0 0 18446744073709551615`;
      }
      if (p === "/proc/1234/status") {
        return "Name:\tgemini\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n";
      }
      if (p === "/proc/1234/cmdline") {
        // NUL-separated, NUL-terminated
        return "gemini\0--yolo\0--output-format\0stream-json\0";
      }
      // 5678 has a parenthesized comm with spaces — parsing must handle it.
      if (p === "/proc/5678/stat") {
        return `5678 (node (gemini)) S 999 5678 5678 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 2000 0 0`;
      }
      if (p === "/proc/5678/status") {
        return "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\n";
      }
      if (p === "/proc/5678/cmdline") {
        return "node\0/usr/bin/gemini\0--yolo\0";
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const { listLinuxProcesses } = await import("../src/orphan-reaper.js");
    const procs = await listLinuxProcesses();
    expect(procs).toEqual([
      {
        pid: 1234,
        ppid: 1,
        uid: 1000,
        cmdline: "gemini --yolo --output-format stream-json",
        ageSeconds: expect.any(Number),
      },
      {
        pid: 5678,
        ppid: 999,
        uid: 1000,
        cmdline: "node /usr/bin/gemini --yolo",
        ageSeconds: expect.any(Number),
      },
    ]);
    // Sanity: 1234 started 10s after boot, uptime 12345.67s → age ≈ 12335s
    expect(procs[0].ageSeconds).toBeGreaterThan(12000);
    expect(procs[0].ageSeconds).toBeLessThan(12500);
  });

  it("skips /proc entries that disappear mid-sweep (race with reaping)", async () => {
    fsMock.readdirSync.mockReturnValue(["1234", "5678"]);
    fsMock.readFileSync.mockImplementation((path) => {
      const p = String(path);
      if (p === "/proc/uptime") return "100.0 50.0";
      if (p.startsWith("/proc/1234/")) {
        // 1234 died between readdir and readFileSync — ENOENT
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      if (p === "/proc/5678/stat") return "5678 (gemini) S 1 5678 5678 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 50";
      if (p === "/proc/5678/status") return "Uid:\t1000\t1000\t1000\t1000\n";
      if (p === "/proc/5678/cmdline") return "gemini\0--yolo\0";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const { listLinuxProcesses } = await import("../src/orphan-reaper.js");
    const procs = await listLinuxProcesses();
    // 1234 silently skipped; 5678 returned.
    expect(procs).toHaveLength(1);
    expect(procs[0].pid).toBe(5678);
  });

  it("skips non-numeric /proc entries like 'self', 'cpuinfo', 'mounts'", async () => {
    fsMock.readdirSync.mockReturnValue(["self", "cpuinfo", "mounts", "1", "abc123"]);
    fsMock.readFileSync.mockImplementation((path) => {
      const p = String(path);
      if (p === "/proc/uptime") return "100.0 50.0";
      if (p === "/proc/1/stat") return "1 (init) S 0 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 0";
      if (p === "/proc/1/status") return "Uid:\t0\t0\t0\t0\n";
      if (p === "/proc/1/cmdline") return "init\0";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const { listLinuxProcesses } = await import("../src/orphan-reaper.js");
    const procs = await listLinuxProcesses();
    // Only the numeric "1" is processed.
    expect(procs).toHaveLength(1);
    expect(procs[0].pid).toBe(1);
  });
});

// ── listMacosProcesses adapter (mocked execFile ps) ──────────────────────────

describe("listMacosProcesses (macOS ps adapter)", () => {
  it("parses `ps -A` output into normalized OrphanProcess[]", async () => {
    execFileMock.mockImplementation((cmd, _args, _opts, cb) => {
      expect(cmd).toBe("ps");
      // Format: pid ppid uid etime command...
      const stdout = [
        "    1     0     0   01-12:00:00 /sbin/launchd",
        " 1234     1  1000      02:30 /usr/local/bin/gemini --yolo --output-format stream-json",
        " 5678   999  1000   1-00:00:00 node /usr/bin/gemini",
        "",
      ].join("\n");
      cb(null, stdout, "");
    });
    const { listMacosProcesses } = await import("../src/orphan-reaper.js");
    const procs = await listMacosProcesses();
    expect(procs).toHaveLength(3);
    expect(procs[1]).toEqual({
      pid: 1234,
      ppid: 1,
      uid: 1000,
      cmdline: "/usr/local/bin/gemini --yolo --output-format stream-json",
      ageSeconds: expect.any(Number),
    });
    // etime "02:30" = 2m30s = 150 seconds
    expect(procs[1].ageSeconds).toBe(150);
    // etime "1-00:00:00" = 1 day = 86400 seconds
    expect(procs[2].ageSeconds).toBe(86400);
    // etime "01-12:00:00" = 1d 12h = 86400 + 43200 = 129600 seconds
    expect(procs[0].ageSeconds).toBe(129600);
  });

  it("returns [] when ps fails (e.g. permission denied)", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(Object.assign(new Error("EACCES"), { code: "EACCES" }), "", "");
    });
    const { listMacosProcesses } = await import("../src/orphan-reaper.js");
    const procs = await listMacosProcesses();
    expect(procs).toEqual([]);
  });

  it("skips lines that don't match the expected pid/ppid/uid/etime/command shape", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const stdout = [
        "garbage line",
        "  PID  PPID   UID    ELAPSED COMMAND",  // header-like (would be filtered if `=` format misused)
        " 1234     1  1000      02:30 /usr/bin/gemini",
        "",
      ].join("\n");
      cb(null, stdout, "");
    });
    const { listMacosProcesses } = await import("../src/orphan-reaper.js");
    const procs = await listMacosProcesses();
    expect(procs).toHaveLength(1);
    expect(procs[0].pid).toBe(1234);
  });
});

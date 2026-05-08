/**
 * Startup orphan reaper (issue #99).
 *
 * Defense-in-depth for the warm-pool process leak (epic #96). Even with
 * process-group kill (#96/#100) and shim elimination (#98/#102), pre-existing
 * orphans from older MCP server versions and any future regression in the
 * kill path do not self-clean. On startup, before the warm pool spawns, we
 * sweep the process table for `gemini --yolo --output-format stream-json`
 * processes whose parent is in the subreaper set (PID 1 ∪ root-owned
 * ancestors of our PID — see `findLinuxSubreaperAncestors`) and whose owner
 * UID matches us, SIGTERM them, wait, then SIGKILL survivors.
 *
 * The strict subreaper-set membership filter is what makes module-load
 * fire-and-forget safe: our own newborn pool members have PPID == our PID,
 * never one of our root-owned ancestors, so the reaper cannot false-positive
 * on them even when running concurrently with pool startup.
 *
 * POSIX-only. Linux uses /proc; macOS uses `ps -A`. Windows: no-op (no
 * PID-1 reparenting; the underlying leak is POSIX-specific anyway).
 */

import { readdirSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";

export interface OrphanProcess {
  pid: number;
  ppid: number;
  uid: number;
  cmdline: string;
  ageSeconds: number | null;
}

export interface ReapOpts {
  signature: readonly string[];
  log?: (event: Record<string, unknown>) => void;
  getuid?: () => number;
  /** Override for tests. If omitted, picks a default by `platform`. */
  listProcesses?: () => Promise<OrphanProcess[]>;
  /** Override for tests. Defaults to {@link defaultKill}. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => boolean;
  /** Time between SIGTERM sweep and SIGKILL escalation. Default 2000. */
  forceKillDelayMs?: number;
  /** Override for tests. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /**
   * PIDs that the kernel may reparent our orphans to. Defaults to {1} ∪
   * (root-owned ancestors of process.pid on Linux). Override for tests or
   * environments where automatic discovery is wrong.
   *
   * Why this is not just {1}: since Linux 3.4 a process can register as
   * a "child subreaper" via prctl(PR_SET_CHILD_SUBREAPER); the kernel then
   * reparents orphaned descendants of that process to the subreaper instead
   * of PID 1. WSL2's per-namespace `/init`, systemd-user, container
   * runtimes, and some shells all do this. So orphans can land at any
   * subreaper above us — not just PID 1.
   */
  subreaperPids?: ReadonlySet<number>;
}

export interface ReapResult {
  reaped: number;
  failed: number;
}

/** Default `kill` impl: returns true on success, false on any failure. */
function defaultKill(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns the platform-default process source, or `null` if unsupported. */
function defaultListProcesses(platform: NodeJS.Platform): (() => Promise<OrphanProcess[]>) | null {
  if (platform === "linux") return listLinuxProcesses;
  if (platform === "darwin") return listMacosProcesses;
  return null;
}

function matchesSignature(cmdline: string, signature: readonly string[]): boolean {
  if (signature.length === 0) return false;
  // The joined signature is what we expect to see verbatim in cmdline. Real
  // gemini-CLI cmdlines have these args in order separated by single spaces.
  return cmdline.includes(signature.join(" "));
}

/**
 * Walk our own ancestor chain on Linux and collect PIDs whose owner UID is 0
 * (root). Those are the candidates the kernel may have reparented our orphans
 * to via the subreaper mechanism. PID 1 is always added.
 *
 * Non-root ancestors (user shell, the host that spawned us) are deliberately
 * skipped. Root-ownership is a practical proxy for "system-level subreaper":
 * any process can call prctl(PR_SET_CHILD_SUBREAPER) regardless of UID, but
 * the subreapers we actually want to handle (systemd PID 1, WSL2 /init,
 * systemd-user@<root>, container runtimes) are root-owned in practice.
 * Including user-owned ancestors would risk killing sibling MCP-server
 * warm-pool members spawned by the same shell or process tree.
 *
 * Returns a set with `1` always present; on non-Linux returns just `{1}`.
 */
function findLinuxSubreaperAncestors(): Set<number> {
  const result = new Set<number>([1]);
  if (process.platform !== "linux") return result;

  let cursor = process.pid;
  // Bounded by the depth of any plausible Linux process tree; the guard is
  // belt-and-suspenders against /proc returning a stale or malformed PPID.
  for (let i = 0; i < 64; i++) {
    let parent: number;
    let parentUid: number;
    try {
      const stat = readFileSync(`/proc/${cursor}/stat`, "utf8");
      const lastParen = stat.lastIndexOf(")");
      if (lastParen < 0) break;
      const after = stat.slice(lastParen + 1).trim().split(/\s+/);
      parent = Number.parseInt(after[1] ?? "", 10);
      if (!Number.isFinite(parent) || parent <= 1) {
        if (parent === 1) result.add(1);
        break;
      }
      const status = readFileSync(`/proc/${parent}/status`, "utf8");
      const m = /^Uid:\s+(\d+)/m.exec(status);
      parentUid = m ? Number.parseInt(m[1] ?? "", 10) : NaN;
    } catch {
      break;
    }
    if (parentUid === 0) result.add(parent);
    cursor = parent;
  }
  return result;
}

let _subreaperCache: Set<number> | null = null;
function getDefaultSubreaperPids(): ReadonlySet<number> {
  if (_subreaperCache === null) _subreaperCache = findLinuxSubreaperAncestors();
  return _subreaperCache;
}

/** @internal Test-only: clear the cached subreaper set so the next call re-walks /proc. */
export function _resetSubreaperCacheForTest(): void {
  _subreaperCache = null;
}

export async function reapOrphans(opts: ReapOpts): Promise<ReapResult> {
  const platform = opts.platform ?? process.platform;
  const list = opts.listProcesses ?? defaultListProcesses(platform);
  if (list === null) return { reaped: 0, failed: 0 };

  const myUid = (opts.getuid ?? process.getuid?.bind(process) ?? (() => -1))();
  const kill = opts.kill ?? defaultKill;
  const log = opts.log ?? (() => {});
  const forceKillDelayMs = opts.forceKillDelayMs ?? 2000;

  let candidates: OrphanProcess[];
  try {
    candidates = await list();
  } catch (err: unknown) {
    // Adapter failure (filesystem race, ps not on PATH, etc.) — no-op the
    // sweep but surface the failure. A fully-broken reaper that returns 0/0
    // would be invisible; the sweep is a safety net and silent breakage of
    // a safety net defeats the point.
    const msg = err instanceof Error ? err.message : String(err);
    log({
      ts: new Date().toISOString(),
      event: "orphan_reaper_list_failed",
      error: msg,
    });
    process.stderr.write(
      `[gemini-cli-mcp] orphan reaper: process list failed (${msg}) — sweep skipped\n`,
    );
    return { reaped: 0, failed: 0 };
  }

  // Filter — PPID is in the subreaper set (PID 1 + root-owned ancestors of us)
  // + UID + cmdline + catastrophic-kill guard. The strict subreaper-set check
  // is what makes module-load fire-and-forget safe: our own newborn pool
  // members have PPID == our PID, never one of our root-owned ancestors.
  const subreaperPids = opts.subreaperPids ?? getDefaultSubreaperPids();
  const matches = candidates.filter(
    (p) =>
      p.pid > 1 &&
      subreaperPids.has(p.ppid) &&
      p.uid === myUid &&
      matchesSignature(p.cmdline, opts.signature),
  );

  if (matches.length === 0) return { reaped: 0, failed: 0 };

  // Phase 1 — SIGTERM all. Per-pid errors are silently absorbed via tryKill.
  // We track which pids we successfully signaled so we know whom to re-check.
  const signaled = new Map<number, OrphanProcess>();
  for (const p of matches) {
    const ok = tryKill(kill, p.pid, "SIGTERM");
    log({
      ts: new Date().toISOString(),
      event: "orphan_reaped",
      pid: p.pid,
      age_seconds: p.ageSeconds,
      cmdline: p.cmdline.slice(0, 200),
      signal: "SIGTERM",
      ok,
    });
    if (ok) signaled.set(p.pid, p);
  }

  // Phase 2 — wait, then re-verify each survivor before SIGKILL.
  if (forceKillDelayMs > 0) await sleep(forceKillDelayMs);

  let reaped = 0;
  let failed = matches.length - signaled.size; // SIGTERM-failed pids count as failed

  // Re-fetch the process table so SIGKILL only fires on PIDs that still
  // match the original UID + cmdline signature. Without this, the kernel
  // could have reused a SIGTERMed PID during the wait window for an
  // unrelated same-user process, and our SIGKILL would hit the wrong
  // target. Re-listing is cheap (small table on a startup-time sweep) and
  // the safety win is unrecoverable if we get it wrong.
  let surviving: Map<number, OrphanProcess>;
  try {
    const refreshed = await list();
    surviving = new Map(
      refreshed
        .filter(
          (p) =>
            signaled.has(p.pid) &&
            p.uid === myUid &&
            matchesSignature(p.cmdline, opts.signature),
        )
        .map((p) => [p.pid, p]),
    );
  } catch {
    // Re-list failed mid-sweep — skip SIGKILL escalation entirely. SIGTERM
    // is the typical happy path for the gemini CLI; stragglers (if any) are
    // caught on the next startup sweep. Counting all signaled as `reaped`
    // would overstate; counting all as `failed` would understate. Report
    // the SIGTERM ack count, which is the only thing we can verify.
    return { reaped: signaled.size, failed };
  }

  for (const p of signaled.values()) {
    if (!surviving.has(p.pid)) {
      // Either the process is gone (SIGTERM worked — happy path) or its
      // PID was reused by an unrelated process (race we just dodged). In
      // both cases, do NOT escalate to SIGKILL. Counting as reaped is
      // accurate for the happy path and conservative for the race.
      reaped++;
      continue;
    }
    const survivor = surviving.get(p.pid)!;
    const killed = tryKill(kill, p.pid, "SIGKILL");
    log({
      ts: new Date().toISOString(),
      event: "orphan_reaped",
      pid: p.pid,
      age_seconds: survivor.ageSeconds,
      cmdline: survivor.cmdline.slice(0, 200),
      signal: "SIGKILL",
      ok: killed,
    });
    if (killed) reaped++;
    else failed++;
  }

  return { reaped, failed };
}

function tryKill(
  kill: (pid: number, signal: NodeJS.Signals | 0) => boolean,
  pid: number,
  signal: NodeJS.Signals | 0,
): boolean {
  try {
    return kill(pid, signal);
  } catch {
    return false;
  }
}

// ── Linux /proc adapter ──────────────────────────────────────────────────────

export async function listLinuxProcesses(): Promise<OrphanProcess[]> {
  const uptimeSeconds = readUptimeSeconds();
  const clockTicks = 100; // sysconf(_SC_CLK_TCK) — 100 on every modern Linux

  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }

  const out: OrphanProcess[] = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const proc = readLinuxProcess(pid, uptimeSeconds, clockTicks);
      if (proc !== null) out.push(proc);
    } catch {
      // Process disappeared mid-sweep, or unreadable — skip silently.
    }
  }
  return out;
}

function readUptimeSeconds(): number | null {
  try {
    const raw = readFileSync("/proc/uptime", "utf8");
    const first = raw.split(/\s+/)[0];
    const n = Number.parseFloat(first ?? "");
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function readLinuxProcess(
  pid: number,
  uptimeSeconds: number | null,
  clockTicks: number,
): OrphanProcess | null {
  // /proc/[pid]/stat: pid (comm) state ppid pgrp ... starttime ...
  // The `comm` field can contain spaces and parens, so we anchor on the LAST
  // `)` and parse the space-separated fields that follow it.
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const lastParen = stat.lastIndexOf(")");
  if (lastParen < 0) return null;
  const after = stat.slice(lastParen + 1).trim().split(/\s+/);
  // After the comm, fields are: state(0) ppid(1) pgrp(2) ... starttime(19)
  const ppid = Number.parseInt(after[1] ?? "", 10);
  const starttimeTicks = Number.parseInt(after[19] ?? "", 10);
  if (!Number.isFinite(ppid)) return null;

  // /proc/[pid]/status: line "Uid:\treal\teffective\tsavedset\tfs"
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const uidMatch = /^Uid:\s+(\d+)/m.exec(status);
  const uid = uidMatch ? Number.parseInt(uidMatch[1] ?? "", 10) : NaN;
  if (!Number.isFinite(uid)) return null;

  // /proc/[pid]/cmdline: NUL-separated, NUL-terminated args.
  const cmdlineRaw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
  const cmdline = cmdlineRaw.replace(/\0+$/, "").replace(/\0/g, " ");

  let ageSeconds: number | null = null;
  if (uptimeSeconds !== null && Number.isFinite(starttimeTicks)) {
    const startSeconds = starttimeTicks / clockTicks;
    const age = uptimeSeconds - startSeconds;
    ageSeconds = age >= 0 ? Math.round(age) : null;
  }

  return { pid, ppid, uid, cmdline, ageSeconds };
}

// ── macOS ps adapter ─────────────────────────────────────────────────────────

export async function listMacosProcesses(): Promise<OrphanProcess[]> {
  // `=` suppresses headers; the trailing `command=` captures the full command
  // line including spaces (must be the last column for that to work).
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,uid=,etime=,command="],
      { timeout: 2000, maxBuffer: 4 * 1024 * 1024 },
      (err, out) => {
        if (err) resolve("");
        else resolve(out);
      },
    );
  });

  const out: OrphanProcess[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    // Parse leading 4 numeric/dashed columns + remainder as command.
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:\-]+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    const pid = Number.parseInt(m[1] ?? "", 10);
    const ppid = Number.parseInt(m[2] ?? "", 10);
    const uid = Number.parseInt(m[3] ?? "", 10);
    const ageSeconds = parseEtime(m[4] ?? "");
    const cmdline = (m[5] ?? "").trim();
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(uid)) continue;
    out.push({ pid, ppid, uid, cmdline, ageSeconds });
  }
  return out;
}

/**
 * Parses a `ps -o etime` value to seconds. Format is `[[DD-]HH:]MM:SS`.
 * Examples: "02:30" → 150, "1:23:45" → 5025, "1-00:00:00" → 86400.
 */
function parseEtime(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (m === null) return null;
  const days = m[1] ? Number.parseInt(m[1], 10) : 0;
  const hours = m[2] ? Number.parseInt(m[2], 10) : 0;
  const minutes = Number.parseInt(m[3] ?? "0", 10);
  const seconds = Number.parseInt(m[4] ?? "0", 10);
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

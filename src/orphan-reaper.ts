/**
 * Startup orphan reaper (issue #99).
 *
 * Defense-in-depth for the warm-pool process leak (epic #96). Even with
 * process-group kill (#96/#100) and shim elimination (#98/#102), pre-existing
 * orphans from older MCP server versions and any future regression in the
 * kill path do not self-clean. On startup, before the warm pool spawns, we
 * sweep the process table for `gemini --yolo --output-format stream-json`
 * processes whose parent is PID 1 (orphaned) and whose owner UID matches us,
 * SIGTERM them, wait, then SIGKILL survivors.
 *
 * The strict PPID==1 filter is what makes module-load fire-and-forget safe:
 * our own newborn pool members have PPID == our PID until we ourselves die,
 * so the reaper cannot false-positive on them even when running concurrently
 * with pool startup.
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
  } catch {
    // Adapter failure (filesystem race, ps not on PATH, etc.) — silently no-op.
    return { reaped: 0, failed: 0 };
  }

  // Filter — strict PPID==1 + UID + cmdline + catastrophic-kill guard.
  const matches = candidates.filter(
    (p) =>
      p.pid > 1 &&
      p.ppid === 1 &&
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

  // Phase 2 — wait, then check for survivors and SIGKILL them.
  if (forceKillDelayMs > 0) await sleep(forceKillDelayMs);

  let reaped = 0;
  let failed = matches.length - signaled.size; // SIGTERM-failed pids count as failed

  for (const p of signaled.values()) {
    const stillAlive = tryKill(kill, p.pid, 0);
    if (!stillAlive) {
      reaped++;
      continue;
    }
    const killed = tryKill(kill, p.pid, "SIGKILL");
    log({
      ts: new Date().toISOString(),
      event: "orphan_reaped",
      pid: p.pid,
      age_seconds: p.ageSeconds,
      cmdline: p.cmdline.slice(0, 200),
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

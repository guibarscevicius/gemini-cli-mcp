/**
 * Process-group spawn / signal helpers (issue #96).
 *
 * The npm-published `gemini` binary is a Node shim that re-spawns Node with
 * `--max-old-space-size=15890` to run the real CLI. So each warm-pool slot is
 * **two** OS processes: shim (immediate child) → real CLI (grandchild).
 *
 * `cp.kill(sig)` only signals the immediate child. The grandchild is
 * reparented to PID 1 and survives, leaking ~poolSize processes per server
 * lifecycle.
 *
 * Fix on POSIX: spawn each child as a process-group leader (`detached: true`)
 * and signal the entire group via `process.kill(-pid, sig)`. The kernel then
 * delivers the signal to every member of the group, including grandchildren.
 *
 * Windows is intentionally left on single-PID kill behavior:
 *   • `detached: true` opens a visible console window per child
 *     (nodejs/node#21825) — `windowsHide` does not work in combination.
 *   • The PID-1 reparenting that creates the leak is POSIX-specific; Windows
 *     uses Job Objects with different lifecycle semantics.
 */

import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";

const POSIX = process.platform !== "win32";

/**
 * Spawn a child as a process-group leader on POSIX so that the entire group
 * (immediate child + grandchildren spawned by an npm shim) can be signaled
 * together via {@link killGroup}.
 *
 * Caller MUST NOT call `cp.unref()` — the parent must continue to track the
 * child's `exit` and `close` events.
 */
export function spawnInGroup(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(command, args, { ...options, detached: POSIX });
}

/**
 * Send `signal` to the entire process group on POSIX, falling back to a
 * single-PID kill on Windows.
 *
 * Returns `true` if the signal was delivered, `false` if the child has
 * already exited, has no PID yet, or the signal call threw (e.g. ESRCH when
 * the group is already gone). Never throws.
 */
export function killGroup(cp: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): boolean {
  if (cp.exitCode !== null) return false;
  const pid = cp.pid;
  if (pid === undefined) return false;
  try {
    if (POSIX) process.kill(-pid, signal);
    else cp.kill(signal);
    return true;
  } catch {
    return false;
  }
}

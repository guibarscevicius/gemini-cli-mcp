/**
 * Process-group spawn / signal helpers (issue #96).
 *
 * Originally @google/gemini-cli ran as two Node processes per slot — the npm
 * entry point would self-relaunch with `--max-old-space-size=<50% RAM>` for a
 * larger heap, leaving the second process as a grandchild that survived
 * `cp.kill(sig)` because the signal only reached the immediate child.
 *
 * Issue #98 eliminates the self-relaunch by setting `GEMINI_CLI_NO_RELAUNCH=true`
 * in the spawn env (see `GEMINI_CHILD_ENV_OVERRIDES` in cli-capabilities.ts), so
 * the warm-pool is now one Node process per slot.
 *
 * We still spawn as a process-group leader and signal the full group on
 * shutdown: the CLI itself may fork tool subprocesses (shell tools, MCP
 * subservers) that would otherwise be reparented to PID 1 if we only signaled
 * the CLI's PID. POSIX-only — Windows uses Job Objects with different
 * lifecycle semantics.
 */

import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";

const POSIX = process.platform !== "win32";

/**
 * Spawn a child as a process-group leader on POSIX so that the entire group
 * (immediate child + grandchildren spawned by an npm shim) can be signaled
 * together via {@link killGroup}.
 *
 * The `detached` option is omitted from the parameter type because this helper
 * sets it unconditionally — letting a caller pass `detached: false` would
 * silently undo the entire point of the wrapper.
 *
 * Do not call `cp.unref()` on the returned handle: the `exit`/`error`
 * listeners that pool replenishment relies on would be silently dropped if
 * the process is unreffed.
 */
export function spawnInGroup(
  command: string,
  args: readonly string[],
  options: Omit<SpawnOptions, "detached">,
): ChildProcess {
  return spawn(command, args, { ...options, detached: POSIX });
}

/**
 * Send `signal` to the entire process group on POSIX, falling back to a
 * single-PID kill on Windows. Never throws.
 *
 * Returns `true` if the signal was delivered. Returns `false` when:
 *   • the child has already exited or been signaled (`exitCode`/`signalCode` set),
 *   • `cp.pid` is undefined (spawn failed before the kernel allocated a PID),
 *   • `pid` is `0` or `1` — catastrophic-kill guard: `process.kill(-1, sig)`
 *     would hit every process the user can reach, `-0` would hit this group,
 *   • the underlying syscall threw. `ESRCH` (group already gone) is silent;
 *     any other errno (`EPERM`, `EINVAL`, …) is logged to stderr so real
 *     misconfiguration is not masked as a benign race.
 */
export function killGroup(cp: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): boolean {
  if (cp.exitCode !== null || cp.signalCode !== null) return false;
  const pid = cp.pid;
  if (pid === undefined || pid <= 1) return false;
  try {
    if (POSIX) process.kill(-pid, signal);
    else cp.kill(signal);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== "ESRCH") {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[gemini-cli-mcp] killGroup: unexpected ${code ?? "error"} sending ${signal} to ${POSIX ? `group -${pid}` : `pid ${pid}`}: ${msg}\n`,
      );
    }
    return false;
  }
}

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
 *
 * Issue #97 layers a kernel-level safety net on top: on Linux we wrap the
 * spawn with `setpriv --pdeathsig TERM --` so the kernel delivers SIGTERM to
 * the child the moment its parent dies. That covers the failure modes the
 * graceful shutdown path can't (SIGKILL, OOM, hard crash).
 */

import { spawn, execFileSync, type SpawnOptions, type ChildProcess } from "node:child_process";

const POSIX = process.platform !== "win32";

// ── PR_SET_PDEATHSIG via setpriv (issue #97) ─────────────────────────────────
//
// `setpriv --pdeathsig TERM --` (util-linux ≥ 2.33) sets the kernel
// PR_SET_PDEATHSIG flag on the child. When the parent dies for any reason
// (graceful exit, SIGKILL, OOM, hard crash), the kernel synchronously
// delivers SIGTERM to the child — no userspace shutdown handler required.
//
// Probed once at module load. Sync probe is fine: `setpriv --version` runs
// in <5ms on every Linux distro that ships it, and `spawnInGroup` itself is
// sync, so there's no convenient async hook anyway. Probe failure (timeout,
// ENOENT, non-Linux) yields `null` and the wrapper falls through cleanly.

function detectSetpriv(): string | null {
  if (process.platform !== "linux") return null;
  try {
    execFileSync("setpriv", ["--version"], { timeout: 200, stdio: "ignore" });
    return "setpriv";
  } catch {
    return null;
  }
}

let setprivPath: string | null = detectSetpriv();

/**
 * @internal Test-only: override the cached setpriv probe result.
 * Pass a string to simulate "setpriv installed at this path", `null` to
 * simulate "setpriv not installed", or `undefined` to re-run the real probe.
 */
export function _setSetprivPathForTest(path: string | null | undefined): void {
  setprivPath = path === undefined ? detectSetpriv() : path;
}

function shouldWrapWithSetpriv(): boolean {
  // Linux-only (no PR_SET_PDEATHSIG on macOS / BSD; Windows uses Job Objects).
  // The escape hatch matches the codebase convention: only the literal "1"
  // disables — anything else (incl. "true", "yes", empty) is treated as opt-in.
  return (
    setprivPath !== null &&
    process.platform === "linux" &&
    process.env.GEMINI_DISABLE_PDEATHSIG !== "1"
  );
}

/**
 * Spawn a child as a process-group leader on POSIX so that the entire group
 * (CLI process + tool subprocesses or MCP subservers it may fork) can be
 * signaled together via {@link killGroup}.
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
  if (shouldWrapWithSetpriv()) {
    // The setpriv shim becomes the group leader and the real CLI inherits the
    // group, so killGroup() still reaches both. The shim is ~one extra exec
    // layer (negligible vs. the CLI's multi-second startup).
    return spawn(
      setprivPath!,
      ["--pdeathsig", "TERM", "--", command, ...args],
      { ...options, detached: POSIX },
    );
  }
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

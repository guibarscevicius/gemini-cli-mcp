export function parseIdleShutdownMs(rawValue: string | undefined): number {
  if (rawValue === undefined) {
    return 0;
  }

  const normalized = rawValue.trim();
  if (normalized === "") {
    return 0;
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      `GEMINI_MCP_IDLE_SHUTDOWN_MS must be a non-negative integer, got "${rawValue}"`
    );
  }

  const parsed = Number.parseInt(normalized, 10);
  return parsed;
}

export class IdleShutdownController {
  private activeJobs = 0;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly idleTimeoutMs: number,
    private readonly onIdle: () => void | Promise<void>
  ) {}

  start(): void {
    this.started = true;
    this.reschedule();
  }

  stop(): void {
    this.started = false;
    this.clearTimer();
  }

  noteActivity(): void {
    this.reschedule();
  }

  updateActiveJobs(activeJobs: number): void {
    this.activeJobs = activeJobs;
    this.reschedule();
  }

  private reschedule(): void {
    if (!this.started || this.idleTimeoutMs === 0) {
      this.clearTimer();
      return;
    }

    if (this.activeJobs > 0) {
      this.clearTimer();
      return;
    }

    this.clearTimer();
    this.timer = setTimeout(() => {
      if (!this.started || this.activeJobs > 0) {
        return;
      }
      Promise.resolve(this.onIdle()).catch((err: unknown) => {
        process.stderr.write(
          `[gemini-cli-mcp] idle shutdown callback failed: ${err instanceof Error ? err.message : String(err)}\n`
        );
      });
    }, this.idleTimeoutMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

export class SemaphoreTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Gemini request timed out after ${timeoutMs}ms waiting for a concurrency slot`);
    this.name = "SemaphoreTimeoutError";
  }
}

export class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private readonly max: number) {}

  acquire(timeoutMs?: number): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const slot = () => {
        if (timer) clearTimeout(timer);
        this.running++;
        resolve();
      };

      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const index = this.queue.indexOf(slot);
          if (index !== -1) {
            this.queue.splice(index, 1);
            reject(new SemaphoreTimeoutError(timeoutMs));
          }
        }, timeoutMs);
      }

      this.queue.push(slot);
    });
  }

  release(): void {
    if (this.running <= 0) return; // defensive: should never be called without a matching acquire
    this.running--;
    this.queue.shift()?.();
  }

  stats(): { active: number; queued: number } {
    return { active: this.running, queued: this.queue.length };
  }
}

export const MAX_CONCURRENT = parseInt(process.env.GEMINI_MAX_CONCURRENT ?? "2", 10);
if (!Number.isFinite(MAX_CONCURRENT) || MAX_CONCURRENT < 1) {
  throw new Error(
    `GEMINI_MAX_CONCURRENT must be a positive integer, got "${process.env.GEMINI_MAX_CONCURRENT}". ` +
      "Use 1 for strict serialization or omit to use the default (2)."
  );
}
export const QUEUE_TIMEOUT_MS = parseInt(process.env.GEMINI_QUEUE_TIMEOUT_MS ?? "60000", 10);
export const semaphore = new Semaphore(MAX_CONCURRENT);

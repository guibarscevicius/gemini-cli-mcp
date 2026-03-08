/**
 * Maps MCP requestId -> jobId for the notifications/cancelled pipeline.
 *
 * Entries are registered when a job starts (registerRequest) and cleared in
 * three ways: normal completion (.then in ask-gemini/gemini-reply), job failure
 * (.catch), and GC sweep (unregisterByJobId, called by sweepExpiredJobs).
 *
 * Keys are normalised to strings so that numeric JSON-RPC ids (e.g. 42) and
 * their string equivalents ("42") map to the same entry, preventing the
 * SameValueZero mismatch that would otherwise cause silent lookup failures.
 */

const map = new Map<string, string>();

function normalise(requestId: string | number): string {
  return String(requestId);
}

export function registerRequest(requestId: string | number, jobId: string): void {
  map.set(normalise(requestId), jobId);
}

export function unregisterRequest(requestId: string | number): void {
  map.delete(normalise(requestId));
}

export function unregisterByJobId(jobId: string): void {
  for (const [requestId, id] of map.entries()) {
    if (id === jobId) {
      map.delete(requestId);
    }
  }
}

export function getJobByRequestId(requestId: string | number): string | undefined {
  return map.get(normalise(requestId));
}

/** @internal For test isolation only. */
export function clearMap(): void {
  map.clear();
}

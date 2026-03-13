/**
 * Maps MCP requestId -> jobId for the notifications/cancelled pipeline.
 *
 * Entries are registered when a job starts (registerRequest) and cleared in
 * four ways: normal completion (.then in ask-gemini/gemini-reply), job failure
 * (.catch), wait-mode timeout (prevents late cancellation of the background
 * job), and GC sweep (unregisterByJobId, called by sweepExpiredJobs).
 *
 * Keys are normalised to strings so that numeric JSON-RPC ids (e.g. 42) and
 * their string equivalents ("42") map to the same entry, preventing the
 * SameValueZero mismatch that would otherwise cause silent lookup failures.
 */

const map = new Map<string, string>();
const reverseMap = new Map<string, string>();

function normalise(requestId: string | number): string {
  return String(requestId);
}

export function registerRequest(requestId: string | number, jobId: string): void {
  const normalizedId = normalise(requestId);
  const existingJobId = map.get(normalizedId);
  if (existingJobId !== undefined && existingJobId !== jobId) {
    reverseMap.delete(existingJobId);
  }

  const existingRequestId = reverseMap.get(jobId);
  if (existingRequestId !== undefined && existingRequestId !== normalizedId) {
    map.delete(existingRequestId);
  }

  map.set(normalizedId, jobId);
  reverseMap.set(jobId, normalizedId);
}

export function unregisterRequest(requestId: string | number): void {
  const normalizedId = normalise(requestId);
  const jobId = map.get(normalizedId);
  if (jobId !== undefined) {
    reverseMap.delete(jobId);
  }
  map.delete(normalizedId);
}

export function unregisterByJobId(jobId: string): void {
  const requestId = reverseMap.get(jobId);
  if (requestId !== undefined) {
    map.delete(requestId);
    reverseMap.delete(jobId);
  }
}

export function getJobByRequestId(requestId: string | number): string | undefined {
  return map.get(normalise(requestId));
}

/** @internal For test isolation only. */
export function clearMap(): void {
  map.clear();
  reverseMap.clear();
}

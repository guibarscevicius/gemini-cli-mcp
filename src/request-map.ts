const map = new Map<string | number, string>();

export function registerRequest(requestId: string | number, jobId: string): void {
  map.set(requestId, jobId);
}

export function unregisterRequest(requestId: string | number): void {
  map.delete(requestId);
}

export function unregisterByJobId(jobId: string): void {
  for (const [requestId, id] of map.entries()) {
    if (id === jobId) {
      map.delete(requestId);
    }
  }
}

export function getJobByRequestId(requestId: string | number): string | undefined {
  return map.get(requestId);
}

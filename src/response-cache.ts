import { createHash } from "node:crypto";

export const CACHE_TTL_MS = Math.trunc(Number(process.env.GEMINI_CACHE_TTL_MS ?? "300000"));
if (CACHE_TTL_MS < 0 || !Number.isFinite(CACHE_TTL_MS)) {
  throw new Error("GEMINI_CACHE_TTL_MS must be a non-negative integer (0 = disabled)");
}
export const CACHE_MAX_ENTRIES = Math.trunc(Number(process.env.GEMINI_CACHE_MAX_ENTRIES ?? "50"));
if (CACHE_MAX_ENTRIES < 1 || !Number.isFinite(CACHE_MAX_ENTRIES)) {
  throw new Error("GEMINI_CACHE_MAX_ENTRIES must be a positive integer");
}

export interface CacheEntry { response: string; expiresAt: number; }

/**
 * @internal
 * Cross-module-shared response cache. Exported so `gemini-runner.ts` can read/evict
 * directly without an accessor indirection — this is module-local state, not part of
 * the public API. Callers MUST honor the TTL contract (skip entries where
 * `Date.now() >= expiresAt`) and the `CACHE_MAX_ENTRIES` cap on inserts. Encapsulating
 * this behind typed accessors is tracked as a future refactor; touching it here would
 * exceed the no-behavior-change scope of the post-audit cleanup (#109).
 */
export const cache = new Map<string, CacheEntry>();

/** @internal Clears all cached entries. Exposed for test isolation only — not part of the public API. */
export function clearCache(): void {
  cache.clear();
}

export function cacheKey(prompt: string, opts: { model?: string; cwd?: string }): string {
  return createHash("sha256")
    .update(JSON.stringify({ prompt, model: opts.model ?? "", cwd: opts.cwd ?? "" }))
    .digest("hex");
}

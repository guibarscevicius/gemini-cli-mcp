import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: {
      GEMINI_SESSION_DB: ":memory:",
      // Disable warm pool in tests — avoids spawning real Gemini subprocesses
      // at module import time (they'd be killed by the orphan-reaper hook).
      GEMINI_POOL_ENABLED: "0",
    },
    // Disable automatic globals (describe, it, expect) — explicit imports keep
    // tests portable and make IDE auto-import work correctly.
    globals: false,
  },
});

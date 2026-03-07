import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: {
      GEMINI_SESSION_DB: ":memory:",
    },
    // Disable automatic globals (describe, it, expect) — explicit imports keep
    // tests portable and make IDE auto-import work correctly.
    globals: false,
  },
});

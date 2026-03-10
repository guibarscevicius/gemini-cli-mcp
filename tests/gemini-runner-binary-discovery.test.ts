import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// IMPORTANT: These tests use vi.resetModules() + dynamic import() because
// discoverGeminiBinary() runs at module load time (module-level constant).
// The GEMINI_BINARY constant is frozen at import time, so env overrides must
// trigger a fresh module import.

describe("discoverGeminiBinary", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.GEMINI_BINARY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:fs");
    vi.doUnmock("node:child_process");
  });

  it("returns GEMINI_BINARY env var when set", async () => {
    process.env.GEMINI_BINARY = "/custom/path/to/gemini";
    const { discoverGeminiBinary } = await import("../src/gemini-runner.js");
    expect(discoverGeminiBinary()).toBe("/custom/path/to/gemini");
  });

  it("falls back to 'gemini' when no candidates exist", async () => {
    // Mock existsSync to return false for all paths
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(false),
        readdirSync: vi.fn().mockReturnValue([]),
      };
    });

    const { discoverGeminiBinary } = await import("../src/gemini-runner.js");
    expect(discoverGeminiBinary()).toBe("gemini");
  });

  it("finds gemini in nvm path when present", async () => {
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        existsSync: vi.fn().mockImplementation((p: string) => {
          return p.includes(".nvm/versions/node") && p.endsWith("/bin/gemini");
        }),
        readdirSync: vi.fn().mockImplementation((dir: string) => {
          if (dir.includes(".nvm/versions/node")) return ["v22.0.0", "v24.0.0"];
          return [];
        }),
      };
    });

    const { discoverGeminiBinary } = await import("../src/gemini-runner.js");
    const result = discoverGeminiBinary();
    // Should pick the latest (sorted descending: v24.0.0 first)
    expect(result).toContain(".nvm/versions/node");
    expect(result).toContain("v24.0.0");
    expect(result).toContain("/bin/gemini");
  });

  it("handles readdirSync errors gracefully", async () => {
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(false),
        readdirSync: vi.fn().mockImplementation(() => {
          throw new Error("ENOENT: no such file");
        }),
      };
    });

    const { discoverGeminiBinary } = await import("../src/gemini-runner.js");
    // Should not throw; should fall back to "gemini"
    expect(() => discoverGeminiBinary()).not.toThrow();
    expect(discoverGeminiBinary()).toBe("gemini");
  });
});

describe("GEMINI_BINARY constant in spawn calls", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.GEMINI_BINARY;
    delete process.env.GEMINI_POOL_ENABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
  });

  it("uses GEMINI_BINARY env var in module-level constant (spawn receives it)", async () => {
    process.env.GEMINI_BINARY = "/my/custom/gemini";
    process.env.GEMINI_POOL_ENABLED = "0"; // disable pool to avoid spawn side effects

    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      const mockSpawn = vi.fn().mockReturnValue({
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        stdin: { end: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
        pid: 123,
        exitCode: null,
      });
      return { ...actual, spawn: mockSpawn };
    });

    const mod = await import("../src/gemini-runner.js");
    const { spawn } = await import("node:child_process");
    const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

    // Call spawnGemini
    mod.spawnGemini(
      ["--prompt", "test"],
      { env: { HOME: "/home/test", PATH: "/usr/bin" }, timeout: 5000 },
      () => {},
      () => {},
      () => {}
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      "/my/custom/gemini",
      expect.any(Array),
      expect.any(Object)
    );
  });
});

describe("SETUP_MODE suppresses warm pool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    const idx = process.argv.indexOf("--setup");
    if (idx !== -1) process.argv.splice(idx, 1);
  });

  it("does not initialize warmPool when --setup is in argv", async () => {
    process.argv.push("--setup");
    process.env.GEMINI_POOL_ENABLED = "1";
    try {
      vi.resetModules();
      const mod = await import("../src/gemini-runner.js");
      expect(mod.warmPool).toBeNull();
    } finally {
      delete process.env.GEMINI_POOL_ENABLED;
    }
  });
});

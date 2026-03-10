import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";

// Helper to create a mock ChildProcess
function mockChildProcess(overrides: Partial<{
  exitCode: number | null;
  stdout: { on: (evt: string, cb: (data: Buffer) => void) => void };
  stderr: { on: (evt: string, cb: (data: Buffer) => void) => void };
  stdin: { end: () => void; write: (s: string) => void };
  on: (evt: string, cb: (...args: unknown[]) => void) => void;
  kill: () => void;
  pid: number;
}> = {}): Partial<ChildProcess> {
  return {
    exitCode: null,
    stdout: { on: vi.fn() } as unknown as NodeJS.ReadableStream,
    stderr: { on: vi.fn() } as unknown as NodeJS.ReadableStream,
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as NodeJS.WritableStream,
    on: vi.fn(),
    kill: vi.fn(),
    pid: 9999,
    ...overrides,
  } as Partial<ChildProcess>;
}

describe("runSetup", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../src/gemini-runner.js");
    vi.doUnmock("node:fs");
    vi.doUnmock("node:child_process");
    vi.useRealTimers();
  });

  it("runs auth check and outputs config when binary is found", async () => {
    // Mock gemini-runner to return a known binary
    vi.doMock("../src/gemini-runner.js", () => ({
      discoverGeminiBinary: vi.fn().mockReturnValue("/usr/local/bin/gemini"),
    }));

    // Mock node:fs to report binary exists
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return { ...actual, existsSync: vi.fn().mockReturnValue(true) };
    });

    // Mock child_process — auth check returns code 0
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      const mockSpawn = vi.fn().mockImplementation((_cmd: string, args: string[]) => {
        const cp = mockChildProcess();
        const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
        (cp.on as ReturnType<typeof vi.fn>).mockImplementation((evt: string, cb: (...a: unknown[]) => void) => {
          handlers[evt] = handlers[evt] ?? [];
          handlers[evt].push(cb);
        });
        // Simulate auth check success
        if (args.includes("--prompt")) {
          setTimeout(() => {
            handlers["close"]?.forEach((cb) => cb(0, null));
          }, 10);
        }
        return cp;
      });
      return { ...actual, spawn: mockSpawn };
    });

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { runSetup } = await import("../src/setup.js");
    await runSetup();

    const output = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("/usr/local/bin/gemini");
    expect(output).toContain("Setup complete");
    expect(output).toContain("GEMINI_BINARY");
    writeSpy.mockRestore();
  });

  it("shows auth instructions when auth check detects not-authenticated", async () => {
    vi.doMock("../src/gemini-runner.js", () => ({
      discoverGeminiBinary: vi.fn().mockReturnValue("/usr/local/bin/gemini"),
    }));
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return { ...actual, existsSync: vi.fn().mockReturnValue(true) };
    });
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      const mockSpawn = vi.fn().mockImplementation(() => {
        const cp = mockChildProcess();
        const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
        const stderrHandlers: Record<string, ((d: Buffer) => void)[]> = {};
        (cp.on as ReturnType<typeof vi.fn>).mockImplementation((evt: string, cb: (...a: unknown[]) => void) => {
          handlers[evt] = handlers[evt] ?? [];
          handlers[evt].push(cb);
        });
        (cp.stderr!.on as ReturnType<typeof vi.fn>).mockImplementation((evt: string, cb: (d: Buffer) => void) => {
          stderrHandlers[evt] = stderrHandlers[evt] ?? [];
          stderrHandlers[evt].push(cb);
        });
        setTimeout(() => {
          // Emit auth-related stderr
          stderrHandlers["data"]?.forEach((cb) => cb(Buffer.from("Please login first: run `gemini auth`")));
          handlers["close"]?.forEach((cb) => cb(1, null));
        }, 10);
        return cp;
      });
      return { ...actual, spawn: mockSpawn };
    });

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { runSetup } = await import("../src/setup.js");
    await runSetup();

    const output = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Not authenticated");
    expect(output).not.toContain("GEMINI_BINARY");
    expect(output).not.toContain("Setup complete");
    writeSpy.mockRestore();
  });

  it("shows failure message and suppresses config when install fails", async () => {
    vi.doMock("../src/gemini-runner.js", () => ({
      discoverGeminiBinary: vi.fn().mockReturnValue("gemini"),
    }));
    vi.doMock("node:fs", async (importOriginal: () => Promise<typeof import("node:fs")>) => {
      const actual = await importOriginal();
      return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
    });
    vi.doMock("node:child_process", async (importOriginal: () => Promise<typeof import("node:child_process")>) => {
      const actual = await importOriginal();
      const mockSpawn = vi.fn().mockImplementation((_cmd: string, args: string[]) => {
        const cp = mockChildProcess();
        const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
        (cp.on as ReturnType<typeof vi.fn>).mockImplementation((evt: string, cb: (...a: unknown[]) => void) => {
          handlers[evt] = handlers[evt] ?? [];
          handlers[evt].push(cb);
        });
        if (args.includes("gemini") && _cmd === "which") {
          setTimeout(() => handlers["close"]?.forEach((cb) => cb(1, null)), 5);
        } else if (args.includes("install")) {
          setTimeout(() => handlers["close"]?.forEach((cb) => cb(1, null)), 5);
        }
        return cp;
      });
      return { ...actual, spawn: mockSpawn };
    });

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { runSetup } = await import("../src/setup.js");
    await runSetup();

    const output = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Installation failed");
    expect(output).not.toContain("GEMINI_BINARY");
    expect(output).not.toContain("Setup complete");
    writeSpy.mockRestore();
  });

  it("uses gemini path from which when auto-discovery falls back", async () => {
    vi.doMock("../src/gemini-runner.js", () => ({
      discoverGeminiBinary: vi.fn().mockReturnValue("gemini"),
    }));
    vi.doMock("node:fs", async (importOriginal: () => Promise<typeof import("node:fs")>) => {
      const actual = await importOriginal();
      return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
    });
    vi.doMock("node:child_process", async (importOriginal: () => Promise<typeof import("node:child_process")>) => {
      const actual = await importOriginal();
      const mockSpawn = vi.fn().mockImplementation((_cmd: string, _args: string[]) => {
        const cp = mockChildProcess();
        const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
        const stdoutHandlers: Record<string, ((d: Buffer) => void)[]> = {};
        (cp.on as ReturnType<typeof vi.fn>).mockImplementation((evt: string, cb: (...a: unknown[]) => void) => {
          handlers[evt] = handlers[evt] ?? [];
          handlers[evt].push(cb);
        });
        (cp.stdout!.on as ReturnType<typeof vi.fn>).mockImplementation((evt: string, cb: (d: Buffer) => void) => {
          stdoutHandlers[evt] = stdoutHandlers[evt] ?? [];
          stdoutHandlers[evt].push(cb);
        });
        if (_cmd === "which") {
          setTimeout(() => {
            stdoutHandlers["data"]?.forEach((cb) => cb(Buffer.from("/usr/bin/gemini\n")));
            handlers["close"]?.forEach((cb) => cb(0, null));
          }, 5);
        } else {
          setTimeout(() => handlers["close"]?.forEach((cb) => cb(0, null)), 5);
        }
        return cp;
      });
      return { ...actual, spawn: mockSpawn };
    });

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { runSetup } = await import("../src/setup.js");
    await runSetup();

    const output = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Found gemini on PATH: /usr/bin/gemini");
    expect(output).toContain("/usr/bin/gemini");
    expect(output).toContain("Setup complete");
    writeSpy.mockRestore();
  });

  it("warns on auth timeout but still shows config", async () => {
    vi.useFakeTimers();
    vi.doMock("../src/gemini-runner.js", () => ({
      discoverGeminiBinary: vi.fn().mockReturnValue("/usr/local/bin/gemini"),
    }));
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return { ...actual, existsSync: vi.fn().mockReturnValue(true) };
    });
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      const mockSpawn = vi.fn().mockImplementation(() => {
        // Never closes — will trigger timeout
        return mockChildProcess();
      });
      return { ...actual, spawn: mockSpawn };
    });

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { runSetup } = await import("../src/setup.js");
    const setupPromise = runSetup();
    // Advance fake timers past the 15s auth timeout
    await vi.advanceTimersByTimeAsync(16_000);
    await setupPromise;

    const output = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("timed out");
    expect(output).toContain("GEMINI_BINARY"); // still outputs config
    writeSpy.mockRestore();
  });

  it("config uses process.execPath and correct dist/index.js path", async () => {
    vi.doMock("../src/gemini-runner.js", () => ({
      discoverGeminiBinary: vi.fn().mockReturnValue("/usr/local/bin/gemini"),
    }));
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return { ...actual, existsSync: vi.fn().mockReturnValue(true) };
    });
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      const mockSpawn = vi.fn().mockImplementation(() => {
        const cp = mockChildProcess();
        const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
        (cp.on as ReturnType<typeof vi.fn>).mockImplementation((evt: string, cb: (...a: unknown[]) => void) => {
          handlers[evt] = handlers[evt] ?? [];
          handlers[evt].push(cb);
        });
        setTimeout(() => handlers["close"]?.forEach((cb) => cb(0, null)), 10);
        return cp;
      });
      return { ...actual, spawn: mockSpawn };
    });

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { runSetup } = await import("../src/setup.js");
    await runSetup();

    const output = writeSpy.mock.calls.map((c) => c[0]).join("");
    // Config should reference process.execPath
    expect(output).toContain(process.execPath);
    // Config should reference dist/index.js
    expect(output).toContain("dist/index.js");
    writeSpy.mockRestore();
  });
});

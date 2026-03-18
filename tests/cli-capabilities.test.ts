import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process at the top — all tests control execFile behavior
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import {
  type CliCapabilities,
  MIN_SUPPORTED_VERSION,
  _resetCapabilities,
  buildBaseArgs,
  detectCapabilities,
  getCapabilities,
} from "../src/cli-capabilities.js";

// Helper: make execFileMock resolve with given stdout
function mockExecFile(responses: Record<string, { stdout?: string; stderr?: string; error?: Error | null }>) {
  execFileMock.mockImplementation(
    (_binary: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      const key = args[0]; // "--version" or "--help"
      const resp = responses[key] ?? { stdout: "", stderr: "" };
      cb(resp.error ?? null, resp.stdout ?? "", resp.stderr ?? "");
      return { on: vi.fn() };
    }
  );
}

// Helper: make execFileMock reject (simulates ENOENT, timeout, etc.)
function mockExecFileError(error: Error) {
  execFileMock.mockImplementation(
    (_binary: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(error, "", "");
      return { on: vi.fn() };
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetCapabilities();
  delete process.env.GEMINI_SKIP_DETECTION;
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetCapabilities();
  delete process.env.GEMINI_SKIP_DETECTION;
});

describe("detectCapabilities", () => {
  describe("version parsing", () => {
    it("parses clean version string", async () => {
      mockExecFile({
        "--version": { stdout: "0.34.0\n" },
        "--help": { stdout: "--yolo --output-format" },
      });
      const caps = await detectCapabilities("/usr/bin/gemini");
      expect(caps.version).toEqual({ raw: "0.34.0", major: 0, minor: 34, patch: 0 });
    });

    it("parses version from verbose output", async () => {
      mockExecFile({
        "--version": { stdout: "gemini version 0.35.1-beta\n" },
        "--help": { stdout: "--yolo" },
      });
      const caps = await detectCapabilities("/usr/bin/gemini");
      expect(caps.version).toEqual({ raw: "0.35.1", major: 0, minor: 35, patch: 1 });
    });

    it("returns null version for empty output", async () => {
      mockExecFile({
        "--version": { stdout: "" },
        "--help": { stdout: "--yolo" },
      });
      const caps = await detectCapabilities("/usr/bin/gemini");
      expect(caps.version).toBeNull();
    });

    it("returns null version for garbage output", async () => {
      mockExecFile({
        "--version": { stdout: "no version here\n" },
        "--help": { stdout: "--yolo" },
      });
      const caps = await detectCapabilities("/usr/bin/gemini");
      expect(caps.version).toBeNull();
    });

    it("extracts version from stderr when stdout is empty", async () => {
      mockExecFile({
        "--version": { stdout: "", stderr: "gemini v1.2.3\n" },
        "--help": { stdout: "--yolo" },
      });
      const caps = await detectCapabilities("/usr/bin/gemini");
      expect(caps.version).toEqual({ raw: "1.2.3", major: 1, minor: 2, patch: 3 });
    });
  });

  describe("help flag parsing", () => {
    it("parses multiple flags from help output", async () => {
      const helpOutput = `
Usage: gemini [options]

Options:
  --yolo                     Skip all confirmation prompts
  --output-format <format>   Output format (stream-json, text)
  --model <model>            Model to use
  --sandbox                  Run in sandbox mode
  --resume <id>              Resume a session
  --approval-mode <mode>     Approval mode (yolo, manual)
  --prompt <text>            Prompt text
`;
      mockExecFile({
        "--version": { stdout: "0.36.0\n" },
        "--help": { stdout: helpOutput },
      });
      const caps = await detectCapabilities("/usr/bin/gemini");
      expect(caps.flags.has("--yolo")).toBe(true);
      expect(caps.flags.has("--output-format")).toBe(true);
      expect(caps.flags.has("--model")).toBe(true);
      expect(caps.flags.has("--sandbox")).toBe(true);
      expect(caps.flags.has("--resume")).toBe(true);
      expect(caps.flags.has("--approval-mode")).toBe(true);
      expect(caps.flags.has("--prompt")).toBe(true);
      expect(caps.hasApprovalMode).toBe(true);
      expect(caps.hasYolo).toBe(true);
      expect(caps.hasOutputFormat).toBe(true);
      expect(caps.hasSandbox).toBe(true);
      expect(caps.hasResume).toBe(true);
    });

    it("correctly reports missing flags", async () => {
      mockExecFile({
        "--version": { stdout: "0.30.0\n" },
        "--help": { stdout: "--yolo --output-format --prompt" },
      });
      const caps = await detectCapabilities("/usr/bin/gemini");
      expect(caps.hasApprovalMode).toBe(false);
      expect(caps.hasSandbox).toBe(false);
      expect(caps.hasResume).toBe(false);
      expect(caps.hasYolo).toBe(true);
    });
  });

  describe("error handling", () => {
    it("returns fallback on ENOENT (binary not found)", async () => {
      const err = new Error("spawn /usr/bin/gemini ENOENT") as Error & { code: string };
      err.code = "ENOENT";
      mockExecFileError(err);
      const caps = await detectCapabilities("/usr/bin/gemini");
      expect(caps.error).toContain("version detection failed");
      expect(caps.version).toBeNull();
      expect(caps.flags.size).toBe(0);
      expect(caps.hasYolo).toBe(true); // fallback assumes --yolo works
    });

    it("handles help parsing failure gracefully (version still available)", async () => {
      let callCount = 0;
      execFileMock.mockImplementation(
        (_binary: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
          callCount++;
          if (args[0] === "--version") {
            cb(null, "0.34.0\n", "");
          } else {
            // help fails with no output
            cb(new Error("help failed"), "", "");
          }
          return { on: vi.fn() };
        }
      );
      const caps = await detectCapabilities("/usr/bin/gemini");
      expect(caps.version).toEqual({ raw: "0.34.0", major: 0, minor: 34, patch: 0 });
      expect(caps.error).toContain("help parsing failed");
      expect(caps.flags.size).toBe(0);
    });
  });

  describe("version warning", () => {
    it("logs warning when version is below minimum", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      mockExecFile({
        "--version": { stdout: "0.29.0\n" },
        "--help": { stdout: "--yolo" },
      });
      await detectCapabilities("/usr/bin/gemini");
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("below minimum supported")
      );
    });

    it("does not warn when version meets minimum", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      mockExecFile({
        "--version": { stdout: "0.34.0\n" },
        "--help": { stdout: "--yolo" },
      });
      await detectCapabilities("/usr/bin/gemini");
      expect(stderrSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("below minimum supported")
      );
    });
  });

  describe("GEMINI_SKIP_DETECTION", () => {
    it("skips detection when env var is set", async () => {
      process.env.GEMINI_SKIP_DETECTION = "1";
      const caps = await detectCapabilities("/usr/bin/gemini");
      expect(caps.error).toContain("detection skipped");
      expect(caps.version).toBeNull();
      expect(caps.hasYolo).toBe(true);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("runs detection normally when env var is not set", async () => {
      mockExecFile({
        "--version": { stdout: "0.34.0\n" },
        "--help": { stdout: "--yolo" },
      });
      const caps = await detectCapabilities("/usr/bin/gemini");
      expect(caps.version).not.toBeNull();
      expect(execFileMock).toHaveBeenCalled();
    });
  });
});

describe("buildBaseArgs", () => {
  it("uses --approval-mode when available", () => {
    const caps: CliCapabilities = {
      version: { raw: "0.36.0", major: 0, minor: 36, patch: 0 },
      flags: new Set(["--approval-mode", "--yolo", "--output-format"]),
      hasApprovalMode: true,
      hasYolo: true,
      hasOutputFormat: true,
      hasSandbox: false,
      hasResume: false,
      detectedAt: Date.now(),
      error: null,
    };
    expect(buildBaseArgs(caps)).toEqual([
      "--approval-mode", "yolo",
      "--output-format", "stream-json",
    ]);
  });

  it("falls back to --yolo when --approval-mode is not available", () => {
    const caps: CliCapabilities = {
      version: { raw: "0.34.0", major: 0, minor: 34, patch: 0 },
      flags: new Set(["--yolo", "--output-format"]),
      hasApprovalMode: false,
      hasYolo: true,
      hasOutputFormat: true,
      hasSandbox: false,
      hasResume: false,
      detectedAt: Date.now(),
      error: null,
    };
    expect(buildBaseArgs(caps)).toEqual([
      "--yolo",
      "--output-format", "stream-json",
    ]);
  });

  it("returns hardcoded fallback when caps is null", () => {
    expect(buildBaseArgs(null)).toEqual([
      "--yolo",
      "--output-format", "stream-json",
    ]);
  });
});

describe("getCapabilities", () => {
  it("returns cached result on subsequent calls", async () => {
    mockExecFile({
      "--version": { stdout: "0.34.0\n" },
      "--help": { stdout: "--yolo --output-format" },
    });
    const first = await getCapabilities("/usr/bin/gemini");
    const second = await getCapabilities("/usr/bin/gemini");
    expect(first).toBe(second); // same reference — cached
    // execFile called twice total (once for --version, once for --help), not four times
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe("MIN_SUPPORTED_VERSION", () => {
  it("is 0.30.0", () => {
    expect(MIN_SUPPORTED_VERSION).toEqual({
      raw: "0.30.0",
      major: 0,
      minor: 30,
      patch: 0,
    });
  });
});

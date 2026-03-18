import { afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// Mock cli-capabilities so runGemini uses the hardcoded fallback (--yolo) in tests.
// The module-level .then() handler accesses caps.version/caps.error, so we return a
// proper CliCapabilities-shaped object (not null).  For cold-spawn arg building inside
// runGemini, buildBaseArgs receives the same object and returns the legacy --yolo args.
const _fallbackCaps = vi.hoisted(() => ({
  version: null,
  flags: new Set<string>(),
  hasApprovalMode: false,
  hasYolo: true,
  hasOutputFormat: true,
  hasSandbox: false,
  hasResume: false,
  detectedAt: Date.now(),
  error: "mocked for tests",
}));
vi.mock("../src/cli-capabilities.js", () => ({
  getCapabilities: vi.fn().mockResolvedValue(_fallbackCaps),
  buildBaseArgs: vi.fn().mockImplementation(() => ["--yolo", "--output-format", "stream-json"]),
}));

import {
  runGemini,
  parseGeminiOutput,
  expandFileRefs,
  spawnGemini,
  clearCache,
  GeminiOutputError,
  type GeminiExecutor,
} from "../src/gemini-runner.js";

// ── parseGeminiOutput (pure unit tests — no subprocess) ─────────────────────

describe("parseGeminiOutput", () => {
  it("returns response field when present", () => {
    expect(parseGeminiOutput(JSON.stringify({ response: "hello" }))).toBe("hello");
  });

  it("falls back to text field if response is absent", () => {
    expect(parseGeminiOutput(JSON.stringify({ text: "hello via text" }))).toBe(
      "hello via text"
    );
  });

  it("falls back to content field if response and text are absent", () => {
    expect(
      parseGeminiOutput(JSON.stringify({ content: "hello via content" }))
    ).toBe("hello via content");
  });

  it("response field takes priority over text and content", () => {
    expect(
      parseGeminiOutput(
        JSON.stringify({ response: "primary", text: "secondary", content: "tertiary" })
      )
    ).toBe("primary");
  });

  it("text field takes priority over content when response is absent", () => {
    expect(
      parseGeminiOutput(JSON.stringify({ text: "from text", content: "from content" }))
    ).toBe("from text");
  });

  it("throws 'gemini error: ...' when error field is present", () => {
    expect(() =>
      parseGeminiOutput(JSON.stringify({ error: "rate limit exceeded" }))
    ).toThrow("gemini error: rate limit exceeded");
  });

  it("error field takes priority over any response field", () => {
    // If both error and response are present, error wins
    expect(() =>
      parseGeminiOutput(JSON.stringify({ error: "oops", response: "ignored" }))
    ).toThrow("gemini error: oops");
  });

  it("appends cwd hint when JSON error field contains 'Path not in workspace'", () => {
    expect(() =>
      parseGeminiOutput(
        JSON.stringify({
          error:
            "Error executing tool read_file: Path not in workspace: /other/project/foo.ts",
        })
      )
    ).toThrow("pass cwd pointing to the project root containing your @file targets");
  });

  it("preserves original Path-not-in-workspace detail in JSON error path", () => {
    expect.assertions(2);
    try {
      parseGeminiOutput(
        JSON.stringify({
          error: "Error executing tool read_file: Path not in workspace: /other/project",
        })
      );
      expect.fail("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Path not in workspace");
      expect(msg).toContain("pass cwd pointing to the project root");
    }
  });

  it("does NOT append cwd hint to unrelated JSON errors", () => {
    expect(() =>
      parseGeminiOutput(JSON.stringify({ error: "rate limit exceeded" }))
    ).toThrow("gemini error: rate limit exceeded");
    expect(() =>
      parseGeminiOutput(JSON.stringify({ error: "rate limit exceeded" }))
    ).not.toThrow("pass cwd pointing to the project root");
  });

  it("throws on non-JSON input", () => {
    expect(() => parseGeminiOutput("not json at all")).toThrow(
      "gemini returned non-JSON output"
    );
  });

  it("non-JSON error includes up to 2000 chars of raw output", () => {
    expect.assertions(2);
    const longRaw = "X".repeat(3000);
    try {
      parseGeminiOutput(longRaw);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("X".repeat(2000));
      expect((err as Error).message).not.toContain("X".repeat(2001));
    }
  });

  it("throws on valid JSON with no recognised field", () => {
    expect(() =>
      parseGeminiOutput(JSON.stringify({ unknown_field: "value", stats: {} }))
    ).toThrow("gemini JSON output has unexpected shape");
  });

  it("throws when parsed JSON is not an object", () => {
    expect(() => parseGeminiOutput(JSON.stringify("hello"))).toThrow(
      "gemini process returned unexpected JSON shape"
    );
  });

  it("unexpected shape error includes the parsed object for debugging", () => {
    expect.assertions(1);
    const obj = { mystery: "clue" };
    try {
      parseGeminiOutput(JSON.stringify(obj));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain('"mystery"');
    }
  });

  it("handles empty string response field (empty is valid, not an error)", () => {
    expect(parseGeminiOutput(JSON.stringify({ response: "" }))).toBe("");
  });
});

// ── runGemini (uses injectable executor — no real subprocess) ────────────────

/**
 * Helper: create a mock executor that resolves with given text.
 * With the spawn-based executor, `stdout` is the accumulated response text
 * (already parsed from stream-json NDJSON), not raw JSON.
 */
function makeExecutor(text: string): GeminiExecutor {
  return vi.fn().mockResolvedValue({ stdout: text });
}

/** Helper: create a mock executor that rejects */
function makeErrorExecutor(
  err: Partial<Error & { stderr?: string }>
): GeminiExecutor {
  return vi.fn().mockRejectedValue(err);
}

type RunnerModule = typeof import("../src/gemini-runner.js") & {
  GeminiOutputError: typeof import("../src/gemini-runner.js").GeminiOutputError;
};

const RELIABILITY_ENV_KEYS = [
  "GEMINI_MAX_RETRIES",
  "GEMINI_RETRY_BASE_MS",
  "GEMINI_MAX_CONCURRENT",
  "GEMINI_QUEUE_TIMEOUT_MS",
  "GEMINI_STRUCTURED_LOGS",
  "GEMINI_CACHE_TTL_MS",
  "GEMINI_CACHE_MAX_ENTRIES",
] as const;

const originalReliabilityEnv = Object.fromEntries(
  RELIABILITY_ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof RELIABILITY_ENV_KEYS)[number], string | undefined>;

async function loadRunnerWithEnv(
  env: Partial<Record<(typeof RELIABILITY_ENV_KEYS)[number], string>>
): Promise<RunnerModule> {
  for (const key of RELIABILITY_ENV_KEYS) {
    const value = env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.resetModules();
  return import("../src/gemini-runner.js");
}

afterEach(() => {
  vi.restoreAllMocks();
  clearCache(); // prevent cache hits from bleeding across tests
  for (const key of RELIABILITY_ENV_KEYS) {
    const value = originalReliabilityEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("runGemini", () => {
  it("resolves with response text returned by executor", async () => {
    const exec = makeExecutor("The capital is Paris.");
    const result = await runGemini("What is the capital of France?", {}, exec);
    expect(result).toBe("The capital is Paris.");
  });

  // ── Args construction ──────────────────────────────────────────────────────

  it("always passes --yolo, --output-format stream-json, and --prompt flags", async () => {
    const exec = makeExecutor("ok");
    await runGemini("my prompt", {}, exec);

    const capturedArgs = vi.mocked(exec).mock.calls[0][0];
    expect(capturedArgs).toContain("--yolo");
    expect(capturedArgs).toContain("--output-format");
    expect(capturedArgs).toContain("stream-json");
    expect(capturedArgs).toContain("--prompt");
    expect(capturedArgs).toContain("my prompt");
  });

  it("prompt is passed as a single array element (not split on spaces)", async () => {
    const prompt = "summarize; rm -rf /; echo pwned";
    const exec = makeExecutor("ok");
    await runGemini(prompt, {}, exec);

    const args = vi.mocked(exec).mock.calls[0][0];
    const promptIndex = args.indexOf("--prompt");
    // The whole prompt string is the element immediately after --prompt
    expect(args[promptIndex + 1]).toBe(prompt);
    // It is NOT split into multiple elements
    expect(args).toHaveLength(5); // --yolo --output-format stream-json --prompt <prompt>
  });

  it("appends --model flag when model option is provided", async () => {
    const exec = makeExecutor("ok");
    await runGemini("hello", { model: "gemini-2.5-pro" }, exec);

    const args = vi.mocked(exec).mock.calls[0][0];
    expect(args).toContain("--model");
    expect(args).toContain("gemini-2.5-pro");
    expect(args).toHaveLength(7); // base 5 + --model <model>
  });

  it("does NOT append --model flag when model is not provided", async () => {
    const exec = makeExecutor("ok");
    await runGemini("hello", {}, exec);

    const args = vi.mocked(exec).mock.calls[0][0];
    expect(args).not.toContain("--model");
  });

  // ── Environment isolation ──────────────────────────────────────────────────

  it("passes only HOME and PATH in env (no other vars)", async () => {
    const exec = makeExecutor("ok");
    await runGemini("hello", {}, exec);

    const capturedOpts = vi.mocked(exec).mock.calls[0][1];
    const envKeys = Object.keys(capturedOpts.env);
    expect(envKeys.sort()).toEqual(["HOME", "PATH"]);
  });

  it("uses the default PATH when PATH is not set", async () => {
    const originalPath = process.env.PATH;
    delete process.env.PATH;

    try {
      const exec = makeExecutor("ok");
      await runGemini("hello", {}, exec);

      const capturedOpts = vi.mocked(exec).mock.calls[0][1];
      expect(capturedOpts.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  it("passes cwd option through to executor", async () => {
    const exec = makeExecutor("ok");
    await runGemini("hello", { cwd: "/some/project" }, exec);

    const capturedOpts = vi.mocked(exec).mock.calls[0][1];
    expect(capturedOpts.cwd).toBe("/some/project");
  });

  it("cwd is undefined when not specified", async () => {
    const exec = makeExecutor("ok");
    await runGemini("hello", {}, exec);

    const capturedOpts = vi.mocked(exec).mock.calls[0][1];
    expect(capturedOpts.cwd).toBeUndefined();
  });

  it("passes 300-second timeout to executor", async () => {
    const exec = makeExecutor("ok");
    await runGemini("hello", {}, exec);

    const capturedOpts = vi.mocked(exec).mock.calls[0][1];
    expect(capturedOpts.timeout).toBe(300_000);
  });

  it("passes prompt inline when it fits below LARGE_PROMPT_THRESHOLD", async () => {
    const exec = makeExecutor("ok");
    const smallPrompt = "A".repeat(100); // well below 110 KB threshold
    await runGemini(smallPrompt, {}, exec);

    const capturedArgs = vi.mocked(exec).mock.calls[0][0];
    expect(capturedArgs).toContain("--prompt");
    expect(capturedArgs[capturedArgs.indexOf("--prompt") + 1]).toBe(smallPrompt);
    // No temp-file flags injected
    expect(capturedArgs).not.toContain("--include-directories");
  });

  it("uses temp-file bypass for large prompts and cleans up afterward", async () => {
    const exec = makeExecutor("ok");
    // Construct a prompt larger than LARGE_PROMPT_THRESHOLD (110 KB)
    const largePrompt = "B".repeat(115 * 1024);
    await runGemini(largePrompt, {}, exec);

    const capturedArgs = vi.mocked(exec).mock.calls[0][0];
    // Should have --include-directories pointing to tmpdir
    expect(capturedArgs).toContain("--include-directories");
    expect(capturedArgs[capturedArgs.indexOf("--include-directories") + 1]).toBe(os.tmpdir());
    // --prompt should point to a temp file via @path
    const promptIdx = capturedArgs.indexOf("--prompt");
    expect(promptIdx).toBeGreaterThan(-1);
    const promptArg = capturedArgs[promptIdx + 1];
    expect(promptArg).toMatch(/^@.+gemini-prompt-.+\.txt$/);

    // Temp file must be deleted after the call
    const tempPath = promptArg.slice(1); // strip leading @
    await expect(fs.access(tempPath)).rejects.toThrow();
  });

  it("uses temp-file bypass when model is also provided — correct arg count and ordering", async () => {
    const exec = makeExecutor("ok");
    const largePrompt = "D".repeat(115 * 1024);
    await runGemini(largePrompt, { model: "gemini-2.5-pro" }, exec);

    const capturedArgs = vi.mocked(exec).mock.calls[0][0];
    // --yolo --output-format stream-json --model <model> --include-directories <tmpdir> --prompt @<file>
    expect(capturedArgs).toHaveLength(9);
    expect(capturedArgs).toContain("--model");
    expect(capturedArgs).toContain("gemini-2.5-pro");
    expect(capturedArgs).toContain("--include-directories");
    expect(capturedArgs[capturedArgs.indexOf("--prompt") + 1]).toMatch(
      /^@.+gemini-prompt-.+\.txt$/
    );
  });

  it("cleans up temp file even when the executor throws", async () => {
    const exec = vi.fn().mockRejectedValue(
      Object.assign(new Error("subprocess failed"), { code: "EACCES", stderr: "denied" })
    ) as unknown as GeminiExecutor;
    const largePrompt = "C".repeat(115 * 1024);

    await expect(runGemini(largePrompt, {}, exec)).rejects.toThrow();

    const capturedArgs = vi.mocked(exec).mock.calls[0][0];
    const promptArg = capturedArgs[capturedArgs.indexOf("--prompt") + 1];
    const tempPath = promptArg.slice(1);
    await expect(fs.access(tempPath)).rejects.toThrow();
  });

  it("fails fast when HOME is not set", async () => {
    const originalHome = process.env.HOME;
    delete process.env.HOME;

    try {
      const exec = makeExecutor("ok");
      await expect(runGemini("hello", {}, exec)).rejects.toThrow(
        "HOME environment variable is not set"
      );
      expect(exec).not.toHaveBeenCalled();
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  it("returns a specific error when the gemini binary is missing", async () => {
    const enoent = Object.assign(new Error("spawn gemini ENOENT"), { code: "ENOENT" });
    const exec = makeErrorExecutor(enoent);

    await expect(runGemini("hello", {}, exec)).rejects.toThrow(
      "gemini binary not found. Is the Gemini CLI installed and on PATH?"
    );
  });

  it("wraps executor rejection with stderr detail when available", async () => {
    const exec = makeErrorExecutor({ stderr: "authentication error", message: "exit code 1" });
    await expect(runGemini("hello", {}, exec)).rejects.toThrow(
      "gemini process failed: authentication error"
    );
  });

  it("preserves the original executor error as cause", async () => {
    expect.assertions(2);
    const original = Object.assign(new Error("exit code 1"), {
      stderr: "authentication error",
    });
    const exec = makeErrorExecutor(original);

    try {
      await runGemini("hello", {}, exec);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("authentication error");
      expect((err as Error & { cause?: unknown }).cause).toBe(original);
    }
  });

  it("falls back to error.message when stderr is empty", async () => {
    const exec = makeErrorExecutor({ stderr: "", message: "EPIPE" });
    await expect(runGemini("hello", {}, exec)).rejects.toThrow(
      "gemini process failed: EPIPE"
    );
  });

  it("appends cwd hint when stderr contains 'Path not in workspace'", async () => {
    const exec = makeErrorExecutor({
      stderr:
        'Error executing tool read_file: Path not in workspace: Attempted path "/other/project/foo.ts" resolves outside the allowed workspace directories: /home/gui/projects/myapp',
    });
    await expect(runGemini("review @foo.ts", {}, exec)).rejects.toThrow(
      "pass cwd pointing to the project root containing your @file targets"
    );
  });

  it("preserves original Path-not-in-workspace detail alongside the cwd hint", async () => {
    expect.assertions(2);
    const exec = makeErrorExecutor({
      stderr: "Error executing tool read_file: Path not in workspace: /other/project",
    });
    try {
      await runGemini("review @foo.ts", {}, exec);
      expect.fail("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Path not in workspace");
      expect(msg).toContain("pass cwd pointing to the project root");
    }
  });

  it("does NOT append cwd hint when stderr error is unrelated to workspace paths", async () => {
    const exec = makeErrorExecutor({ stderr: "authentication error", message: "exit code 1" });
    try {
      await runGemini("hello", {}, exec);
      expect.fail("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("authentication error");
      expect(msg).not.toContain("pass cwd pointing to the project root");
    }
  });

  it("propagates GeminiOutputError thrown by executor (retryable, exhausts retries)", async () => {
    const { runGemini: freshRunGemini, GeminiOutputError: FreshErr } = await loadRunnerWithEnv({
      GEMINI_MAX_RETRIES: "0",
      GEMINI_RETRY_BASE_MS: "0",
    });
    const exec = vi.fn().mockRejectedValue(
      new FreshErr("parse error from executor", "parse error from executor")
    ) as unknown as GeminiExecutor;
    await expect(freshRunGemini("hello", {}, exec)).rejects.toThrow("parse error from executor");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("throws when 2+ @file tokens are present and cwd is not provided", async () => {
    const exec = makeExecutor("ok");
    await expect(
      runGemini("Read @src/a.ts and @src/b.ts", {}, exec)
    ).rejects.toThrow("Multiple @file tokens require the cwd option");
    expect(exec).not.toHaveBeenCalled();
  });

  it("passes onChunk callback to executor as third argument", async () => {
    const chunks: string[] = [];
    const onChunk = (c: string) => chunks.push(c);
    const exec = vi.fn().mockImplementation(async (_args, _opts, cb) => {
      cb?.("chunk-1");
      cb?.("chunk-2");
      return { stdout: "chunk-1chunk-2" };
    }) as unknown as GeminiExecutor;

    const result = await runGemini("hello", {}, exec, onChunk);
    expect(result).toBe("chunk-1chunk-2");
    expect(chunks).toEqual(["chunk-1", "chunk-2"]);
  });

  // ── model name in errors (#65) ──────────────────────────────────────────

  it("prepends model name to error when opts.model is set", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("quota exceeded"));
    await expect(
      runGemini("hello", { model: "gemini-2.5-pro" }, exec as unknown as GeminiExecutor)
    ).rejects.toThrow("(model: gemini-2.5-pro) quota exceeded");
  });

  it("does not prepend model when opts.model is not set", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("quota exceeded"));
    await expect(
      runGemini("hello", {}, exec as unknown as GeminiExecutor)
    ).rejects.toThrow("quota exceeded");
    await expect(
      runGemini("hello", {}, exec as unknown as GeminiExecutor)
    ).rejects.not.toThrow("(model:");
  });
});

describe("runGemini retries", () => {
  it("retries GeminiOutputError failures and succeeds on a later attempt", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { runGemini: freshRunGemini, GeminiOutputError: FreshErr } = await loadRunnerWithEnv({
      GEMINI_MAX_RETRIES: "3",
      GEMINI_RETRY_BASE_MS: "0",
    });
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new FreshErr("parse fail 1", "parse fail 1"))
      .mockRejectedValueOnce(new FreshErr("parse fail 2", "parse fail 2"))
      .mockResolvedValueOnce({ stdout: "ok after retries" });

    const result = await freshRunGemini("hello", {}, exec as unknown as GeminiExecutor);
    expect(result).toBe("ok after retries");
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable executor errors", async () => {
    const { runGemini: freshRunGemini } = await loadRunnerWithEnv({
      GEMINI_MAX_RETRIES: "3",
      GEMINI_RETRY_BASE_MS: "0",
    });
    const exec = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("missing binary"), { code: "ENOENT" }));

    await expect(freshRunGemini("hello", {}, exec as unknown as GeminiExecutor)).rejects.toThrow(
      "gemini binary not found. Is the Gemini CLI installed and on PATH?"
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("attempts only once when GEMINI_MAX_RETRIES=0", async () => {
    const { runGemini: freshRunGemini, GeminiOutputError: FreshErr } = await loadRunnerWithEnv({
      GEMINI_MAX_RETRIES: "0",
      GEMINI_RETRY_BASE_MS: "0",
    });
    // Executor rejects with GeminiOutputError (retryable) but retries=0 → only 1 attempt
    const exec = vi.fn().mockRejectedValue(
      new FreshErr("parse error", "parse error")
    );

    await expect(freshRunGemini("hello", {}, exec as unknown as GeminiExecutor)).rejects.toThrow(
      "parse error"
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe("runGemini concurrency", () => {
  it("serializes requests when GEMINI_MAX_CONCURRENT=1", async () => {
    const { runGemini: freshRunGemini } = await loadRunnerWithEnv({
      GEMINI_MAX_CONCURRENT: "1",
      GEMINI_MAX_RETRIES: "0",
    });
    const order: string[] = [];
    let resolveFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let callIndex = 0;

    const exec = vi.fn().mockImplementation(async () => {
      callIndex++;
      const current = callIndex;
      order.push(`start-${current}`);
      if (current === 1) {
        await firstGate;
        order.push("end-1");
        return { stdout: "first" };
      }
      order.push(`end-${current}`);
      return { stdout: "second" };
    }) as unknown as GeminiExecutor;

    const first = freshRunGemini("prompt one", {}, exec);
    await Promise.resolve();
    const second = freshRunGemini("prompt two", {}, exec);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exec).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe("first");
    expect(secondResult).toBe("second");
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });


  it("throws at import when GEMINI_MAX_CONCURRENT=0", async () => {
    await expect(
      loadRunnerWithEnv({ GEMINI_MAX_CONCURRENT: "0" })
    ).rejects.toThrow("GEMINI_MAX_CONCURRENT must be a positive integer");
  });
});

describe("runGemini telemetry", () => {
  it("emits structured success telemetry when GEMINI_STRUCTURED_LOGS=1", async () => {
    const { runGemini: freshRunGemini } = await loadRunnerWithEnv({
      GEMINI_STRUCTURED_LOGS: "1",
      GEMINI_MAX_RETRIES: "0",
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exec = vi.fn().mockResolvedValue({ stdout: "ok" });

    await freshRunGemini("hello", { tool: "ask-gemini" }, exec as unknown as GeminiExecutor);

    const logLine = stderrSpy.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.includes("\"event\":\"gemini_request\""));
    expect(logLine).toBeDefined();
    const payload = JSON.parse(logLine as string) as Record<string, unknown>;

    expect(payload.event).toBe("gemini_request");
    expect(payload.status).toBe("ok");
    expect(payload.tool).toBe("ask-gemini");
  });

  it("emits structured error telemetry when request fails", async () => {
    const { runGemini: freshRunGemini } = await loadRunnerWithEnv({
      GEMINI_STRUCTURED_LOGS: "1",
      GEMINI_MAX_RETRIES: "0",
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exec = vi.fn().mockRejectedValue(
      Object.assign(new Error("fatal failure"), { stderr: "fatal failure" })
    );

    await expect(
      freshRunGemini("hello", { tool: "gemini-reply", sessionId: "abc" }, exec as unknown as GeminiExecutor)
    ).rejects.toThrow("gemini process failed: fatal failure");

    const logLine = stderrSpy.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.includes("\"event\":\"gemini_request\""));
    expect(logLine).toBeDefined();
    const payload = JSON.parse(logLine as string) as Record<string, unknown>;

    expect(payload.event).toBe("gemini_request");
    expect(payload.status).toBe("error");
    expect(payload.tool).toBe("gemini-reply");
  });


  it("telemetry error field uses sanitized message from GeminiOutputError", async () => {
    const { runGemini: freshRunGemini, GeminiOutputError: FreshGeminiOutputError } =
      await loadRunnerWithEnv({
        GEMINI_STRUCTURED_LOGS: "1",
        GEMINI_MAX_RETRIES: "0",
      });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const rawOutput = "RAWRAWRAW".repeat(50); // 450 chars of raw data
    const exec = vi.fn().mockRejectedValue(
      new FreshGeminiOutputError(rawOutput, "gemini output parse error")
    );

    await expect(
      freshRunGemini("hello", {}, exec as unknown as GeminiExecutor)
    ).rejects.toThrow();

    const logLine = stderrSpy.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.includes('"event":"gemini_request"'));
    expect(logLine).toBeDefined();
    const payload = JSON.parse(logLine as string) as Record<string, unknown>;

    expect(payload.status).toBe("error");
    expect(payload.error).toBe("gemini output parse error"); // sanitized message, not raw
    expect(String(payload.error)).not.toContain("RAWRAWRAW"); // raw output excluded
  });
});

// ── expandFileRefs ──────────────────────────────────────────────────────────

describe("expandFileRefs", () => {
  /** Create a temporary directory with given files and return its path. */
  async function makeTmpDir(files: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-test-"));
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf-8");
    }
    return dir;
  }

  it("returns prompt unchanged for a single @file token", async () => {
    const dir = await makeTmpDir({ "a.ts": "export const a = 1;" });
    try {
      const prompt = "Review @a.ts please";
      const result = await expandFileRefs(prompt, dir);
      expect(result).toBe(prompt);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("expands two @file tokens: masks @tokens in prompt text and appends REFERENCE block", async () => {
    const dir = await makeTmpDir({
      "a.ts": "const a = 1;",
      "b.ts": "const b = 2;",
    });
    try {
      const prompt = "Compare @a.ts and @b.ts";
      const result = await expandFileRefs(prompt, dir);

      // @tokens are masked (@ stripped) to prevent the Gemini CLI from re-expanding them
      expect(result).toContain("Compare a.ts and b.ts");
      expect(result).not.toContain("@a.ts and @b.ts");
      // REFERENCE block is appended
      expect(result).toContain("[REFERENCE_CONTENT_START]");
      expect(result).toContain("[REFERENCE_CONTENT_END]");
      expect(result).toContain("Content from @a.ts:");
      expect(result).toContain("const a = 1;");
      expect(result).toContain("Content from @b.ts:");
      expect(result).toContain("const b = 2;");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("expands three @file tokens correctly", async () => {
    const dir = await makeTmpDir({
      "a.ts": "// a",
      "b.ts": "// b",
      "c.ts": "// c",
    });
    try {
      const prompt = "Look at @a.ts, @b.ts, and @c.ts";
      const result = await expandFileRefs(prompt, dir);

      expect(result).toContain("Content from @a.ts:");
      expect(result).toContain("Content from @b.ts:");
      expect(result).toContain("Content from @c.ts:");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("resolves multiple @file refs and preserves section order", async () => {
    const dir = await makeTmpDir({
      "a.ts": "A",
      "b.ts": "B",
      "c.ts": "C",
      "d.ts": "D",
    });
    try {
      const result = await expandFileRefs("Review @a.ts @b.ts @c.ts @d.ts", dir);
      const aPos = result.indexOf("Content from @a.ts:\nA");
      const bPos = result.indexOf("Content from @b.ts:\nB");
      const cPos = result.indexOf("Content from @c.ts:\nC");
      const dPos = result.indexOf("Content from @d.ts:\nD");
      expect(aPos).toBeGreaterThan(-1);
      expect(bPos).toBeGreaterThan(aPos);
      expect(cPos).toBeGreaterThan(bPos);
      expect(dPos).toBeGreaterThan(cPos);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("expands a glob pattern (@src/**/*.ts) — all matched files inlined", async () => {
    const dir = await makeTmpDir({
      "src/x.ts": "const x = 1;",
      "src/y.ts": "const y = 2;",
      "b.ts": "const b = 0;",
    });
    try {
      // One glob token + one plain token = 2 file refs → expansion triggered
      const prompt = "Review @src/*.ts and @b.ts";
      const result = await expandFileRefs(prompt, dir);

      expect(result).toContain("[REFERENCE_CONTENT_START]");
      expect(result).toContain("const x = 1;");
      expect(result).toContain("const y = 2;");
      expect(result).toContain("const b = 0;");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("expands @file tokens when the first token is at the start of the prompt string", async () => {
    const dir = await makeTmpDir({ "a.ts": "const a = 1;", "b.ts": "const b = 2;" });
    try {
      // @a.ts is at position 0 — matched by the `^` branch of the regex
      const result = await expandFileRefs("@a.ts and @b.ts", dir);
      expect(result).toContain("Content from @a.ts:");
      expect(result).toContain("Content from @b.ts:");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("does not treat a bare @mention (no dot or slash) as a @file token", async () => {
    const dir = await makeTmpDir({ "b.ts": "const b = 2;" });
    try {
      // @alice has no '.' or '/' so it is not a file ref — count stays at 1, passthrough
      const prompt = "Hey @alice, look at @b.ts";
      const result = await expandFileRefs(prompt, dir);
      expect(result).toBe(prompt); // single file ref → no expansion
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("throws 'File not found' for a non-existent @file path", async () => {
    const dir = await makeTmpDir({ "a.ts": "const a = 1;" });
    try {
      await expect(expandFileRefs("Compare @a.ts and @missing.ts", dir)).rejects.toThrow(
        "File not found: @missing.ts"
      );
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("throws 'File not found' when a glob pattern matches nothing", async () => {
    const dir = await makeTmpDir({ "a.ts": "const a = 1;" });
    try {
      await expect(expandFileRefs("Look at @a.ts and @src/**/*.ts", dir)).rejects.toThrow(
        "File not found: @src/**/*.ts"
      );
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("throws 'Path not in workspace' for a file outside cwd", async () => {
    const dir = await makeTmpDir({ "a.ts": "const a = 1;" });
    try {
      await expect(
        expandFileRefs("Look at @a.ts and @/etc/passwd", dir)
      ).rejects.toThrow("Path not in workspace");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("throws a clear error when cwd does not exist", async () => {
    await expect(
      expandFileRefs("Compare @a.ts and @b.ts", "/nonexistent/path/that/does/not/exist")
    ).rejects.toThrow("does not exist or is not accessible");
  });

  it("throws 'Path not in workspace' for a relative path escaping cwd via ../", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-parent-"));
    const dir = path.join(parent, "workspace");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "a.ts"), "const a = 1;");
    await fs.writeFile(path.join(parent, "escape.ts"), "secret");
    try {
      await expect(
        expandFileRefs("Look at @a.ts and @../escape.ts", dir)
      ).rejects.toThrow("Path not in workspace");
    } finally {
      await fs.rm(parent, { recursive: true });
    }
  });

  it("throws 'Path not in workspace' for a symlink inside cwd that points outside", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-outside-"));
    const dir = await makeTmpDir({ "a.ts": "const a = 1;" });
    await fs.writeFile(path.join(outsideDir, "secret.ts"), "secret");
    await fs.symlink(path.join(outsideDir, "secret.ts"), path.join(dir, "escape.ts"));
    try {
      await expect(
        expandFileRefs("Compare @a.ts and @escape.ts", dir)
      ).rejects.toThrow("Path not in workspace");
    } finally {
      await fs.rm(dir, { recursive: true });
      await fs.rm(outsideDir, { recursive: true });
    }
  });

  it("throws 'is a directory' when an @file path resolves to a directory inside cwd", async () => {
    const dir = await makeTmpDir({ "a.ts": "const a = 1;" });
    await fs.mkdir(path.join(dir, "sub.dir")); // dot required for regex match
    try {
      await expect(
        expandFileRefs("Compare @a.ts and @sub.dir", dir)
      ).rejects.toThrow("is a directory");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  // ── Bracket / paren path support (issue #9) ──────────────────────────────

  it("expands Next.js route group paths with ()", async () => {
    const dir = await makeTmpDir({
      "app/(marketing)/page.tsx": "// marketing page",
      "app/(marketing)/layout.tsx": "// marketing layout",
    });
    try {
      const result = await expandFileRefs(
        "Review @app/(marketing)/page.tsx and @app/(marketing)/layout.tsx",
        dir
      );
      expect(result).toContain("Content from @app/(marketing)/page.tsx:");
      expect(result).toContain("// marketing page");
      expect(result).toContain("Content from @app/(marketing)/layout.tsx:");
      expect(result).toContain("// marketing layout");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("expands Next.js dynamic route paths with []", async () => {
    const dir = await makeTmpDir({
      "app/blog/[slug]/page.tsx": "// blog slug page",
      "lib/utils.ts": "// utils",
    });
    try {
      const result = await expandFileRefs(
        "Compare @app/blog/[slug]/page.tsx and @lib/utils.ts",
        dir
      );
      expect(result).toContain("Content from @app/blog/[slug]/page.tsx:");
      expect(result).toContain("// blog slug page");
      expect(result).toContain("Content from @lib/utils.ts:");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("expands catch-all route paths with nested [[...slug]]", async () => {
    const dir = await makeTmpDir({
      "app/[[...slug]]/page.tsx": "// catch-all page",
      "lib/index.ts": "// lib index",
    });
    try {
      const result = await expandFileRefs(
        "Review @app/[[...slug]]/page.tsx and @lib/index.ts",
        dir
      );
      expect(result).toContain("Content from @app/[[...slug]]/page.tsx:");
      expect(result).toContain("// catch-all page");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("expands intercepting route paths with (.)", async () => {
    const dir = await makeTmpDir({
      "app/(.)photo/page.tsx": "// intercepting photo",
      "app/layout.tsx": "// root layout",
    });
    try {
      const result = await expandFileRefs(
        "Review @app/(.)photo/page.tsx and @app/layout.tsx",
        dir
      );
      expect(result).toContain("Content from @app/(.)photo/page.tsx:");
      expect(result).toContain("// intercepting photo");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("expands paths with mixed () and [] segments", async () => {
    const dir = await makeTmpDir({
      "app/(marketing)/[slug]/page.tsx": "// marketing slug",
      "app/layout.tsx": "// layout",
    });
    try {
      const result = await expandFileRefs(
        "Review @app/(marketing)/[slug]/page.tsx and @app/layout.tsx",
        dir
      );
      expect(result).toContain("Content from @app/(marketing)/[slug]/page.tsx:");
      expect(result).toContain("// marketing slug");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("strips trailing unmatched ] as punctuation — regression guard", async () => {
    const dir = await makeTmpDir({
      "a.ts": "// file a",
      "b.ts": "// file b",
    });
    try {
      // Markdown-style brackets around @file refs
      const result = await expandFileRefs("[see @a.ts and @b.ts]", dir);
      expect(result).toContain("Content from @a.ts:");
      expect(result).toContain("Content from @b.ts:");
      expect(result).not.toContain("Content from @b.ts]:");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("strips trailing :!? punctuation from @file paths", async () => {
    const dir = await makeTmpDir({
      "a.ts": "// file a",
      "b.ts": "// file b",
    });
    try {
      const result = await expandFileRefs("Check @a.ts! Also @b.ts?", dir);
      expect(result).toContain("Content from @a.ts:");
      expect(result).toContain("Content from @b.ts:");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("strips trailing unmatched ) as punctuation — regression guard", async () => {
    const dir = await makeTmpDir({
      "a.ts": "// file a",
      "b.ts": "// file b",
    });
    try {
      // The outer parens are sentence punctuation, not part of the path
      const result = await expandFileRefs("(see @a.ts and @b.ts)", dir);
      expect(result).toContain("Content from @a.ts:");
      expect(result).toContain("Content from @b.ts:");
      // The trailing ) should NOT be part of the path
      expect(result).not.toContain("Content from @b.ts):");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("expands glob patterns alongside literal bracket paths", async () => {
    const dir = await makeTmpDir({
      "app/[slug]/page.tsx": "// slug page",
      "app/[slug]/layout.tsx": "// slug layout",
      "lib/utils.ts": "// utils",
    });
    try {
      const result = await expandFileRefs(
        "Review @app/[slug]/**/*.tsx and @lib/utils.ts",
        dir
      );
      expect(result).toContain("[REFERENCE_CONTENT_START]");
      expect(result).toContain("// slug page");
      expect(result).toContain("// slug layout");
      expect(result).toContain("// utils");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("expands SvelteKit-style dynamic route paths", async () => {
    const dir = await makeTmpDir({
      "src/routes/[id]/+page.svelte": "<script>// svelte page</script>",
      "src/lib/index.ts": "// lib index",
    });
    try {
      const result = await expandFileRefs(
        "Review @src/routes/[id]/+page.svelte and @src/lib/index.ts",
        dir
      );
      expect(result).toContain("Content from @src/routes/[id]/+page.svelte:");
      expect(result).toContain("// svelte page");
      expect(result).toContain("Content from @src/lib/index.ts:");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});

// ── expandFileRefs — non-file @ patterns (issue #38) ────────────────────────

describe("expandFileRefs — non-file @ patterns (issue #38)", () => {
  async function makeTmpDir(files: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-test-"));
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf-8");
    }
    return dir;
  }

  it("filters Vue @mouseleave.native=\"hideTooltip\" — only real file ref passes through", async () => {
    const dir = await makeTmpDir({ "a.ts": "const a = 1;" });
    try {
      // @mouseleave.native="hideTooltip" contains = and " → blocklisted
      // @a.ts is the only real ref → single ref → passthrough (unchanged)
      const prompt = 'Review @mouseleave.native="hideTooltip" and @a.ts';
      const result = await expandFileRefs(prompt, dir);
      expect(result).toBe(prompt);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("filters Vue @click.prevent=\"save\" — only real file ref passes through", async () => {
    const dir = await makeTmpDir({ "a.ts": "const a = 1;" });
    try {
      const prompt = 'Check @click.prevent="save" in @a.ts';
      const result = await expandFileRefs(prompt, dir);
      expect(result).toBe(prompt);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("filters angle bracket pattern @some.thing<div>", async () => {
    const dir = await makeTmpDir({ "a.ts": "const a = 1;" });
    try {
      const prompt = "Check @some.thing<div> in @a.ts";
      const result = await expandFileRefs(prompt, dir);
      expect(result).toBe(prompt);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("filters backtick pattern @some.thing`text`", async () => {
    const dir = await makeTmpDir({ "a.ts": "const a = 1;" });
    try {
      const prompt = "Check @some.thing`text` in @a.ts";
      const result = await expandFileRefs(prompt, dir);
      expect(result).toBe(prompt);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("filters pipe pattern @some.cmd|grep", async () => {
    const dir = await makeTmpDir({ "a.ts": "const a = 1;" });
    try {
      const prompt = "Check @some.cmd|grep in @a.ts";
      const result = await expandFileRefs(prompt, dir);
      expect(result).toBe(prompt);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("expands two real files alongside a false positive — only real files expanded", async () => {
    const dir = await makeTmpDir({ "a.ts": "const a = 1;", "b.ts": "const b = 2;" });
    try {
      const prompt = 'Fix @click.prevent="save" in @a.ts and @b.ts';
      const result = await expandFileRefs(prompt, dir);
      // Two real refs → expansion triggered
      expect(result).toContain("[REFERENCE_CONTENT_START]");
      expect(result).toContain("Content from @a.ts:");
      expect(result).toContain("Content from @b.ts:");
      expect(result).toContain("const a = 1;");
      expect(result).toContain("const b = 2;");
      // The false-positive token must survive masking with its @ intact
      expect(result).toContain('@click.prevent="save"');
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("real files with () and [] routes still work — no regression from blocklist", async () => {
    const dir = await makeTmpDir({
      "app/(marketing)/page.tsx": "// marketing",
      "app/[slug]/page.tsx": "// slug",
    });
    try {
      const result = await expandFileRefs(
        "Review @app/(marketing)/page.tsx and @app/[slug]/page.tsx",
        dir
      );
      expect(result).toContain("[REFERENCE_CONTENT_START]");
      expect(result).toContain("// marketing");
      expect(result).toContain("// slug");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});

// ── extractFileRefs — edge-case documentation tests ─────────────────────────

describe("expandFileRefs — edge-case non-file @ patterns", () => {
  async function makeTmpDir(files: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-test-"));
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf-8");
    }
    return dir;
  }

  it("ignores bare decorators without dot/slash — @Component, @Injectable", async () => {
    const dir = await makeTmpDir({ "a.ts": "const a = 1;" });
    try {
      // @Component and @Injectable have no dot or slash → not file refs
      const prompt = "The @Component and @Injectable decorators in @a.ts";
      const result = await expandFileRefs(prompt, dir);
      // Only @a.ts detected (single ref → passthrough)
      expect(result).toBe(prompt);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("treats @angular/core as a file ref — has slash", async () => {
    const dir = await makeTmpDir({ "a.ts": "const a = 1;" });
    try {
      // @angular/core has a slash → counted as a file ref (even though it's an npm scope)
      // Together with @a.ts that's 2 refs → expansion attempted → @angular/core not found → error
      await expect(
        expandFileRefs("Import from @angular/core and @a.ts", dir)
      ).rejects.toThrow(/File not found: @angular\/core/);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("ignores email addresses — user@example.com (@ not preceded by whitespace)", async () => {
    const dir = await makeTmpDir({ "a.ts": "const a = 1;" });
    try {
      // GREEDY_AT_RE requires whitespace or start-of-string before @
      // "user@example.com" has "user" immediately before @ → no match
      const prompt = "Contact user@example.com about @a.ts";
      const result = await expandFileRefs(prompt, dir);
      // Only @a.ts detected (single ref → passthrough)
      expect(result).toBe(prompt);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("ignores CSS at-rules without dot/slash — @media, @keyframes", async () => {
    const dir = await makeTmpDir({ "a.ts": "const a = 1;" });
    try {
      // @media and @keyframes have no dot or slash → not file refs
      const prompt = "Check @media and @keyframes in @a.ts";
      const result = await expandFileRefs(prompt, dir);
      expect(result).toBe(prompt);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});

// ── expandRefs opt-out flag ─────────────────────────────────────────────────

describe("runGemini — expandRefs opt-out (issue #38)", () => {
  it("expandRefs: false skips file expansion even with multiple @file tokens", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "ok" });
    await runGemini("Compare @a.ts and @b.ts", { cwd: "/some/dir", expandRefs: false }, exec);

    const args = vi.mocked(exec).mock.calls[0][0];
    const promptArg = args[args.indexOf("--prompt") + 1];
    // No expansion — raw prompt passed through
    expect(promptArg).toBe("Compare @a.ts and @b.ts");
    expect(promptArg).not.toContain("[REFERENCE_CONTENT_START]");
  });

  it("expandRefs: false skips the 'multiple @file tokens require cwd' guard", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "ok" });
    // No cwd + multiple @file tokens — normally throws, but expandRefs: false skips the guard
    await expect(
      runGemini("Compare @a.ts and @b.ts", { expandRefs: false }, exec)
    ).resolves.toBe("ok");
  });

  it("default behavior (no expandRefs flag) still expands files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-test-"));
    await fs.writeFile(path.join(dir, "a.ts"), "const a = 1;");
    await fs.writeFile(path.join(dir, "b.ts"), "const b = 2;");
    try {
      const exec = vi.fn().mockResolvedValue({ stdout: "ok" });
      await runGemini("Compare @a.ts and @b.ts", { cwd: dir }, exec);

      const args = vi.mocked(exec).mock.calls[0][0];
      const promptArg = args[args.indexOf("--prompt") + 1];
      expect(promptArg).toContain("[REFERENCE_CONTENT_START]");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});

// ── runGemini @file integration ─────────────────────────────────────────────

describe("runGemini — @file integration", () => {
  async function makeTmpDir(files: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-test-"));
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf-8");
    }
    return dir;
  }

  it("passes a single-@file prompt to the executor unchanged when cwd is set", async () => {
    const dir = await makeTmpDir({ "a.ts": "const a = 1;" });
    try {
      const exec = vi.fn().mockResolvedValue({ stdout: "ok" });
      await runGemini("Review @a.ts", { cwd: dir }, exec);

      const args = vi.mocked(exec).mock.calls[0][0];
      const promptArg = args[args.indexOf("--prompt") + 1];
      // Single @file — no REFERENCE block injected
      expect(promptArg).toBe("Review @a.ts");
      expect(promptArg).not.toContain("[REFERENCE_CONTENT_START]");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("passes expanded REFERENCE block to executor when cwd is set and 2+ @file tokens present", async () => {
    const dir = await makeTmpDir({ "a.ts": "const a = 1;", "b.ts": "const b = 2;" });
    try {
      const exec = vi.fn().mockResolvedValue({ stdout: "ok" });
      await runGemini("Compare @a.ts and @b.ts", { cwd: dir }, exec);

      const args = vi.mocked(exec).mock.calls[0][0];
      const promptArg = args[args.indexOf("--prompt") + 1];
      expect(promptArg).toContain("[REFERENCE_CONTENT_START]");
      expect(promptArg).toContain("const a = 1;");
      expect(promptArg).toContain("const b = 2;");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});

// ── runGemini cache ──────────────────────────────────────────────────────────

describe("runGemini cache", () => {
  it("caches identical calls — executor called once for two identical calls", async () => {
    const { runGemini: run } = await loadRunnerWithEnv({
      GEMINI_CACHE_TTL_MS: "60000",
      GEMINI_CACHE_MAX_ENTRIES: "50",
    });
    const exec = vi.fn().mockResolvedValue({ stdout: "cached result" });
    const result1 = await run("What is 2+2?", {}, exec);
    const result2 = await run("What is 2+2?", {}, exec);
    expect(result1).toBe("cached result");
    expect(result2).toBe("cached result");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("GEMINI_CACHE_TTL_MS=0 disables cache — executor called twice", async () => {
    const { runGemini: run } = await loadRunnerWithEnv({
      GEMINI_CACHE_TTL_MS: "0",
      GEMINI_CACHE_MAX_ENTRIES: "50",
    });
    const exec = vi.fn().mockResolvedValue({ stdout: "fresh result" });
    await run("What is 2+2?", {}, exec);
    await run("What is 2+2?", {}, exec);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("expired entry triggers a fresh call — executor called again after TTL", async () => {
    vi.useFakeTimers();
    try {
      const { runGemini: run } = await loadRunnerWithEnv({
        GEMINI_CACHE_TTL_MS: "1000",
        GEMINI_CACHE_MAX_ENTRIES: "50",
      });
      const exec = vi.fn().mockResolvedValue({ stdout: "fresh" });
      await run("hello", {}, exec);
      expect(exec).toHaveBeenCalledTimes(1);

      // Advance clock past TTL so the cached entry expires
      vi.advanceTimersByTime(2000);

      await run("hello", {}, exec);
      expect(exec).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sessionId present — no caching — executor called twice", async () => {
    const { runGemini: run } = await loadRunnerWithEnv({
      GEMINI_CACHE_TTL_MS: "60000",
      GEMINI_CACHE_MAX_ENTRIES: "50",
    });
    const exec = vi.fn().mockResolvedValue({ stdout: "session result" });
    await run("hello", { sessionId: "sess-1" }, exec);
    await run("hello", { sessionId: "sess-1" }, exec);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("FIFO eviction with GEMINI_CACHE_MAX_ENTRIES=2 — oldest evicted, newer preserved", async () => {
    const { runGemini: run } = await loadRunnerWithEnv({
      GEMINI_CACHE_TTL_MS: "60000",
      GEMINI_CACHE_MAX_ENTRIES: "2",
    });
    let callCount = 0;
    const exec = vi.fn().mockImplementation(async () => {
      callCount++;
      return { stdout: `result-${callCount}` };
    });

    // Fill cache to max: [A, B]
    await run("prompt-A", {}, exec);
    await run("prompt-B", {}, exec);
    expect(exec).toHaveBeenCalledTimes(2);

    // Overflow: C evicts oldest (A); cache is now [B, C]
    await run("prompt-C", {}, exec);
    expect(exec).toHaveBeenCalledTimes(3);

    // B and C are still cached — no more executor calls
    await run("prompt-B", {}, exec);
    await run("prompt-C", {}, exec);
    expect(exec).toHaveBeenCalledTimes(3);

    // A was evicted — executor must be called again
    await run("prompt-A", {}, exec);
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it("different model option produces a different cache key — both calls execute", async () => {
    const { runGemini: run } = await loadRunnerWithEnv({
      GEMINI_CACHE_TTL_MS: "60000",
      GEMINI_CACHE_MAX_ENTRIES: "50",
    });
    const exec = vi.fn().mockResolvedValue({ stdout: "ok" });
    await run("What is 1+1?", { model: "gemini-pro" }, exec);
    await run("What is 1+1?", { model: "gemini-flash" }, exec);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("different cwd option produces a different cache key — both calls execute", async () => {
    const { runGemini: run } = await loadRunnerWithEnv({
      GEMINI_CACHE_TTL_MS: "60000",
      GEMINI_CACHE_MAX_ENTRIES: "50",
    });
    const exec = vi.fn().mockResolvedValue({ stdout: "ok" });
    await run("What is 1+1?", { cwd: "/project/a" }, exec);
    await run("What is 1+1?", { cwd: "/project/b" }, exec);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("GEMINI_CACHE_MAX_ENTRIES=0 throws at import", async () => {
    await expect(
      loadRunnerWithEnv({ GEMINI_CACHE_MAX_ENTRIES: "0", GEMINI_CACHE_TTL_MS: "60000" })
    ).rejects.toThrow("GEMINI_CACHE_MAX_ENTRIES must be a positive integer");
  });
});

// ── spawnGemini (NDJSON stream-json parsing) ─────────────────────────────────

import { EventEmitter } from "node:events";

/**
 * Build a fake ChildProcess-like EventEmitter with controllable stdout/stderr
 * streams that spawnGemini can attach to.
 */
function makeFakeProcess() {
  const proc = new EventEmitter() as NodeJS.EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: () => void };
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { end: vi.fn() };
  proc.kill = vi.fn();
  return proc;
}

describe("spawnGemini — NDJSON parsing", () => {
  it("accumulates message events and resolves on result:success", async () => {
    const chunks: string[] = [];
    const result = await new Promise<string>((resolve, reject) => {
      const cp = spawnGemini(
        ["--yolo", "--output-format", "stream-json", "--prompt", "hi"],
        { env: { HOME: "/home/test", PATH: "/usr/bin" }, timeout: 5000 },
        (chunk) => chunks.push(chunk),
        resolve,
        reject
      );

      // Feed NDJSON events via stdout
      const lines = [
        JSON.stringify({ type: "init", session_id: "s1", model: "gemini-flash" }),
        JSON.stringify({ type: "message", role: "assistant", content: "Hello ", delta: true }),
        JSON.stringify({ type: "message", role: "assistant", content: "world", delta: true }),
        JSON.stringify({ type: "result", status: "success" }),
      ].join("\n") + "\n";

      (cp as unknown as { stdout: EventEmitter }).stdout.emit("data", Buffer.from(lines));
      (cp as unknown as EventEmitter).emit("close", 0);
    });

    expect(result).toBe("Hello world");
    expect(chunks).toEqual(["Hello ", "world"]);
  });

  it("handles chunked data split across multiple 'data' events", async () => {
    const result = await new Promise<string>((resolve, reject) => {
      const cp = spawnGemini(
        [],
        { env: { HOME: "/home/test", PATH: "/usr/bin" }, timeout: 5000 },
        () => {},
        resolve,
        reject
      );

      const full = JSON.stringify({ type: "message", role: "assistant", content: "chunk" });
      const resultLine = JSON.stringify({ type: "result", status: "success" });

      // Split the line artificially across two data events
      const stdout = (cp as unknown as { stdout: EventEmitter }).stdout;
      stdout.emit("data", Buffer.from(full.slice(0, 10)));
      stdout.emit("data", Buffer.from(full.slice(10) + "\n" + resultLine + "\n"));
      (cp as unknown as EventEmitter).emit("close", 0);
    });

    expect(result).toBe("chunk");
  });

  it("rejects with GeminiOutputError on result:error event", async () => {
    const err = await new Promise<Error>((resolve, reject) => {
      const cp = spawnGemini(
        [],
        { env: { HOME: "/home/test", PATH: "/usr/bin" }, timeout: 5000 },
        () => {},
        () => reject(new Error("should not resolve")),
        resolve
      );

      const lines = [
        JSON.stringify({ type: "result", status: "error", error: "quota exceeded" }),
      ].join("\n") + "\n";

      (cp as unknown as { stdout: EventEmitter }).stdout.emit("data", Buffer.from(lines));
      (cp as unknown as EventEmitter).emit("close", 1);
    });

    expect(err).toBeInstanceOf(GeminiOutputError);
    expect(err.message).toContain("quota exceeded");
  });

  it("rejects with GeminiOutputError on error event in stream", async () => {
    const err = await new Promise<Error>((resolve, reject) => {
      const cp = spawnGemini(
        [],
        { env: { HOME: "/home/test", PATH: "/usr/bin" }, timeout: 5000 },
        () => {},
        () => reject(new Error("should not resolve")),
        resolve
      );

      const lines = [
        JSON.stringify({ type: "error", severity: "fatal", message: "stream error occurred" }),
      ].join("\n") + "\n";

      (cp as unknown as { stdout: EventEmitter }).stdout.emit("data", Buffer.from(lines));
      (cp as unknown as EventEmitter).emit("close", 1);
    });

    expect(err).toBeInstanceOf(GeminiOutputError);
    expect(err.message).toContain("stream error occurred");
  });

  it("rejects with 'gemini binary not found' on ENOENT process error", async () => {
    const err = await new Promise<Error>((resolve, reject) => {
      const cp = spawnGemini(
        [],
        { env: { HOME: "/home/test", PATH: "/usr/bin" }, timeout: 5000 },
        () => {},
        () => reject(new Error("should not resolve")),
        resolve
      );

      (cp as unknown as EventEmitter).emit(
        "error",
        Object.assign(new Error("spawn gemini ENOENT"), { code: "ENOENT" })
      );
    });

    expect(err.message).toContain("gemini binary not found");
  });

  it("rejects with GeminiOutputError on non-zero exit code without result event", async () => {
    const err = await new Promise<Error>((resolve, reject) => {
      const cp = spawnGemini(
        [],
        { env: { HOME: "/home/test", PATH: "/usr/bin" }, timeout: 5000 },
        () => {},
        () => reject(new Error("should not resolve")),
        resolve
      );

      // No stdout data — process just exits non-zero
      (cp as unknown as EventEmitter).emit("close", 1);
    });

    expect(err).toBeInstanceOf(GeminiOutputError);
    expect(err.message).toContain("exited with code 1");
  });

  it("skips non-JSON lines without throwing", async () => {
    const result = await new Promise<string>((resolve, reject) => {
      const cp = spawnGemini(
        [],
        { env: { HOME: "/home/test", PATH: "/usr/bin" }, timeout: 5000 },
        () => {},
        resolve,
        reject
      );

      const lines = [
        "this is debug output, not JSON",
        JSON.stringify({ type: "message", role: "assistant", content: "ok" }),
        JSON.stringify({ type: "result", status: "success" }),
      ].join("\n") + "\n";

      (cp as unknown as { stdout: EventEmitter }).stdout.emit("data", Buffer.from(lines));
      (cp as unknown as EventEmitter).emit("close", 0);
    });

    expect(result).toBe("ok");
  });

  it("only accumulates assistant messages (not user or tool messages)", async () => {
    const chunks: string[] = [];
    const result = await new Promise<string>((resolve, reject) => {
      const cp = spawnGemini(
        [],
        { env: { HOME: "/home/test", PATH: "/usr/bin" }, timeout: 5000 },
        (c) => chunks.push(c),
        resolve,
        reject
      );

      const lines = [
        JSON.stringify({ type: "message", role: "user", content: "should be ignored" }),
        JSON.stringify({ type: "message", role: "assistant", content: "actual response" }),
        JSON.stringify({ type: "result", status: "success" }),
      ].join("\n") + "\n";

      (cp as unknown as { stdout: EventEmitter }).stdout.emit("data", Buffer.from(lines));
      (cp as unknown as EventEmitter).emit("close", 0);
    });

    expect(result).toBe("actual response");
    expect(chunks).toEqual(["actual response"]);
  });

  // ── error detail extraction (#65) ──────────────────────────────────────────

  it("result:error with object e.error is JSON.stringified", async () => {
    const err = await new Promise<Error>((resolve, reject) => {
      const cp = spawnGemini(
        [],
        { env: { HOME: "/home/test", PATH: "/usr/bin" }, timeout: 5000 },
        () => {},
        () => reject(new Error("should not resolve")),
        resolve
      );

      const errorObj = { code: "RESOURCE_EXHAUSTED", details: "rate limit" };
      const lines = JSON.stringify({
        type: "result", status: "error", error: errorObj,
      }) + "\n";

      (cp as unknown as { stdout: EventEmitter }).stdout.emit("data", Buffer.from(lines));
      (cp as unknown as EventEmitter).emit("close", 1);
    });

    expect(err).toBeInstanceOf(GeminiOutputError);
    expect(err.message).toContain("RESOURCE_EXHAUSTED");
  });

  it("result:error with no error/message logs unrecognized event", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const err = await new Promise<Error>((resolve, reject) => {
      const cp = spawnGemini(
        [],
        { env: { HOME: "/home/test", PATH: "/usr/bin" }, timeout: 5000 },
        () => {},
        () => reject(new Error("should not resolve")),
        resolve
      );

      const lines = JSON.stringify({ type: "result", status: "error" }) + "\n";

      (cp as unknown as { stdout: EventEmitter }).stdout.emit("data", Buffer.from(lines));
      (cp as unknown as EventEmitter).emit("close", 1);
    });

    expect(err.message).toContain("(unknown)");
    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("unrecognized error event");
    stderrSpy.mockRestore();
  });

  it("type:error with object e.message is JSON.stringified", async () => {
    const err = await new Promise<Error>((resolve, reject) => {
      const cp = spawnGemini(
        [],
        { env: { HOME: "/home/test", PATH: "/usr/bin" }, timeout: 5000 },
        () => {},
        () => reject(new Error("should not resolve")),
        resolve
      );

      const lines = JSON.stringify({
        type: "error", message: { detail: "bad request" },
      }) + "\n";

      (cp as unknown as { stdout: EventEmitter }).stdout.emit("data", Buffer.from(lines));
      (cp as unknown as EventEmitter).emit("close", 1);
    });

    expect(err).toBeInstanceOf(GeminiOutputError);
    expect(err.message).toContain("bad request");
  });

  it("non-zero exit includes stderr tail in error message", async () => {
    const err = await new Promise<Error>((resolve, reject) => {
      const cp = spawnGemini(
        [],
        { env: { HOME: "/home/test", PATH: "/usr/bin" }, timeout: 5000 },
        () => {},
        () => reject(new Error("should not resolve")),
        resolve
      );

      // emit stderr before close
      (cp as unknown as { stderr: EventEmitter }).stderr.emit(
        "data", Buffer.from("Error: auth token expired\n")
      );
      (cp as unknown as EventEmitter).emit("close", 1);
    });

    expect(err).toBeInstanceOf(GeminiOutputError);
    expect(err.message).toContain("auth token expired");
    expect(err.message).toContain("code 1");
  });
});

// ── SemaphoreTimeoutError ───────────────────────────────────────────────────

describe("SemaphoreTimeoutError typed class", () => {
  it("is thrown by runGemini when concurrency slot times out", async () => {
    const { runGemini: freshRunGemini, SemaphoreTimeoutError } = await loadRunnerWithEnv({
      GEMINI_MAX_CONCURRENT: "1",
      GEMINI_QUEUE_TIMEOUT_MS: "10",
      GEMINI_MAX_RETRIES: "0",
      GEMINI_POOL_ENABLED: "0",
      GEMINI_CACHE_TTL_MS: "0",
    });

    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const slowExecutor = () =>
      new Promise<{ stdout: string }>((resolve) => {
        releaseFirst = () => resolve({ stdout: "done" });
        markFirstStarted?.();
      });

    const firstPromise = freshRunGemini("first", {}, slowExecutor as never);
    await firstStarted;

    try {
      await expect(
        freshRunGemini("second", {}, slowExecutor as never)
      ).rejects.toBeInstanceOf(SemaphoreTimeoutError);
    } finally {
      releaseFirst?.();
      await firstPromise.catch(() => {});
    }
  });

  it("SemaphoreTimeoutError has correct name, message and class identity", async () => {
    const { SemaphoreTimeoutError } = await import("../src/gemini-runner.js");
    const err = new SemaphoreTimeoutError(5000);
    expect(err.name).toBe("SemaphoreTimeoutError");
    expect(err.message).toContain("5000ms");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SemaphoreTimeoutError);
  });
});

// ── Cache TTL and eviction ──────────────────────────────────────────────────

describe("response cache TTL and eviction", () => {
  afterEach(() => {
    delete process.env.GEMINI_CACHE_TTL_MS;
    delete process.env.GEMINI_CACHE_MAX_ENTRIES;
    delete process.env.GEMINI_MAX_RETRIES;
    delete process.env.GEMINI_MAX_CONCURRENT;
    delete process.env.GEMINI_QUEUE_TIMEOUT_MS;
    process.env.GEMINI_POOL_ENABLED = "0";
  });

  it("cache hit within TTL returns cached value without calling executor", async () => {
    const { runGemini: freshRunGemini } = await loadRunnerWithEnv({
      GEMINI_CACHE_TTL_MS: "60000",
      GEMINI_CACHE_MAX_ENTRIES: "50",
      GEMINI_POOL_ENABLED: "0",
      GEMINI_MAX_RETRIES: "0",
    });

    let callCount = 0;
    const executor = vi.fn(async () => {
      callCount++;
      return { stdout: `response-${callCount}` };
    });

    const first = await freshRunGemini("hello", {}, executor as never);
    const second = await freshRunGemini("hello", {}, executor as never);

    expect(first).toBe("response-1");
    expect(second).toBe("response-1");
    expect(callCount).toBe(1);
  });

  it("cache miss when TTL is 0 (disabled)", async () => {
    const { runGemini: freshRunGemini } = await loadRunnerWithEnv({
      GEMINI_CACHE_TTL_MS: "0",
      GEMINI_POOL_ENABLED: "0",
      GEMINI_MAX_RETRIES: "0",
    });

    let callCount = 0;
    const executor = vi.fn(async () => {
      callCount++;
      return { stdout: `response-${callCount}` };
    });

    const first = await freshRunGemini("hello", {}, executor as never);
    const second = await freshRunGemini("hello", {}, executor as never);

    expect(first).toBe("response-1");
    expect(second).toBe("response-2");
    expect(callCount).toBe(2);
  });

  it("FIFO eviction when CACHE_MAX_ENTRIES is exceeded", async () => {
    const { runGemini: freshRunGemini } = await loadRunnerWithEnv({
      GEMINI_CACHE_TTL_MS: "60000",
      GEMINI_CACHE_MAX_ENTRIES: "2",
      GEMINI_POOL_ENABLED: "0",
      GEMINI_MAX_RETRIES: "0",
    });

    let callCount = 0;
    const executor = vi.fn(async () => {
      callCount++;
      return { stdout: `response-${callCount}` };
    });

    await freshRunGemini("prompt-A", {}, executor as never);
    await freshRunGemini("prompt-B", {}, executor as never);
    expect(callCount).toBe(2);

    await freshRunGemini("prompt-C", {}, executor as never);
    expect(callCount).toBe(3);

    await freshRunGemini("prompt-A", {}, executor as never);
    expect(callCount).toBe(4);

    await freshRunGemini("prompt-C", {}, executor as never);
    expect(callCount).toBe(4);
  });
});

// ── Temp file cleanup ───────────────────────────────────────────────────────

describe("temp file cleanup on large prompts", () => {
  it("deletes the temp file even when the executor throws", async () => {
    process.env.GEMINI_POOL_ENABLED = "0";
    process.env.GEMINI_MAX_RETRIES = "0";
    process.env.GEMINI_CACHE_TTL_MS = "0";
    vi.resetModules();

    vi.doMock("node:fs/promises", async (importOriginal) => {
      const original = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...original,
        writeFile: vi.fn(original.writeFile),
        unlink: vi.fn(original.unlink),
      };
    });

    try {
      const { runGemini: freshRunGemini } = await import("../src/gemini-runner.js");
      const mockedFs = await import("node:fs/promises");

      const largePrompt = "x".repeat(115 * 1024);
      const executor = vi.fn().mockRejectedValue(new Error("subprocess crashed"));

      await expect(
        freshRunGemini(largePrompt, {}, executor as never)
      ).rejects.toThrow("subprocess crashed");

      const unlinkCalls = vi.mocked(mockedFs.unlink).mock.calls;
      expect(unlinkCalls.length).toBeGreaterThanOrEqual(1);
      const tempPath = String(unlinkCalls[0][0]);
      expect(tempPath).toMatch(/gemini-prompt-.*\.txt$/);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});

// ── getEnvOverrides – GEMINI_MODELS and GEMINI_BINARY passthrough ────────────

describe("getEnvOverrides env passthrough", () => {
  it("includes GEMINI_MODELS in overrides when set", async () => {
    vi.resetModules();
    process.env.GEMINI_MODELS = "model-a,model-b";
    try {
      const { getEnvOverrides } = await import("../src/gemini-runner.js");
      const overrides = getEnvOverrides();
      expect(overrides.GEMINI_MODELS).toBe("model-a,model-b");
    } finally {
      delete process.env.GEMINI_MODELS;
      vi.resetModules();
    }
  });

  it("omits GEMINI_MODELS from overrides when not set", async () => {
    vi.resetModules();
    delete process.env.GEMINI_MODELS;
    try {
      const { getEnvOverrides } = await import("../src/gemini-runner.js");
      const overrides = getEnvOverrides();
      expect(overrides).not.toHaveProperty("GEMINI_MODELS");
    } finally {
      vi.resetModules();
    }
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  runGemini,
  parseGeminiOutput,
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

  it("throws on non-JSON input", () => {
    expect(() => parseGeminiOutput("not json at all")).toThrow(
      "gemini returned non-JSON output"
    );
  });

  it("non-JSON error includes up to 2000 chars of raw output", () => {
    const longRaw = "X".repeat(3000);
    try {
      parseGeminiOutput(longRaw);
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

  it("unexpected shape error includes the parsed object for debugging", () => {
    const obj = { mystery: "clue" };
    try {
      parseGeminiOutput(JSON.stringify(obj));
    } catch (err) {
      expect((err as Error).message).toContain('"mystery"');
    }
  });

  it("handles empty string response field (empty is valid, not an error)", () => {
    expect(parseGeminiOutput(JSON.stringify({ response: "" }))).toBe("");
  });
});

// ── runGemini (uses injectable executor — no real subprocess) ────────────────

/** Helper: create a mock executor that resolves with given stdout */
function makeExecutor(stdout: string): GeminiExecutor {
  return vi.fn().mockResolvedValue({ stdout });
}

/** Helper: create a mock executor that rejects */
function makeErrorExecutor(
  err: Partial<Error & { stderr?: string }>
): GeminiExecutor {
  return vi.fn().mockRejectedValue(err);
}

describe("runGemini", () => {
  it("resolves with parsed response text on success", async () => {
    const exec = makeExecutor(JSON.stringify({ response: "The capital is Paris." }));
    const result = await runGemini("What is the capital of France?", {}, exec);
    expect(result).toBe("The capital is Paris.");
  });

  // ── Args construction ──────────────────────────────────────────────────────

  it("always passes --yolo, --output-format json, and --prompt flags", async () => {
    const exec = makeExecutor(JSON.stringify({ response: "ok" }));
    await runGemini("my prompt", {}, exec);

    const capturedArgs = vi.mocked(exec).mock.calls[0][0];
    expect(capturedArgs).toContain("--yolo");
    expect(capturedArgs).toContain("--output-format");
    expect(capturedArgs).toContain("json");
    expect(capturedArgs).toContain("--prompt");
    expect(capturedArgs).toContain("my prompt");
  });

  it("prompt is passed as a single array element (not split on spaces)", async () => {
    const prompt = "summarize; rm -rf /; echo pwned";
    const exec = makeExecutor(JSON.stringify({ response: "ok" }));
    await runGemini(prompt, {}, exec);

    const args = vi.mocked(exec).mock.calls[0][0];
    const promptIndex = args.indexOf("--prompt");
    // The whole prompt string is the element immediately after --prompt
    expect(args[promptIndex + 1]).toBe(prompt);
    // It is NOT split into multiple elements
    expect(args).toHaveLength(5); // --yolo --output-format json --prompt <prompt>
  });

  it("appends --model flag when model option is provided", async () => {
    const exec = makeExecutor(JSON.stringify({ response: "ok" }));
    await runGemini("hello", { model: "gemini-2.5-pro" }, exec);

    const args = vi.mocked(exec).mock.calls[0][0];
    expect(args).toContain("--model");
    expect(args).toContain("gemini-2.5-pro");
    expect(args).toHaveLength(7); // base 5 + --model <model>
  });

  it("does NOT append --model flag when model is not provided", async () => {
    const exec = makeExecutor(JSON.stringify({ response: "ok" }));
    await runGemini("hello", {}, exec);

    const args = vi.mocked(exec).mock.calls[0][0];
    expect(args).not.toContain("--model");
  });

  // ── Environment isolation ──────────────────────────────────────────────────

  it("passes only HOME and PATH in env (no other vars)", async () => {
    const exec = makeExecutor(JSON.stringify({ response: "ok" }));
    await runGemini("hello", {}, exec);

    const capturedOpts = vi.mocked(exec).mock.calls[0][1];
    const envKeys = Object.keys(capturedOpts.env);
    expect(envKeys.sort()).toEqual(["HOME", "PATH"]);
  });

  it("passes cwd option through to executor", async () => {
    const exec = makeExecutor(JSON.stringify({ response: "ok" }));
    await runGemini("hello", { cwd: "/some/project" }, exec);

    const capturedOpts = vi.mocked(exec).mock.calls[0][1];
    expect(capturedOpts.cwd).toBe("/some/project");
  });

  it("cwd is undefined when not specified", async () => {
    const exec = makeExecutor(JSON.stringify({ response: "ok" }));
    await runGemini("hello", {}, exec);

    const capturedOpts = vi.mocked(exec).mock.calls[0][1];
    expect(capturedOpts.cwd).toBeUndefined();
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  it("wraps executor rejection with stderr detail when available", async () => {
    const exec = makeErrorExecutor({ stderr: "authentication error", message: "exit code 1" });
    await expect(runGemini("hello", {}, exec)).rejects.toThrow(
      "gemini process failed: authentication error"
    );
  });

  it("falls back to error.message when stderr is empty", async () => {
    const exec = makeErrorExecutor({ stderr: "", message: "ETIMEDOUT" });
    await expect(runGemini("hello", {}, exec)).rejects.toThrow(
      "gemini process failed: ETIMEDOUT"
    );
  });

  it("propagates JSON parse errors from parseGeminiOutput", async () => {
    const exec = makeExecutor("this is not json");
    await expect(runGemini("hello", {}, exec)).rejects.toThrow(
      "gemini returned non-JSON output"
    );
  });

  it("propagates gemini error field from parseGeminiOutput", async () => {
    const exec = makeExecutor(JSON.stringify({ error: "quota exceeded" }));
    await expect(runGemini("hello", {}, exec)).rejects.toThrow(
      "gemini error: quota exceeded"
    );
  });
});

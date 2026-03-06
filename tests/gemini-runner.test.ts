import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  runGemini,
  parseGeminiOutput,
  expandFileRefs,
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

  it("uses the default PATH when PATH is not set", async () => {
    const originalPath = process.env.PATH;
    delete process.env.PATH;

    try {
      const exec = makeExecutor(JSON.stringify({ response: "ok" }));
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

  it("passes 60-second timeout to executor", async () => {
    const exec = makeExecutor(JSON.stringify({ response: "ok" }));
    await runGemini("hello", {}, exec);

    const capturedOpts = vi.mocked(exec).mock.calls[0][1];
    expect(capturedOpts.timeout).toBe(60_000);
  });

  it("passes 10 MB maxBuffer to executor", async () => {
    const exec = makeExecutor(JSON.stringify({ response: "ok" }));
    await runGemini("hello", {}, exec);

    const capturedOpts = vi.mocked(exec).mock.calls[0][1];
    expect(capturedOpts.maxBuffer).toBe(10 * 1024 * 1024);
  });

  it("fails fast when HOME is not set", async () => {
    const originalHome = process.env.HOME;
    delete process.env.HOME;

    try {
      const exec = makeExecutor(JSON.stringify({ response: "ok" }));
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
    const exec = makeErrorExecutor({ stderr: "", message: "ETIMEDOUT" });
    await expect(runGemini("hello", {}, exec)).rejects.toThrow(
      "gemini process failed: ETIMEDOUT"
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

  it("throws when 2+ @file tokens are present and cwd is not provided", async () => {
    const exec = makeExecutor(JSON.stringify({ response: "ok" }));
    await expect(
      runGemini("Read @src/a.ts and @src/b.ts", {}, exec)
    ).rejects.toThrow("Multiple @file tokens require the cwd option");
    expect(exec).not.toHaveBeenCalled();
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

  it("expands two @file tokens: keeps @tokens in text and appends REFERENCE block", async () => {
    const dir = await makeTmpDir({
      "a.ts": "const a = 1;",
      "b.ts": "const b = 2;",
    });
    try {
      const prompt = "Compare @a.ts and @b.ts";
      const result = await expandFileRefs(prompt, dir);

      // Original prompt text is unchanged
      expect(result).toContain("Compare @a.ts and @b.ts");
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
      const exec = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ response: "ok" }) });
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
      const exec = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ response: "ok" }) });
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

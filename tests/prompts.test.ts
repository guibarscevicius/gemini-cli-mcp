import { describe, it, expect } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { PROMPTS, listPrompts, getPrompt } from "../src/prompts.js";

// ---------------------------------------------------------------------------
// PROMPTS array
// ---------------------------------------------------------------------------

describe("PROMPTS definitions", () => {
  it("has exactly 4 prompts", () => {
    expect(PROMPTS).toHaveLength(4);
  });

  it("has the correct prompt names", () => {
    const names = PROMPTS.map((p) => p.name);
    expect(names).toContain("code-review");
    expect(names).toContain("architecture-analysis");
    expect(names).toContain("explain-code");
    expect(names).toContain("debug-error");
  });

  it("marks required args as required", () => {
    const getArgs = (name: string) =>
      PROMPTS.find((p) => p.name === name)!.arguments ?? [];

    const codeReviewRequired = getArgs("code-review")
      .filter((a) => a.required)
      .map((a) => a.name);
    expect(codeReviewRequired).toContain("files");
    expect(codeReviewRequired).not.toContain("cwd");
    expect(codeReviewRequired).not.toContain("focus");

    const archRequired = getArgs("architecture-analysis")
      .filter((a) => a.required)
      .map((a) => a.name);
    expect(archRequired).toContain("directory");
    expect(archRequired).not.toContain("cwd");
    expect(archRequired).not.toContain("question");

    const explainRequired = getArgs("explain-code")
      .filter((a) => a.required)
      .map((a) => a.name);
    expect(explainRequired).toContain("file");
    expect(explainRequired).not.toContain("cwd");
    expect(explainRequired).not.toContain("symbol");
    expect(explainRequired).not.toContain("audience");

    const debugRequired = getArgs("debug-error")
      .filter((a) => a.required)
      .map((a) => a.name);
    expect(debugRequired).toContain("error");
    expect(debugRequired).not.toContain("files");
    expect(debugRequired).not.toContain("context");
    expect(debugRequired).not.toContain("cwd");
  });
});

// ---------------------------------------------------------------------------
// listPrompts
// ---------------------------------------------------------------------------

describe("listPrompts()", () => {
  it("returns { prompts: PROMPTS }", () => {
    expect(listPrompts()).toEqual({ prompts: PROMPTS });
  });
});

// ---------------------------------------------------------------------------
// getPrompt — code-review
// ---------------------------------------------------------------------------

describe("getPrompt — code-review", () => {
  it("returns a user message with @file reference", () => {
    const result = getPrompt("code-review", { files: "src/auth.ts", cwd: "/app" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content.type).toBe("text");
    expect(result.messages[0].content.text).toContain("@src/auth.ts");
  });

  it("starts with the cwd comment", () => {
    const result = getPrompt("code-review", { files: "src/auth.ts", cwd: "/app" });
    expect(result.messages[0].content.text).toMatch(
      /^<!-- working directory: \/app -->/
    );
  });

  it("defaults focus to 'all'", () => {
    const result = getPrompt("code-review", { files: "src/auth.ts", cwd: "/app" });
    expect(result.messages[0].content.text).toContain("all issue types");
  });

  it("uses explicit focus when provided", () => {
    const result = getPrompt("code-review", {
      files: "src/auth.ts",
      cwd: "/app",
      focus: "security",
    });
    expect(result.messages[0].content.text).toContain("security issues");
    expect(result.messages[0].content.text).not.toContain("all issue types");
  });

  it("splits multiple files into separate @file refs", () => {
    const result = getPrompt("code-review", {
      files: "src/a.ts src/b.ts",
      cwd: "/app",
    });
    const text = result.messages[0].content.text;
    expect(text).toContain("@src/a.ts");
    expect(text).toContain("@src/b.ts");
  });

  it("filters empty strings from files with leading/trailing whitespace", () => {
    const result = getPrompt("code-review", {
      files: " src/a.ts  src/b.ts ",
      cwd: "/app",
    });
    const text = result.messages[0].content.text;
    expect(text).toContain("@src/a.ts");
    expect(text).toContain("@src/b.ts");
    expect(text).not.toContain("@ ");
  });

  it("throws McpError for invalid focus value", () => {
    expect(() =>
      getPrompt("code-review", {
        files: "src/auth.ts",
        cwd: "/app",
        focus: "invalid",
      })
    ).toThrow(McpError);
  });

  it("throws McpError when 'files' is missing", () => {
    expect(() => getPrompt("code-review", { cwd: "/app" })).toThrow(McpError);
  });

  it("throws McpError when 'files' is empty string", () => {
    expect(() => getPrompt("code-review", { files: "", cwd: "/app" })).toThrow(McpError);
  });

  it("uses process.cwd() when cwd is not provided", () => {
    const result = getPrompt("code-review", { files: "src/auth.ts" });
    expect(result.messages[0].content.text).toMatch(/^<!-- working directory: .+ -->/);
  });
});

// ---------------------------------------------------------------------------
// getPrompt — architecture-analysis
// ---------------------------------------------------------------------------

describe("getPrompt — architecture-analysis", () => {
  it("embeds @directory reference", () => {
    const result = getPrompt("architecture-analysis", {
      directory: "src/",
      cwd: "/app",
    });
    expect(result.messages[0].content.text).toContain("@src/");
  });

  it("includes specific question when provided", () => {
    const result = getPrompt("architecture-analysis", {
      directory: "src/",
      cwd: "/app",
      question: "How does the session store work?",
    });
    expect(result.messages[0].content.text).toContain(
      "Specifically answer: How does the session store work?"
    );
  });

  it("omits question line when not provided", () => {
    const result = getPrompt("architecture-analysis", {
      directory: "src/",
      cwd: "/app",
    });
    expect(result.messages[0].content.text).not.toContain("Specifically answer:");
  });

  it("throws McpError when 'directory' is missing", () => {
    expect(() => getPrompt("architecture-analysis", { cwd: "/app" })).toThrow(McpError);
  });
});

// ---------------------------------------------------------------------------
// getPrompt — explain-code
// ---------------------------------------------------------------------------

describe("getPrompt — explain-code", () => {
  it("embeds @file reference", () => {
    const result = getPrompt("explain-code", {
      file: "src/auth.ts",
      cwd: "/app",
    });
    expect(result.messages[0].content.text).toContain("@src/auth.ts");
  });

  it("defaults audience to 'intermediate'", () => {
    const result = getPrompt("explain-code", {
      file: "src/auth.ts",
      cwd: "/app",
    });
    expect(result.messages[0].content.text).toContain("intermediate");
  });

  it("uses explicit audience", () => {
    const result = getPrompt("explain-code", {
      file: "src/auth.ts",
      cwd: "/app",
      audience: "expert",
    });
    expect(result.messages[0].content.text).toContain("expert");
  });

  it("includes symbol focus when provided", () => {
    const result = getPrompt("explain-code", {
      file: "src/auth.ts",
      cwd: "/app",
      symbol: "createToken",
    });
    expect(result.messages[0].content.text).toContain("`createToken`");
  });

  it("throws McpError for invalid audience", () => {
    expect(() =>
      getPrompt("explain-code", {
        file: "src/auth.ts",
        cwd: "/app",
        audience: "guru",
      })
    ).toThrow(McpError);
  });

  it("omits symbol focus line when symbol is not provided", () => {
    const result = getPrompt("explain-code", { file: "src/auth.ts", cwd: "/app" });
    expect(result.messages[0].content.text).not.toContain("Focus on the");
  });

  it("throws McpError when 'file' is missing", () => {
    expect(() => getPrompt("explain-code", { cwd: "/app" })).toThrow(McpError);
  });
});

// ---------------------------------------------------------------------------
// getPrompt — debug-error
// ---------------------------------------------------------------------------

describe("getPrompt — debug-error", () => {
  it("includes the error message without cwd comment when cwd is absent", () => {
    const result = getPrompt("debug-error", {
      error: "TypeError: Cannot read property 'x' of undefined",
    });
    const text = result.messages[0].content.text;
    expect(text).toContain("TypeError: Cannot read property");
    expect(text).not.toContain("<!-- working directory:");
  });

  it("includes cwd comment when cwd is provided", () => {
    const result = getPrompt("debug-error", {
      error: "SyntaxError: Unexpected token",
      cwd: "/app",
    });
    expect(result.messages[0].content.text).toMatch(
      /^<!-- working directory: \/app -->/
    );
  });

  it("embeds @file references when files are provided", () => {
    const result = getPrompt("debug-error", {
      error: "ReferenceError: foo is not defined",
      files: "src/foo.ts src/bar.ts",
    });
    const text = result.messages[0].content.text;
    expect(text).toContain("@src/foo.ts");
    expect(text).toContain("@src/bar.ts");
  });

  it("includes additional context when provided", () => {
    const result = getPrompt("debug-error", {
      error: "Error: connection refused",
      context: "This happens after login on slow networks.",
    });
    expect(result.messages[0].content.text).toContain(
      "Additional context: This happens after login on slow networks."
    );
  });

  it("omits context line when context is empty string", () => {
    const result = getPrompt("debug-error", { error: "E", context: "" });
    expect(result.messages[0].content.text).not.toContain("Additional context:");
  });

  it("throws McpError when 'error' is missing", () => {
    expect(() => getPrompt("debug-error", {})).toThrow(McpError);
  });

  it("throws McpError when 'error' is empty string", () => {
    expect(() => getPrompt("debug-error", { error: "" })).toThrow(McpError);
  });

  it("filters empty strings from files with leading/trailing whitespace", () => {
    const result = getPrompt("debug-error", {
      error: "ReferenceError: x is not defined",
      files: " src/a.ts  src/b.ts ",
    });
    const text = result.messages[0].content.text;
    expect(text).toContain("@src/a.ts");
    expect(text).toContain("@src/b.ts");
    expect(text).not.toContain("@ ");
  });
});

// ---------------------------------------------------------------------------
// getPrompt — unknown name
// ---------------------------------------------------------------------------

describe("getPrompt — unknown prompt", () => {
  it("throws McpError with the unknown prompt name", () => {
    expect(() => getPrompt("unknown-prompt", {})).toThrowError(
      /Unknown prompt: unknown-prompt/
    );
  });
});

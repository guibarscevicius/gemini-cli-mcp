import {
  McpError,
  ErrorCode,
  type GetPromptResult,
  type Prompt,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Prompt definitions
// ---------------------------------------------------------------------------

export const PROMPTS: Prompt[] = [
  {
    name: "code-review",
    description:
      "Review code files for issues. Pass file paths/globs as `files`, optionally narrow with `focus`.",
    arguments: [
      {
        name: "files",
        description:
          "Space-separated file paths or globs (e.g. 'src/**/*.ts')",
        required: true,
      },
      {
        name: "focus",
        description:
          "Area to focus on: security|performance|correctness|design|all (default: all)",
        required: false,
      },
      {
        name: "cwd",
        description: "Working directory for @file expansion (defaults to server cwd)",
        required: false,
      },
    ],
  },
  {
    name: "architecture-analysis",
    description:
      "Analyse the architecture of a codebase directory. Optionally answer a specific architectural question.",
    arguments: [
      {
        name: "directory",
        description:
          "Path or glob pattern for the codebase (e.g. 'src/')",
        required: true,
      },
      {
        name: "question",
        description:
          "Specific architectural question to answer (optional)",
        required: false,
      },
      {
        name: "cwd",
        description: "Working directory for @file expansion (defaults to server cwd)",
        required: false,
      },
    ],
  },
  {
    name: "explain-code",
    description:
      "Explain how a source file works, optionally scoped to a single symbol and tailored to an audience level.",
    arguments: [
      {
        name: "file",
        description: "Path to the file to explain",
        required: true,
      },
      {
        name: "symbol",
        description:
          "Specific function, class, or method to focus on (optional)",
        required: false,
      },
      {
        name: "audience",
        description:
          "beginner|intermediate|expert (default: intermediate)",
        required: false,
      },
      {
        name: "cwd",
        description: "Working directory for @file expansion (defaults to server cwd)",
        required: false,
      },
    ],
  },
  {
    name: "debug-error",
    description:
      "Debug an error message or stack trace. Optionally supply relevant source files and context.",
    arguments: [
      {
        name: "error",
        description: "The error message or stack trace to debug",
        required: true,
      },
      {
        name: "files",
        description:
          "Space-separated paths to relevant source files (optional)",
        required: false,
      },
      {
        name: "context",
        description:
          "Additional context about what you were doing (optional)",
        required: false,
      },
      {
        name: "cwd",
        description:
          "Working directory for @file expansion (optional)",
        required: false,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const FOCUS_VALUES = [
  "security",
  "performance",
  "correctness",
  "design",
  "all",
] as const;

const AUDIENCE_VALUES = ["beginner", "intermediate", "expert"] as const;

function requireArg(
  args: Record<string, string> | undefined,
  promptName: string,
  name: string
): string {
  const value = args?.[name];
  if (!value) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${promptName}: missing required argument '${name}'`
    );
  }
  return value;
}

function validateEnum(
  value: string,
  allowed: readonly string[],
  promptName: string,
  argName: string
): void {
  if (!allowed.includes(value)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${promptName}: argument '${argName}' must be one of: ${allowed.join(", ")}`
    );
  }
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

type PromptResult = GetPromptResult;

function buildCodeReview(def: Prompt, args: Record<string, string> | undefined): PromptResult {
  const files = requireArg(args, "code-review", "files");
  const cwd   = args?.["cwd"] ?? process.cwd();
  const focus  = args?.["focus"] ?? "all";

  validateEnum(focus, FOCUS_VALUES, "code-review", "focus");

  const focusText =
    focus === "all"
      ? "all issue types (security, performance, correctness, and design)"
      : `${focus} issues`;

  const fileRefs = files.split(/\s+/).filter(Boolean).map((f) => `@${f}`).join(" ");

  const text =
    `<!-- working directory: ${cwd} -->\n` +
    `Review the following code for ${focusText}. Be specific — cite file names and line numbers where possible.\n\n` +
    fileRefs;

  return {
    description: def.description,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

function buildArchitectureAnalysis(def: Prompt, args: Record<string, string> | undefined): PromptResult {
  const directory = requireArg(args, "architecture-analysis", "directory");
  const cwd       = args?.["cwd"] ?? process.cwd();
  const question  = args?.["question"];

  const text =
    `<!-- working directory: ${cwd} -->\n` +
    `Analyse the architecture of the following codebase. Identify the key components, their responsibilities, how they interact, and any patterns or anti-patterns present.` +
    (question ? `\nSpecifically answer: ${question}` : "") +
    `\n\n@${directory}`;

  return {
    description: def.description,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

function buildExplainCode(def: Prompt, args: Record<string, string> | undefined): PromptResult {
  const file     = requireArg(args, "explain-code", "file");
  const cwd      = args?.["cwd"] ?? process.cwd();
  const symbol   = args?.["symbol"];
  const audience = args?.["audience"] ?? "intermediate";

  validateEnum(audience, AUDIENCE_VALUES, "explain-code", "audience");

  const text =
    `<!-- working directory: ${cwd} -->\n` +
    `Explain how the following code works. Target audience: ${audience}.` +
    (symbol ? `\nFocus on the \`${symbol}\` symbol specifically.` : "") +
    `\n\n@${file}`;

  return {
    description: def.description,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

function buildDebugError(def: Prompt, args: Record<string, string> | undefined): PromptResult {
  const error   = requireArg(args, "debug-error", "error");
  const files   = args?.["files"];
  const context = args?.["context"];
  const cwd     = args?.["cwd"];

  const text =
    (cwd ? `<!-- working directory: ${cwd} -->\n` : "") +
    `Help me debug the following error:\n\n` +
    `\`\`\`\n${error}\n\`\`\`` +
    (files
      ? `\n\nRelevant source files:\n${files.split(/\s+/).filter(Boolean).map((f) => `@${f}`).join(" ")}`
      : "") +
    (context ? `\n\nAdditional context: ${context}` : "");

  return {
    description: def.description,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listPrompts(): { prompts: Prompt[] } {
  return { prompts: PROMPTS };
}

export function getPrompt(
  name: string,
  args?: Record<string, string>
): PromptResult {
  const def = PROMPTS.find((p) => p.name === name);
  if (!def) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  }
  switch (name) {
    case "code-review":
      return buildCodeReview(def, args);
    case "architecture-analysis":
      return buildArchitectureAnalysis(def, args);
    case "explain-code":
      return buildExplainCode(def, args);
    case "debug-error":
      return buildDebugError(def, args);
    default:
      throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  }
}

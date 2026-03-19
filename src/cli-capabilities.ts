import { execFile } from "node:child_process";

export interface CliVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
}

export interface CliCapabilities {
  version: CliVersion | null;
  flags: Set<string>;
  hasApprovalMode: boolean;
  hasYolo: boolean;
  hasOutputFormat: boolean;
  hasSandbox: boolean;
  hasResume: boolean;
  detectedAt: number;
  error: string | null;
}

export const MIN_SUPPORTED_VERSION: CliVersion = {
  raw: "0.30.0",
  major: 0,
  minor: 30,
  patch: 0,
};

const DETECTION_TIMEOUT_MS = 5_000;

function parseVersion(output: string): CliVersion | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!match) return null;
  return {
    raw: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function parseFlags(helpOutput: string): Set<string> {
  const flags = new Set<string>();
  for (const m of helpOutput.matchAll(/--[\w-]+/g)) {
    flags.add(m[0]);
  }
  return flags;
}

export function isVersionBelow(version: CliVersion, minimum: CliVersion): boolean {
  if (version.major !== minimum.major) return version.major < minimum.major;
  if (version.minor !== minimum.minor) return version.minor < minimum.minor;
  return version.patch < minimum.patch;
}

function runCommand(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      { timeout: DETECTION_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout, stderr) => {
        // --version and --help may exit 0 or 1 depending on the CLI version.
        // Accept any exit as long as we got output.
        const output = (stdout || "") + (stderr || "");
        if (output.length > 0) {
          resolve(output);
        } else if (error) {
          reject(error);
        } else {
          resolve("");
        }
      }
    );
    // Prevent unhandled 'error' events (e.g. ENOENT) from crashing the
    // process — execFile's callback already handles the error.
    child.on("error", () => {});
  });
}

function hardcodedFallback(error?: string): CliCapabilities {
  return {
    version: null,
    flags: new Set<string>(["--yolo", "--output-format"]),
    hasApprovalMode: false,
    hasYolo: true,
    hasOutputFormat: true,
    hasSandbox: false,
    hasResume: false,
    detectedAt: Date.now(),
    error: error ?? null,
  };
}

export async function detectCapabilities(
  binary: string
): Promise<CliCapabilities> {
  if (process.env.GEMINI_SKIP_DETECTION === "1") {
    return hardcodedFallback("detection skipped (GEMINI_SKIP_DETECTION=1)");
  }

  let version: CliVersion | null = null;
  let flags = new Set<string>();
  let error: string | null = null;

  // Phase 1: version
  try {
    const versionOutput = await runCommand(binary, ["--version"]);
    version = parseVersion(versionOutput);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return hardcodedFallback(`version detection failed: ${msg}`);
  }

  // Phase 2: help / flag discovery
  try {
    const helpOutput = await runCommand(binary, ["--help"]);
    flags = parseFlags(helpOutput);
  } catch (err) {
    error = `help parsing failed: ${(err as Error).message ?? String(err)}`;
    // Continue — we still have the version
  }

  if (
    version &&
    isVersionBelow(version, MIN_SUPPORTED_VERSION)
  ) {
    process.stderr.write(
      `[gemini-cli-mcp] warning: gemini CLI v${version.raw} is below minimum supported ${MIN_SUPPORTED_VERSION.raw}\n`
    );
  }

  return {
    version,
    flags,
    hasApprovalMode: flags.has("--approval-mode"),
    hasYolo: flags.has("--yolo"),
    hasOutputFormat: flags.has("--output-format"),
    hasSandbox: flags.has("--sandbox"),
    hasResume: flags.has("--resume"),
    detectedAt: Date.now(),
    error,
  };
}

export function buildBaseArgs(caps: CliCapabilities | null): string[] {
  if (!caps) {
    return ["--yolo", "--output-format", "stream-json"];
  }
  const args: string[] = [];
  args.push(...(caps.hasApprovalMode ? ["--approval-mode", "yolo"] : ["--yolo"]));
  if (caps.hasOutputFormat) {
    args.push("--output-format", "stream-json");
  }
  return args;
}

// Lazy singleton — kicked off on first call, result cached for server lifetime.
// NOTE: the binary parameter is only used on the first call; subsequent calls
// return the cached result regardless of the binary passed (singleton semantics).
let capabilitiesPromise: Promise<CliCapabilities> | null = null;

export function getCapabilities(binary?: string): Promise<CliCapabilities> {
  if (capabilitiesPromise) return capabilitiesPromise;
  // Accept binary as a parameter for testability; defaults to "gemini"
  // (callers in gemini-runner.ts pass GEMINI_BINARY explicitly).
  const effectiveBinary = binary ?? "gemini";
  capabilitiesPromise = detectCapabilities(effectiveBinary);
  return capabilitiesPromise;
}

/** Reset the singleton — only for testing. */
export function _resetCapabilities(): void {
  capabilitiesPromise = null;
}

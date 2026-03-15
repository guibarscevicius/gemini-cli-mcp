import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";
import { discoverGeminiBinary } from "./gemini-runner.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

function print(msg: string): void {
  process.stdout.write(msg + "\n");
}

function resolveServerEntry(): string {
  const setupUrl = new URL(import.meta.url);
  setupUrl.search = "";
  setupUrl.hash = "";
  const setupFile = fileURLToPath(setupUrl);
  const packageRoot = nodePath.resolve(setupFile, "../..");
  return nodePath.join(packageRoot, "dist", "index.js");
}

function createLineReader(cp: ReturnType<typeof spawn>) {
  let buffer = "";
  const lines: string[] = [];
  const waiters: Array<{
    needle: string;
    resolve: (line: string) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  let terminalError: Error | null = null;

  const resolveWaiters = () => {
    for (let i = 0; i < waiters.length; i++) {
      const waiter = waiters[i]!;
      const lineIdx = lines.findIndex((line) => line.includes(waiter.needle));
      if (lineIdx === -1) continue;
      const [line] = lines.splice(lineIdx, 1);
      if (line === undefined) continue;
      clearTimeout(waiter.timer);
      waiters.splice(i, 1);
      i--;
      waiter.resolve(line);
    }
  };

  const failAll = (err: Error) => {
    if (terminalError !== null) return;
    terminalError = err;
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    waiters.length = 0;
  };

  cp.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) lines.push(line);
      newline = buffer.indexOf("\n");
    }
    resolveWaiters();
  });

  cp.on("error", (err) => {
    failAll(err instanceof Error ? err : new Error(String(err)));
  });
  cp.on("close", (code) => {
    failAll(new Error(`server exited before expected response (code ${code ?? "unknown"})`));
  });

  const waitForLineContaining = (needle: string, timeoutMs: number): Promise<string> => {
    if (terminalError !== null) {
      return Promise.reject(terminalError);
    }
    const lineIdx = lines.findIndex((line) => line.includes(needle));
    if (lineIdx !== -1) {
      const line = lines.splice(lineIdx, 1)[0]!;
      return Promise.resolve(line);
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.timer === timer);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for response containing ${needle}`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      waiters.push({ needle, resolve, reject, timer });
    });
  };

  return { waitForLineContaining };
}

async function runServerSelfTest(entry: string, binary: string): Promise<{
  binary: string;
  poolReady: number;
  poolSize: number;
  version: string;
}> {
  const cp = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GEMINI_BINARY: binary },
  });
  const reader = createLineReader(cp);

  try {
    cp.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "gemini-cli-mcp-setup", version: "1.0.0" },
        },
      })}\n`
    );
    await reader.waitForLineContaining("\"id\":1", 15_000);

    cp.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`
    );
    cp.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "gemini-health", arguments: {} },
      })}\n`
    );

    const responseLine = await reader.waitForLineContaining("\"id\":2", 30_000);
    const response = JSON.parse(responseLine) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const text = response.result?.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error("gemini-health response missing result.content[0].text");
    }
    const health = JSON.parse(text) as {
      binary?: { path?: string | null };
      pool?: { ready?: number; size?: number };
      server?: { version?: string };
    };
    return {
      binary: health.binary?.path ?? binary,
      poolReady: health.pool?.ready ?? 0,
      poolSize: health.pool?.size ?? 0,
      version: health.server?.version ?? "unknown",
    };
  } finally {
    if (cp.exitCode === null) {
      cp.kill("SIGTERM");
    }
  }
}

async function installGeminiCli(): Promise<void> {
  print(`\n${YELLOW}Installing @google/gemini-cli...${RESET}`);
  await new Promise<void>((resolve, reject) => {
    const cp = spawn("npm", ["install", "-g", "@google/gemini-cli"], {
      stdio: "inherit",
      env: process.env,
    });
    let settled = false;
    cp.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(`npm install exited with code ${code}`));
    });
    cp.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function checkAuth(binary: string): Promise<"ok" | "not-authenticated" | "timeout"> {
  return new Promise((resolve) => {
    const cp = spawn(binary, ["--prompt", "ping", "--output-format", "stream-json"], {
      env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cp.kill();
        resolve("timeout");
      }
    }, 15_000);
    cp.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    cp.stdout?.on("data", () => {});
    cp.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if ((err as { code?: string }).code === "ENOENT") {
        resolve("not-authenticated");
      } else {
        resolve("ok");
      }
    });
    cp.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code === 0) resolve("ok");
      else if (/auth|login|credential|unauthorized/i.test(stderr)) resolve("not-authenticated");
      else resolve("ok"); // unknown error — don't block setup
    });
    cp.stdin?.end();
  });
}

function isNpxRun(): boolean {
  const argv1 = process.argv[1] ?? "";
  return argv1.includes("/_npx/") || argv1.includes(".npm/_npx");
}

export async function runSetup(): Promise<void> {
  print(`\n${BOLD}${CYAN}gemini-cli-mcp setup wizard${RESET}\n`);

  // Step 1: Find gemini binary
  print("Step 1/4: Locating gemini binary...");
  let binary = discoverGeminiBinary();
  // binary !== "gemini" means auto-discovery found an absolute path — we know it exists.
  // If it returned the fallback "gemini", we must check PATH explicitly via which/where below.
  let binaryFound = binary !== "gemini";

  if (!binaryFound) {
    // Binary not found via auto-discovery; check PATH as last resort
    // If binary is still "gemini" (fallback), we don't know if it exists on PATH
    // Try to find it via which/where
    const whichResult = await new Promise<string>((resolve) => {
      const cp = spawn(process.platform === "win32" ? "where" : "which", ["gemini"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
      let out = "";
      cp.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      cp.on("close", (code) => {
        resolve(code === 0 ? out.trim().split("\n")[0].trim() : "");
      });
      cp.on("error", () => resolve(""));
    });

    if (whichResult) {
      binary = whichResult;
      binaryFound = true;
      print(`  ${GREEN}✓${RESET} Found gemini on PATH: ${binary}`);
    }
  } else {
    print(`  ${GREEN}✓${RESET} Found gemini: ${binary}`);
  }

  if (!binaryFound) {
    print(`  ${YELLOW}⚠${RESET}  gemini not found. Installing @google/gemini-cli...`);
    try {
      await installGeminiCli();
      // Re-discover after install
      binary = discoverGeminiBinary();
      if (binary === "gemini") {
        // Try PATH again
        const npmPrefix = await new Promise<string>((resolve) => {
          const cp = spawn("npm", ["config", "get", "prefix"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
          let out = "";
          cp.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
          cp.on("close", () => resolve(out.trim()));
          cp.on("error", () => resolve(""));
        });
        if (npmPrefix) {
          const candidate = nodePath.join(npmPrefix, "bin", "gemini");
          if (existsSync(candidate)) binary = candidate;
        }
      }
      if (binary === "gemini") {
        print(`  ${YELLOW}⚠${RESET}  Installed, but could not locate binary path. Using "gemini" from PATH.`);
        print(`  If the server fails to start, set GEMINI_BINARY to the full path of the gemini binary.`);
      } else {
        print(`  ${GREEN}✓${RESET} Installed gemini: ${binary}`);
      }
      binaryFound = true;
    } catch (err) {
      print(`  ${RED}✗${RESET}  Installation failed: ${err instanceof Error ? err.message : String(err)}`);
      print(`\nPlease install manually: npm install -g @google/gemini-cli`);
      return;
    }
  }

  // Step 2: Check authentication
  print("\nStep 2/4: Checking Gemini authentication...");
  const authStatus = await checkAuth(binary);
  if (authStatus === "ok") {
    print(`  ${GREEN}✓${RESET} Authenticated`);
  } else if (authStatus === "not-authenticated") {
    print(`  ${RED}✗${RESET}  Not authenticated. Run: ${BOLD}gemini${RESET}`);
    print(`  Follow the login prompts, then re-run: ${BOLD}gemini-cli-mcp --setup${RESET}`);
    return;
  } else {
    print(`  ${YELLOW}⚠${RESET}  Auth check timed out — this may mean gemini is waiting for auth.`);
    print(`  If the server fails to start, run ${BOLD}gemini${RESET} once to authenticate.`);
  }

  // Step 3: Output MCP config
  print("\nStep 3/4: Generating MCP config...\n");

  const npx = isNpxRun();

  if (npx) {
    print(`${YELLOW}Note:${RESET} You ran this via npx. For a stable config, install globally first:`);
    print(`  npm install -g @guibarscevicius/gemini-cli-mcp\n`);
  }

  const scriptPath = resolveServerEntry();

  const config = {
    gemini: {
      command: process.execPath,
      args: [scriptPath],
      env: {
        GEMINI_BINARY: binary,
      },
    },
  };

  print(`${BOLD}Paste this into your ~/.mcp.json:${RESET}\n`);
  print(JSON.stringify(config, null, 2));
  print("\nStep 4 — Testing server configuration");
  try {
    const selfTest = await runServerSelfTest(scriptPath, binary);
    print(
      `  ${GREEN}✓${RESET} Server responded — binary: ${selfTest.binary}, pool: ` +
      `${selfTest.poolReady}/${selfTest.poolSize} ready, version: ${selfTest.version}`
    );
  } catch (err) {
    print(`  ${RED}✗${RESET} Self-test failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  print(`\n${GREEN}${BOLD}Setup complete!${RESET}`);
}

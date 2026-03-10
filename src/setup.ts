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
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
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
  print("Step 1/3: Locating gemini binary...");
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
  print("\nStep 2/3: Checking Gemini authentication...");
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
  print("\nStep 3/3: Generating MCP config...\n");

  const npx = isNpxRun();

  if (npx) {
    print(`${YELLOW}Note:${RESET} You ran this via npx. For a stable config, install globally first:`);
    print(`  npm install -g @guibarscevicius/gemini-cli-mcp\n`);
  }

  const __filename = fileURLToPath(import.meta.url);
  const packageRoot = nodePath.resolve(__filename, "../.."); // setup.ts compiles to dist/setup.js, go up to package root
  const scriptPath = nodePath.join(packageRoot, "dist", "index.js");

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
  print(`\n${GREEN}${BOLD}Setup complete!${RESET}`);
}

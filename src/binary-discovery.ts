import { existsSync, readdirSync } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") {
      process.stderr.write(
        `[gemini-cli-mcp] warning: cannot read ${dir}: ${(err as Error).message}\n`
      );
    }
    return [];
  }
}

export function discoverGeminiBinary(): string {
  const explicit = process.env.GEMINI_BINARY;
  if (explicit) return explicit;

  const home = os.homedir();
  const candidates: string[] = [];

  // nvm — sort descending so latest version wins
  const nvmVersions = readdirSafe(nodePath.join(home, ".nvm/versions/node")).sort().reverse();
  for (const v of nvmVersions) {
    candidates.push(nodePath.join(home, `.nvm/versions/node/${v}/bin/gemini`));
  }

  // fnm
  const fnmVersions = readdirSafe(nodePath.join(home, ".fnm/node-versions")).sort().reverse();
  for (const v of fnmVersions) {
    candidates.push(nodePath.join(home, `.fnm/node-versions/${v}/installation/bin/gemini`));
  }

  // volta
  candidates.push(nodePath.join(home, ".volta/bin/gemini"));

  // asdf
  const asdfVersions = readdirSafe(nodePath.join(home, ".asdf/installs/nodejs")).sort().reverse();
  for (const v of asdfVersions) {
    candidates.push(nodePath.join(home, `.asdf/installs/nodejs/${v}/bin/gemini`));
  }

  // Homebrew (Apple Silicon + Intel)
  candidates.push("/opt/homebrew/bin/gemini", "/usr/local/bin/gemini");

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      process.stderr.write(`[gemini-cli-mcp] auto-discovered gemini at: ${candidate}\n`);
      return candidate;
    }
  }

  return "gemini"; // fallback to PATH; cold-spawn gives a clear ENOENT; warm pool detects after 5 failures
}

export const GEMINI_BINARY: string = discoverGeminiBinary();

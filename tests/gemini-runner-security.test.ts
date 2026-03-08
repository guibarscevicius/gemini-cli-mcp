/**
 * Security tests for expandFileRefs: path traversal, workspace boundaries,
 * symlink escape prevention, and glob safety.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { expandFileRefs } from "../src/gemini-runner.js";

describe("expandFileRefs — path traversal / workspace security", () => {
  let tmpDir: string;
  let innerDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-security-test-"));
    innerDir = path.join(tmpDir, "project");
    await fs.mkdir(innerDir);
    await fs.writeFile(path.join(innerDir, "safe.ts"), "export const x = 1;");
    await fs.writeFile(path.join(tmpDir, "outside.txt"), "secret content");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("allows a file within cwd", async () => {
    const result = await expandFileRefs("Check @safe.ts and @safe.ts", innerDir);
    expect(result).toContain("Content from @safe.ts:");
    expect(result).toContain("export const x = 1;");
  });

  it("throws 'Path not in workspace' for ../ traversal", async () => {
    await expect(
      expandFileRefs("Check @../outside.txt and @safe.ts", innerDir)
    ).rejects.toThrow(/Path not in workspace/);
  });

  it("throws 'Path not in workspace' for absolute path outside cwd", async () => {
    const outsidePath = path.join(tmpDir, "outside.txt");
    await expect(
      expandFileRefs(`Check @${outsidePath} and @safe.ts`, innerDir)
    ).rejects.toThrow(/Path not in workspace/);
  });

  it("throws 'Path not in workspace' for a symlink that escapes the workspace", async () => {
    const symlink = path.join(innerDir, "escape-link.txt");
    await fs.symlink(path.join(tmpDir, "outside.txt"), symlink);
    await expect(
      expandFileRefs("Check @escape-link.txt and @safe.ts", innerDir)
    ).rejects.toThrow(/Path not in workspace/);
  });

  it("does not expand single @file token (left for CLI)", async () => {
    const result = await expandFileRefs("Check @safe.ts", innerDir);
    expect(result).toBe("Check @safe.ts");
  });

  it("throws for a path that does not exist", async () => {
    await expect(
      expandFileRefs("Check @nonexistent.ts and @safe.ts", innerDir)
    ).rejects.toThrow(/File not found/);
  });

  it("throws 'is a directory' for a directory reference", async () => {
    await fs.mkdir(path.join(innerDir, "sub.dir"));
    await expect(
      expandFileRefs("Check @sub.dir and @safe.ts", innerDir)
    ).rejects.toThrow(/is a directory/);
  });

  it("allows a file at the exact cwd boundary (cwd/file.ts)", async () => {
    const result = await expandFileRefs("Check @safe.ts and @safe.ts", innerDir);
    expect(result).toContain("Content from @safe.ts:");
  });
});

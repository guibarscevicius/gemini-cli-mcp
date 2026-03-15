import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/gemini-runner.js", () => ({
  countFileRefs: vi.fn(),
  runGemini: vi.fn(),
  spawnGemini: vi.fn(),
}));

import { countFileRefs } from "../../src/gemini-runner.js";
import { elicitCwdIfNeeded } from "../../src/tools/shared.js";

const mockCountFileRefs = vi.mocked(countFileRefs);

describe("elicitCwdIfNeeded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns original cwd when provided", async () => {
    mockCountFileRefs.mockReturnValue(3);
    const elicit = vi.fn();

    const result = await elicitCwdIfNeeded("use @a.ts and @b.ts", "/repo", { elicit });

    expect(result).toBe("/repo");
    expect(elicit).not.toHaveBeenCalled();
  });

  it("returns undefined when there are no @file refs", async () => {
    mockCountFileRefs.mockReturnValue(0);
    const elicit = vi.fn();

    const result = await elicitCwdIfNeeded("no refs here", undefined, { elicit });

    expect(result).toBeUndefined();
    expect(elicit).not.toHaveBeenCalled();
  });

  it("returns undefined when there is a single @file ref", async () => {
    mockCountFileRefs.mockReturnValue(1);
    const elicit = vi.fn();

    const result = await elicitCwdIfNeeded("check @src/a.ts", undefined, { elicit });

    expect(result).toBeUndefined();
    expect(elicit).not.toHaveBeenCalled();
  });

  it("returns undefined when client does not support elicitation", async () => {
    mockCountFileRefs.mockReturnValue(2);

    const result = await elicitCwdIfNeeded("check @src/a.ts and @src/b.ts", undefined, {});

    expect(result).toBeUndefined();
  });

  it("returns elicited cwd when user accepts", async () => {
    mockCountFileRefs.mockReturnValue(2);
    const elicit = vi.fn().mockResolvedValue({ action: "accept", content: { cwd: "/tmp/project" } });

    const result = await elicitCwdIfNeeded("check @src/a.ts and @src/b.ts", undefined, { elicit });

    expect(result).toBe("/tmp/project");
    expect(elicit).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("multiple @file references"),
        requestedSchema: expect.objectContaining({
          required: ["cwd"],
        }),
      })
    );
  });

  it("returns null when accept action has non-string cwd content", async () => {
    mockCountFileRefs.mockReturnValue(2);
    const mockElicit = vi.fn().mockResolvedValue({ action: "accept", content: { cwd: 42 } });
    const result = await elicitCwdIfNeeded("@a.ts @b.ts", undefined, { elicit: mockElicit });
    expect(result).toBeNull();
  });

  it("returns null when user declines", async () => {
    mockCountFileRefs.mockReturnValue(2);
    const elicit = vi.fn().mockResolvedValue({ action: "decline" });

    const result = await elicitCwdIfNeeded("check @src/a.ts and @src/b.ts", undefined, { elicit });

    expect(result).toBeNull();
  });

  it("returns null when user cancels", async () => {
    mockCountFileRefs.mockReturnValue(2);
    const elicit = vi.fn().mockResolvedValue({ action: "cancel" });

    const result = await elicitCwdIfNeeded("check @src/a.ts and @src/b.ts", undefined, { elicit });

    expect(result).toBeNull();
  });
});

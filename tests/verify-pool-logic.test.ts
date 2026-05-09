import { describe, it, expect } from "vitest";
// @ts-expect-error — JS module without type declarations; behavior is exercised here.
import { decideVerdict, PGREP_PATTERN } from "../scripts/verify-pool-logic.mjs";

describe("decideVerdict", () => {
  it("count === expected → ok=true (gate holding)", () => {
    const v = decideVerdict(2, 2);
    expect(v.ok).toBe(true);
    expect(v.message).toContain("gate holding");
  });

  it("count === expected * 2 → ok=false (gate broken)", () => {
    const v = decideVerdict(4, 2);
    expect(v.ok).toBe(false);
    expect(v.message).toContain("gate BROKEN");
    expect(v.message).toContain("relaunch is doubling");
  });

  it("count === 0 (expected > 0) → ok=false (no workers)", () => {
    const v = decideVerdict(0, 2);
    expect(v.ok).toBe(false);
    expect(v.message).toContain("no workers detected");
  });

  it("ambiguous count → ok=false", () => {
    const v = decideVerdict(3, 2);
    expect(v.ok).toBe(false);
    expect(v.message).toContain("unexpected count=3");
    expect(v.message).toContain("expected 2 or 4");
  });

  it("expected === 0 with count === 0 → ok=false (does NOT report gate holding)", () => {
    // This is the case the original implementation got wrong: a disabled pool
    // reported a green "gate holding" result because count===expected===0
    // matched the first branch. The fix checks expected<=0 first.
    const v = decideVerdict(0, 0);
    expect(v.ok).toBe(false);
    expect(v.message).toContain("disabled");
    expect(v.message).not.toContain("gate holding");
  });

  it("expected === 0 with count > 0 → ok=false (still surfaces the disabled pool)", () => {
    const v = decideVerdict(5, 0);
    expect(v.ok).toBe(false);
    expect(v.message).toContain("disabled");
  });

  it("negative expected is treated as disabled", () => {
    // Defensive — Number(undefined ?? -1) is unlikely but the env-parsing
    // path could in principle yield a negative if a user types one.
    const v = decideVerdict(0, -1);
    expect(v.ok).toBe(false);
    expect(v.message).toContain("disabled");
  });

  it("error messages reference the full pgrep fingerprint, not the truncated form", () => {
    // Regression: the original count===0 message said `pgrep -af 'gemini --yolo'`
    // (would match interactive sessions), contradicting the rationale for the
    // full pattern in PGREP_PATTERN.
    const v = decideVerdict(0, 2);
    expect(v.message).toContain(PGREP_PATTERN);
    expect(v.message).not.toContain("pgrep -af 'gemini --yolo'");
  });
});

describe("PGREP_PATTERN", () => {
  it("matches the warm-pool worker fingerprint exactly", () => {
    // If the warm-pool args at src/gemini-runner.ts:218 change, this test
    // and the PGREP_PATTERN constant must be updated together.
    expect(PGREP_PATTERN).toBe("gemini --yolo --output-format stream-json");
  });
});

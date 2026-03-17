import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleShutdownController, parseIdleShutdownMs } from "../src/idle-shutdown.js";

describe("parseIdleShutdownMs", () => {
  it("defaults to disabled when unset", () => {
    expect(parseIdleShutdownMs(undefined)).toBe(0);
  });

  it("parses a non-negative integer", () => {
    expect(parseIdleShutdownMs("120000")).toBe(120000);
    expect(parseIdleShutdownMs("0")).toBe(0);
    expect(parseIdleShutdownMs(" 300000 ")).toBe(300000);
    expect(parseIdleShutdownMs("")).toBe(0);
    expect(parseIdleShutdownMs("   ")).toBe(0);
  });

  it("rejects invalid values", () => {
    expect(() => parseIdleShutdownMs("-1")).toThrow(
      /GEMINI_MCP_IDLE_SHUTDOWN_MS must be a non-negative integer/
    );
    expect(() => parseIdleShutdownMs("abc")).toThrow(
      /GEMINI_MCP_IDLE_SHUTDOWN_MS must be a non-negative integer/
    );
    expect(() => parseIdleShutdownMs("300abc")).toThrow(
      /GEMINI_MCP_IDLE_SHUTDOWN_MS must be a non-negative integer/
    );
    expect(() => parseIdleShutdownMs("3.7")).toThrow(
      /GEMINI_MCP_IDLE_SHUTDOWN_MS must be a non-negative integer/
    );
  });
});

describe("IdleShutdownController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shuts down after the idle timeout when unused", () => {
    const onIdle = vi.fn();
    const controller = new IdleShutdownController(5_000, onIdle);

    controller.start();
    vi.advanceTimersByTime(4_999);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("resets the timer when activity occurs", () => {
    const onIdle = vi.fn();
    const controller = new IdleShutdownController(5_000, onIdle);

    controller.start();
    vi.advanceTimersByTime(3_000);
    controller.noteActivity();
    vi.advanceTimersByTime(4_999);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("does not shut down while jobs are active and rearms after they finish", () => {
    const onIdle = vi.fn();
    const controller = new IdleShutdownController(5_000, onIdle);

    controller.start();
    controller.updateActiveJobs(1);
    vi.advanceTimersByTime(10_000);
    expect(onIdle).not.toHaveBeenCalled();

    controller.updateActiveJobs(0);
    vi.advanceTimersByTime(4_999);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("stops cleanly", () => {
    const onIdle = vi.fn();
    const controller = new IdleShutdownController(5_000, onIdle);

    controller.start();
    controller.stop();
    vi.advanceTimersByTime(10_000);

    expect(onIdle).not.toHaveBeenCalled();
  });

  it("logs callback failures instead of leaving an unhandled rejection", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const controller = new IdleShutdownController(5_000, async () => {
      throw new Error("boom");
    });

    try {
      controller.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("idle shutdown callback failed: boom")
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

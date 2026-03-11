/**
 * Unit tests for runWithWarmProcess.
 *
 * Tests the NDJSON parser, settle guard, timeout, and error paths without
 * spawning a real `gemini` process.  A minimal mock WarmProcess is built from
 * an EventEmitter so we can emit stdout data and lifecycle events on demand.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { runWithWarmProcess } from "../src/gemini-runner.js";
import type { WarmProcess } from "../src/warm-pool.js";

// ── Mock helpers ─────────────────────────────────────────────────────────────

function makeWarmProcess(): {
  wp: WarmProcess;
  emitData: (ndjson: string) => void;
  emitClose: (code: number | null, signal?: string) => void;
  emitError: (err: Error) => void;
  stdinWrite: ReturnType<typeof vi.fn>;
  stdinEnd: ReturnType<typeof vi.fn>;
} {
  const stdout = new EventEmitter();
  const cp = new EventEmitter() as ChildProcess;
  const stdinWrite = vi.fn();
  const stdinEnd = vi.fn();

  Object.assign(cp, {
    pid: 42,
    stdout,
    stdin: { write: stdinWrite, end: stdinEnd },
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });

  const wp: WarmProcess = { cp, pid: 42 };

  return {
    wp,
    emitData: (ndjson: string) => stdout.emit("data", Buffer.from(ndjson)),
    emitClose: (code: number | null, signal?: string) => cp.emit("close", code, signal ?? null),
    emitError: (err: Error) => cp.emit("error", err),
    stdinWrite,
    stdinEnd,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runWithWarmProcess", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("resolves with accumulated content on result:success", async () => {
    const { wp, emitData, emitClose } = makeWarmProcess();
    const promise = runWithWarmProcess(wp, "hello", 5000, undefined);

    emitData('{"type":"message","role":"assistant","content":"foo"}\n');
    emitData('{"type":"message","role":"assistant","content":"bar"}\n');
    emitData('{"type":"result","status":"success"}\n');
    emitClose(0);

    await expect(promise).resolves.toBe("foobar");
  });

  it("calls onChunk for each assistant message chunk", async () => {
    const { wp, emitData, emitClose } = makeWarmProcess();
    const chunks: string[] = [];
    const promise = runWithWarmProcess(wp, "hi", 5000, (c) => chunks.push(c));

    emitData('{"type":"message","role":"assistant","content":"part1"}\n');
    emitData('{"type":"message","role":"assistant","content":"part2"}\n');
    emitData('{"type":"result","status":"success"}\n');
    emitClose(0);

    await promise;
    expect(chunks).toEqual(["part1", "part2"]);
  });

  it("resolves with accumulated content on close code 0 when no result event", async () => {
    const { wp, emitData, emitClose } = makeWarmProcess();
    const promise = runWithWarmProcess(wp, "hi", 5000, undefined);

    emitData('{"type":"message","role":"assistant","content":"text"}\n');
    emitClose(0);

    await expect(promise).resolves.toBe("text");
  });

  it("handles NDJSON split across multiple data chunks", async () => {
    const { wp, emitData, emitClose } = makeWarmProcess();
    const promise = runWithWarmProcess(wp, "hi", 5000, undefined);

    // Emit the JSON in two partial chunks
    emitData('{"type":"message","role":"assistan');
    emitData('t","content":"hello"}\n{"type":"result","status":"success"}\n');
    emitClose(0);

    await expect(promise).resolves.toBe("hello");
  });

  it("ignores non-JSON lines and empty lines in stdout", async () => {
    const { wp, emitData, emitClose } = makeWarmProcess();
    const promise = runWithWarmProcess(wp, "hi", 5000, undefined);

    emitData("not json\n");
    emitData("\n");
    emitData('{"type":"message","role":"assistant","content":"ok"}\n');
    emitData('{"type":"result","status":"success"}\n');
    emitClose(0);

    await expect(promise).resolves.toBe("ok");
  });

  it("writes prompt + newline to stdin and calls end()", async () => {
    const { wp, emitData, emitClose, stdinWrite, stdinEnd } = makeWarmProcess();
    const promise = runWithWarmProcess(wp, "my prompt", 5000, undefined);

    emitData('{"type":"result","status":"success"}\n');
    emitClose(0);

    await promise;
    expect(stdinWrite).toHaveBeenCalledWith("my prompt\n");
    expect(stdinEnd).toHaveBeenCalled();
  });

  // ── Error paths ───────────────────────────────────────────────────────────

  it("rejects with GeminiOutputError on result:error", async () => {
    const { wp, emitData, emitClose } = makeWarmProcess();
    const promise = runWithWarmProcess(wp, "hi", 5000, undefined);

    emitData('{"type":"result","status":"error","error":"quota exceeded"}\n');
    emitClose(1);

    await expect(promise).rejects.toThrow("quota exceeded");
  });

  it("result:error with object e.error is JSON.stringified in rejection", async () => {
    const { wp, emitData, emitClose } = makeWarmProcess();
    const promise = runWithWarmProcess(wp, "hi", 5000, undefined);

    const errorObj = { code: "RESOURCE_EXHAUSTED", details: "rate limit" };
    emitData(`{"type":"result","status":"error","error":${JSON.stringify(errorObj)}}\n`);
    emitClose(1);

    await expect(promise).rejects.toThrow("RESOURCE_EXHAUSTED");
  });

  it("result:error with no string error/message includes 'unknown' and logs raw event", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { wp, emitData, emitClose } = makeWarmProcess();
    const promise = runWithWarmProcess(wp, "hi", 5000, undefined);

    emitData('{"type":"result","status":"error"}\n');
    emitClose(1);

    await expect(promise).rejects.toThrow("(unknown)");
    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("unrecognized error event");
    stderrSpy.mockRestore();
  });

  it("rejects with GeminiOutputError on type:error event", async () => {
    const { wp, emitData, emitClose } = makeWarmProcess();
    const promise = runWithWarmProcess(wp, "hi", 5000, undefined);

    emitData('{"type":"error","message":"upstream error"}\n');
    emitClose(1);

    await expect(promise).rejects.toThrow("upstream error");
  });

  it("rejects when process closes with non-zero exit code", async () => {
    const { wp, emitClose } = makeWarmProcess();
    const promise = runWithWarmProcess(wp, "hi", 5000, undefined);

    emitClose(1);

    await expect(promise).rejects.toThrow("exited with code 1");
  });

  it("rejects when process closes due to signal (code=null)", async () => {
    const { wp, emitClose } = makeWarmProcess();
    const promise = runWithWarmProcess(wp, "hi", 5000, undefined);

    // OS delivers code=null when a process is killed by signal (not a normal exit)
    emitClose(null, "SIGKILL");

    await expect(promise).rejects.toThrow("signal SIGKILL");
  });

  it("rejects on cp error event", async () => {
    const { wp, emitError } = makeWarmProcess();
    const promise = runWithWarmProcess(wp, "hi", 5000, undefined);

    emitError(new Error("spawn ENOENT"));

    await expect(promise).rejects.toThrow("spawn ENOENT");
  });

  // ── Settle guard ─────────────────────────────────────────────────────────

  it("settle guard: result:success followed by close does not double-resolve", async () => {
    const { wp, emitData, emitClose } = makeWarmProcess();
    const promise = runWithWarmProcess(wp, "hi", 5000, undefined);

    emitData('{"type":"result","status":"success"}\n');
    emitClose(0); // close fires after result — settle guard must ignore it

    await expect(promise).resolves.toBe("");
  });

  it("settle guard: close fires before result event — only resolves once", async () => {
    const { wp, emitData, emitClose } = makeWarmProcess();
    const promise = runWithWarmProcess(wp, "hi", 5000, undefined);

    emitClose(0);
    emitData('{"type":"result","status":"success"}\n'); // arrives after settle — ignored

    await expect(promise).resolves.toBe("");
  });

  // ── Timeout ───────────────────────────────────────────────────────────────

  it("rejects on timeout and kills the process", async () => {
    vi.useFakeTimers();
    const { wp } = makeWarmProcess();
    const promise = runWithWarmProcess(wp, "hi", 100, undefined);

    const check = expect(promise).rejects.toThrow("timed out after 100ms");
    await vi.advanceTimersByTimeAsync(110);
    await check;

    expect((wp.cp.kill as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});

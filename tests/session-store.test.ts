import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import nodePath from "node:path";
import * as os from "node:os";
import { SessionStore, SESSION_TTL_MS } from "../src/session-store.js";

describe("SessionStore", () => {
  let store: SessionStore;
  const originalMaxHistory = process.env.GEMINI_MAX_HISTORY_TURNS;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.GEMINI_MAX_HISTORY_TURNS = "20";
    store = new SessionStore(SESSION_TTL_MS, undefined, ":memory:");
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
    if (originalMaxHistory === undefined) {
      delete process.env.GEMINI_MAX_HISTORY_TURNS;
    } else {
      process.env.GEMINI_MAX_HISTORY_TURNS = originalMaxHistory;
    }
  });

  it("create() and get() manage session existence", () => {
    const id = "session-1";
    expect(store.get(id)).toBe(false);

    store.create(id);
    expect(store.get(id)).toBe(true);
  });

  it("appendTurn() and formatHistory() keep turn order", () => {
    const id = "session-order";
    store.create(id);
    store.appendTurn(id, "user", "q1");
    store.appendTurn(id, "assistant", "a1");
    store.appendTurn(id, "user", "q2");
    store.appendTurn(id, "assistant", "a2");

    const history = store.formatHistory(id);
    const lines = history.split("\n");

    expect(lines[0]).toBe("[Conversation history]");
    expect(lines[1]).toBe("User: q1");
    expect(lines[2]).toBe("Assistant: a1");
    expect(lines[3]).toBe("User: q2");
    expect(lines[4]).toBe("Assistant: a2");
    expect(lines[5]).toBe("[End of history — continue the conversation]");
  });

  it("formatHistory() truncation", () => {
    const id = "session-truncate";
    store.create(id);

    for (let i = 1; i <= 25; i++) {
      store.appendTurn(id, "user", `user-${i}`);
      store.appendTurn(id, "assistant", `assistant-${i}`);
    }

    const history = store.formatHistory(id);
    const lines = history.split("\n");
    const turnLines = lines.filter(
      (line) => line.startsWith("User:") || line.startsWith("Assistant:")
    );

    expect(history).toContain("earlier turns omitted");
    expect(turnLines).toHaveLength(40);
    expect(history).not.toContain("User: user-5\n");
    expect(history).not.toContain("Assistant: assistant-5\n");
    expect(history).toContain("User: user-25");
    expect(history).toContain("Assistant: assistant-25");
  });

  it("formatHistory() unlimited when GEMINI_MAX_HISTORY_TURNS=0", () => {
    process.env.GEMINI_MAX_HISTORY_TURNS = "0";
    const id = "session-unlimited";
    store.create(id);

    for (let i = 1; i <= 25; i++) {
      store.appendTurn(id, "user", `user-${i}`);
      store.appendTurn(id, "assistant", `assistant-${i}`);
    }

    const history = store.formatHistory(id);
    const turnLines = history
      .split("\n")
      .filter((line) => line.startsWith("User:") || line.startsWith("Assistant:"));

    expect(history).not.toContain("earlier turns omitted");
    expect(turnLines).toHaveLength(50);
    expect(history).toContain("User: user-1");
    expect(history).toContain("Assistant: assistant-1");
    expect(history).toContain("User: user-25");
    expect(history).toContain("Assistant: assistant-25");
  });

  it("SQLite persistence round-trip", () => {
    const dir = mkdtempSync(nodePath.join(os.tmpdir(), "gemini-session-store-"));
    const dbPath = nodePath.join(dir, "sessions.db");
    const id = "session-persist";
    const first = new SessionStore(SESSION_TTL_MS, undefined, dbPath);

    try {
      first.create(id);
      first.appendTurn(id, "user", "hello");
      first.appendTurn(id, "assistant", "hi");
      first.appendTurn(id, "user", "how are you?");
      first.appendTurn(id, "assistant", "doing well");
    } finally {
      first.destroy();
    }

    const second = new SessionStore(SESSION_TTL_MS, undefined, dbPath);
    try {
      expect(second.get(id)).toBe(true);
      const history = second.formatHistory(id);
      expect(history).toContain("User: hello");
      expect(history).toContain("Assistant: hi");
      expect(history).toContain("User: how are you?");
      expect(history).toContain("Assistant: doing well");
    } finally {
      second.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expired sessions are removed by GC", () => {
    const ttlMs = 1_000;
    const gcIntervalMs = 200;
    const gcStore = new SessionStore(ttlMs, gcIntervalMs, ":memory:");

    try {
      const id = "session-gc";
      gcStore.create(id);

      vi.advanceTimersByTime(ttlMs + gcIntervalMs + 1);
      expect(gcStore.get(id)).toBe(false);
    } finally {
      gcStore.destroy();
    }
  });
});

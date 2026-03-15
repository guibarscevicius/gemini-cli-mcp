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

  it("getSessionCount() returns the total number of sessions", () => {
    expect(store.getSessionCount()).toBe(0);
    store.create("session-1");
    store.create("session-2");
    expect(store.getSessionCount()).toBe(2);
  });

  it("appendTurn() and formatHistory() keep turn order", () => {
    const id = "session-order";
    store.create(id);
    store.appendTurn(id, "user", "q1");
    store.appendTurn(id, "assistant", "a1");
    store.appendTurn(id, "user", "q2");
    store.appendTurn(id, "assistant", "a2");

    const { history, truncated, totalTurns } = store.formatHistory(id);
    const lines = history.split("\n");

    expect(lines[0]).toBe("[Conversation history]");
    expect(lines[1]).toBe("User: q1");
    expect(lines[2]).toBe("Assistant: a1");
    expect(lines[3]).toBe("User: q2");
    expect(lines[4]).toBe("Assistant: a2");
    expect(lines[5]).toBe("[End of history — continue the conversation]");
    expect(truncated).toBe(false);
    expect(totalTurns).toBe(4);
  });

  it("appendTurn on non-existent session drops the turn and leaves store consistent", () => {
    const id = "rollback-test";
    store.create(id);
    store.appendTurn("ghost-session", "user", "should be dropped");
    store.appendTurn(id, "user", "should work");
    store.appendTurn(id, "assistant", "response");
    const { history } = store.formatHistory(id);
    expect(history).toContain("should work");
    expect(history).not.toContain("should be dropped");
  });

  it("formatHistory() truncation", () => {
    const id = "session-truncate";
    store.create(id);

    for (let i = 1; i <= 25; i++) {
      store.appendTurn(id, "user", `user-${i}`);
      store.appendTurn(id, "assistant", `assistant-${i}`);
    }

    const { history, truncated, totalTurns } = store.formatHistory(id);
    const lines = history.split("\n");
    const turnLines = lines.filter(
      (line) => line.startsWith("User:") || line.startsWith("Assistant:")
    );

    expect(history).toContain("earlier turns omitted");
    expect(truncated).toBe(true);
    expect(totalTurns).toBe(50);
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

    const { history, truncated, totalTurns } = store.formatHistory(id);
    const turnLines = history
      .split("\n")
      .filter((line) => line.startsWith("User:") || line.startsWith("Assistant:"));

    expect(history).not.toContain("earlier turns omitted");
    expect(truncated).toBe(false);
    expect(totalTurns).toBe(50);
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
      const { history } = second.formatHistory(id);
      expect(history).toContain("User: hello");
      expect(history).toContain("Assistant: hi");
      expect(history).toContain("User: how are you?");
      expect(history).toContain("Assistant: doing well");
    } finally {
      second.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("getTurns()", () => {
    it("returns undefined for a session that does not exist", () => {
      expect(store.getTurns("no-such-session")).toBeUndefined();
    });

    it("returns an empty array for a freshly created session with no turns", () => {
      const id = "empty-session";
      store.create(id);
      expect(store.getTurns(id)).toEqual([]);
    });

    it("returns turns in insertion order after appendTurn calls", () => {
      const id = "turns-order";
      store.create(id);
      store.appendTurn(id, "user", "hello");
      store.appendTurn(id, "assistant", "hi there");
      store.appendTurn(id, "user", "how are you?");

      expect(store.getTurns(id)).toEqual([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "how are you?" },
      ]);
    });

    it("touching via getTurns keeps the session alive through a GC sweep", () => {
      const ttlMs = 1_000;
      const gcIntervalMs = 200;
      const gcStore = new SessionStore(ttlMs, gcIntervalMs, ":memory:");

      try {
        const id = "session-touch-via-get-turns";
        gcStore.create(id);

        // Advance to just before expiry, call getTurns to refresh last_accessed
        vi.advanceTimersByTime(ttlMs - 1);
        expect(gcStore.getTurns(id)).toEqual([]);

        // Advance past the original TTL — session should still be alive because of the touch
        vi.advanceTimersByTime(ttlMs / 2 + gcIntervalMs + 1);
        expect(gcStore.getTurns(id)).toEqual([]);
      } finally {
        gcStore.destroy();
      }
    });
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

describe("setListChangedCallback", () => {
  let s: SessionStore;
  beforeEach(() => { vi.useFakeTimers(); s = new SessionStore(SESSION_TTL_MS, undefined, ":memory:"); });
  afterEach(() => { s.destroy(); vi.useRealTimers(); });

  it("fires the callback when a session is created", () => {
    const cb = vi.fn();
    s.setListChangedCallback(cb);
    s.create("cb-session-1");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not fire the callback before it is set", () => {
    const cb = vi.fn();
    s.create("cb-session-before");
    s.setListChangedCallback(cb);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("listSessions", () => {
  let s: SessionStore;
  beforeEach(() => { vi.useFakeTimers(); s = new SessionStore(SESSION_TTL_MS, undefined, ":memory:"); });
  afterEach(() => { s.destroy(); vi.useRealTimers(); });

  it("returns empty array when no sessions exist", () => {
    expect(s.listSessions()).toEqual([]);
  });

  it("returns all sessions with id, lastAccessed, and turnCount", () => {
    s.create("ls-a");
    s.appendTurn("ls-a", "user", "hello");
    s.appendTurn("ls-a", "assistant", "world");
    s.create("ls-b");

    const sessions = s.listSessions();
    expect(sessions).toHaveLength(2);

    const a = sessions.find(r => r.id === "ls-a")!;
    expect(a.turnCount).toBe(2);
    expect(typeof a.lastAccessed).toBe("number");

    const b = sessions.find(r => r.id === "ls-b")!;
    expect(b.turnCount).toBe(0);
  });

  it("returns sessions ordered by last_accessed DESC", () => {
    s.create("ls-old");
    vi.advanceTimersByTime(100);
    s.create("ls-new");

    const sessions = s.listSessions();
    expect(sessions[0].id).toBe("ls-new");
    expect(sessions[1].id).toBe("ls-old");
  });
});

describe("getSessionMeta", () => {
  let s: SessionStore;
  beforeEach(() => { vi.useFakeTimers(); s = new SessionStore(SESSION_TTL_MS, undefined, ":memory:"); });
  afterEach(() => { s.destroy(); vi.useRealTimers(); });

  it("returns undefined for unknown session", () => {
    expect(s.getSessionMeta("no-such-id")).toBeUndefined();
  });

  it("returns lastAccessed and turns for a known session", () => {
    s.create("meta-s");
    s.appendTurn("meta-s", "user", "q");
    s.appendTurn("meta-s", "assistant", "a");

    const meta = s.getSessionMeta("meta-s");
    expect(meta).toBeDefined();
    expect(typeof meta!.lastAccessed).toBe("number");
    expect(meta!.turns).toHaveLength(2);
    expect(meta!.turns[0].role).toBe("user");
    expect(meta!.turns[1].role).toBe("assistant");
  });

  it("does NOT update last_accessed (no side effect)", () => {
    s.create("meta-touch-test");
    const before = s.getSessionMeta("meta-touch-test")!.lastAccessed;
    vi.advanceTimersByTime(500);
    const after = s.getSessionMeta("meta-touch-test")!.lastAccessed;
    expect(after).toBe(before);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SessionStore } from "../src/session-store.js";

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new SessionStore();
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
  });

  // ── create() ──────────────────────────────────────────────────────────────

  it("create() returns a UUID-shaped string", () => {
    const id = store.create();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("create() returns a unique ID each call", () => {
    const ids = new Set(Array.from({ length: 10 }, () => store.create()));
    expect(ids.size).toBe(10);
  });

  // ── get() ─────────────────────────────────────────────────────────────────

  it("get() returns session after create()", () => {
    const id = store.create();
    expect(store.get(id)).not.toBeNull();
  });

  it("get() returns null for unknown ID", () => {
    expect(store.get("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("get() updates lastAccessed on each call", () => {
    const id = store.create();
    const session1 = store.get(id)!;
    const t1 = session1.lastAccessed;

    vi.advanceTimersByTime(1000);

    const session2 = store.get(id)!;
    expect(session2.lastAccessed).toBeGreaterThan(t1);
  });

  // ── appendTurn() ──────────────────────────────────────────────────────────

  it("appendTurn() adds a user turn followed by a gemini turn", () => {
    const id = store.create();
    store.appendTurn(id, "hello", "hi there");

    const session = store.get(id)!;
    expect(session.turns).toHaveLength(2);
    expect(session.turns[0]).toEqual({ role: "user", content: "hello" });
    expect(session.turns[1]).toEqual({ role: "gemini", content: "hi there" });
  });

  it("appendTurn() accumulates turns across multiple calls", () => {
    const id = store.create();
    store.appendTurn(id, "turn 1 user", "turn 1 gemini");
    store.appendTurn(id, "turn 2 user", "turn 2 gemini");

    expect(store.get(id)!.turns).toHaveLength(4);
  });

  it("appendTurn() throws for unknown session ID", () => {
    expect(() =>
      store.appendTurn("00000000-0000-4000-8000-000000000000", "x", "y")
    ).toThrow("Session not found");
  });

  it("appendTurn() updates lastAccessed", () => {
    const id = store.create();
    const before = store.get(id)!.lastAccessed;
    vi.advanceTimersByTime(500);
    store.appendTurn(id, "u", "g");
    expect(store.get(id)!.lastAccessed).toBeGreaterThan(before);
  });

  // ── formatHistory() ───────────────────────────────────────────────────────

  it("formatHistory() returns empty string for a fresh session (no turns)", () => {
    const id = store.create();
    expect(store.formatHistory(id)).toBe("");
  });

  it("formatHistory() returns empty string for unknown session ID", () => {
    expect(store.formatHistory("00000000-0000-4000-8000-000000000000")).toBe("");
  });

  it("formatHistory() wraps turns in [Conversation history] block", () => {
    const id = store.create();
    store.appendTurn(id, "what is 2+2?", "4");

    const history = store.formatHistory(id);
    expect(history).toContain("[Conversation history]");
    expect(history).toContain("[End of history");
    expect(history).toContain("User: what is 2+2?");
    expect(history).toContain("Gemini: 4");
  });

  it("formatHistory() includes all turns in order", () => {
    const id = store.create();
    store.appendTurn(id, "q1", "a1");
    store.appendTurn(id, "q2", "a2");

    const history = store.formatHistory(id);
    const lines = history.split("\n");
    // Header + 4 turn lines + footer
    expect(lines).toHaveLength(6);
    expect(lines[1]).toBe("User: q1");
    expect(lines[2]).toBe("Gemini: a1");
    expect(lines[3]).toBe("User: q2");
    expect(lines[4]).toBe("Gemini: a2");
  });

  // ── Multiple independent sessions ──────────────────────────────────────────

  it("two sessions are completely independent", () => {
    const id1 = store.create();
    const id2 = store.create();
    store.appendTurn(id1, "session 1 question", "session 1 answer");

    expect(store.get(id1)!.turns).toHaveLength(2);
    expect(store.get(id2)!.turns).toHaveLength(0);
    expect(store.formatHistory(id2)).toBe("");
  });

  // ── TTL / garbage collection ───────────────────────────────────────────────

  it("sessions survive before TTL expires", () => {
    const TTL = 1000;
    const GC = 500;
    const s = new SessionStore(TTL, GC);
    const id = s.create();

    vi.advanceTimersByTime(GC + 1); // GC runs once
    expect(s.get(id)).not.toBeNull(); // Still alive — TTL not reached

    s.destroy();
  });

  it("sessions are removed after TTL expires and GC runs", () => {
    const TTL = 1000;
    const GC = 500;
    const s = new SessionStore(TTL, GC);
    const id = s.create();

    vi.advanceTimersByTime(TTL + GC + 1); // TTL elapsed, then GC fires
    expect(s.get(id)).toBeNull();

    s.destroy();
  });

  it("active sessions are not evicted by GC", () => {
    const TTL = 1000;
    const GC = 400;
    const s = new SessionStore(TTL, GC);
    const id = s.create();

    // Keep accessing the session to refresh lastAccessed
    vi.advanceTimersByTime(800);
    s.get(id); // refreshes lastAccessed
    vi.advanceTimersByTime(800); // total 1600ms but lastAccessed was reset at 800ms

    expect(s.get(id)).not.toBeNull();
    s.destroy();
  });

  // ── destroy() ─────────────────────────────────────────────────────────────

  it("destroy() stops the GC timer (no pending timers after destroy)", () => {
    const s = new SessionStore(1000, 500);
    const id = s.create();
    s.destroy();

    // After destroy, GC should not fire even if time advances past TTL
    vi.advanceTimersByTime(2000);
    // Session is still in map because GC didn't run after destroy
    // (We can't directly inspect the map, but no unhandled timer errors = pass)
    expect(s.get(id)).not.toBeNull();
  });
});

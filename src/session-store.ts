import { randomUUID } from "node:crypto";

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

interface Session {
  turns: Turn[];
  /** Unix timestamp (ms) of the last read or write — used for TTL eviction. */
  lastAccessed: number;
}

// Sessions idle longer than this are garbage-collected
const SESSION_TTL_MS = 60 * 60 * 1000; // 60 minutes
// How often to sweep expired sessions
const GC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * In-memory store for multi-turn Gemini sessions.
 *
 * Why not use `gemini --resume <id>`?
 * The `--resume` flag is scoped to a project directory: session files live at
 * `~/.gemini/tmp/<hash_of_project_dir>/chats/`. Even if we passed a consistent
 * `cwd`, each MCP caller has a different project context, so we would need to
 * store the originating `cwd` per session and replay it on every `--resume`
 * call — recreating the same bookkeeping we're doing here, but with an
 * unreliable file-system dependency. In-process history is simpler and more
 * portable.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly gcTimer: ReturnType<typeof setInterval>;

  constructor(ttlMs = SESSION_TTL_MS, gcIntervalMs = GC_INTERVAL_MS) {
    this.gcTimer = setInterval(() => this.gc(ttlMs), gcIntervalMs).unref();
  }

  /** Create a new empty session and return its ID. */
  create(): string {
    const id = randomUUID();
    this.sessions.set(id, { turns: [], lastAccessed: Date.now() });
    return id;
  }

  /**
   * Create a new session pre-populated with the first user+assistant turn.
   * Preferred over create() + appendTurn() — atomic, so the session is never
   * observable in a turns-empty state.
   */
  createWithTurn(userContent: string, assistantContent: string): string {
    const id = randomUUID();
    this.sessions.set(id, {
      turns: [
        { role: "user", content: userContent },
        { role: "assistant", content: assistantContent },
      ],
      lastAccessed: Date.now(),
    });
    return id;
  }

  /** Retrieve a session, updating lastAccessed. Returns null if not found / expired. */
  get(id: string): Readonly<Session> | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.lastAccessed = Date.now();
    return session;
  }

  /** Append a user+assistant turn pair to an existing session */
  appendTurn(id: string, userContent: string, assistantContent: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    session.turns.push(
      { role: "user", content: userContent },
      { role: "assistant", content: assistantContent }
    );
    session.lastAccessed = Date.now();
  }

  /**
   * Format prior turns as a structured context block to prepend to a new prompt.
   * Returns empty string if there are no prior turns (first message in session).
   */
  formatHistory(id: string): string {
    const session = this.sessions.get(id);
    if (!session || session.turns.length === 0) return "";

    const lines: string[] = ["[Conversation history]"];
    for (const turn of session.turns) {
      const label = turn.role === "user" ? "User" : "Assistant";
      lines.push(`${label}: ${turn.content}`);
    }
    lines.push("[End of history — continue the conversation]");
    return lines.join("\n");
  }

  /** Remove sessions that have exceeded the TTL */
  private gc(ttlMs: number): void {
    const cutoff = Date.now() - ttlMs;
    for (const [id, session] of this.sessions) {
      if (session.lastAccessed < cutoff) {
        this.sessions.delete(id);
      }
    }
  }

  /** Tear down the GC timer (useful in tests) */
  destroy(): void {
    clearInterval(this.gcTimer);
  }
}

// Singleton instance shared across all tool handlers
export const sessionStore = new SessionStore();

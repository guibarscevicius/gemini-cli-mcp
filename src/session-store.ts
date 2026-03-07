import { DatabaseSync } from "node:sqlite";
import nodePath from "node:path";
import * as os from "node:os";
import { mkdirSync } from "node:fs";

export const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const GC_INTERVAL_MS = 5 * 60 * 1000; // 5 min

type TurnRole = "user" | "assistant";

interface Turn {
  role: TurnRole;
  content: string;
}

export class SessionStore {
  private db: DatabaseSync;
  private gcTimer: ReturnType<typeof setInterval>;
  /** Maps sessionId → jobId for in-flight async jobs. */
  private pendingJobs = new Map<string, string>();

  constructor(ttlMs = SESSION_TTL_MS, gcIntervalMs = GC_INTERVAL_MS, dbPath?: string) {
    const resolvedPath =
      dbPath ??
      (process.env.GEMINI_SESSION_DB ?? nodePath.join(os.homedir(), ".gemini-cli-mcp", "sessions.db"));

    if (resolvedPath !== ":memory:") {
      mkdirSync(nodePath.dirname(resolvedPath), { recursive: true });
    }

    this.db = new DatabaseSync(resolvedPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      turns TEXT NOT NULL,
      last_accessed INTEGER NOT NULL
    )`);

    this.gcTimer = setInterval(() => {
      const cutoff = Date.now() - ttlMs;
      this.db.prepare("DELETE FROM sessions WHERE last_accessed < ?").run(cutoff);
    }, gcIntervalMs);

    if (this.gcTimer.unref) this.gcTimer.unref();
  }

  create(id: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO sessions (id, turns, last_accessed) VALUES (?, ?, ?)")
      .run(id, JSON.stringify([]), Date.now());
  }

  get(id: string): boolean {
    const row = this.db.prepare("SELECT id FROM sessions WHERE id = ?").get(id);
    if (!row) return false;
    this.db.prepare("UPDATE sessions SET last_accessed = ? WHERE id = ?").run(Date.now(), id);
    return true;
  }

  appendTurn(id: string, role: TurnRole, content: string): void {
    const row = this.db.prepare("SELECT turns FROM sessions WHERE id = ?").get(id) as
      | { turns: string }
      | undefined;
    if (!row) {
      process.stderr.write(`[gemini-cli-mcp] appendTurn: session ${id} not found — turn dropped\n`);
      return;
    }
    const turns: Turn[] = JSON.parse(row.turns);
    turns.push({ role, content });
    this.db
      .prepare("UPDATE sessions SET turns = ?, last_accessed = ? WHERE id = ?")
      .run(JSON.stringify(turns), Date.now(), id);
  }

  formatHistory(id: string): string {
    const row = this.db.prepare("SELECT turns FROM sessions WHERE id = ?").get(id) as
      | { turns: string }
      | undefined;
    if (!row) return "";
    const allTurns: Turn[] = JSON.parse(row.turns);
    if (allTurns.length === 0) return "";

    const maxPairs = parseInt(process.env.GEMINI_MAX_HISTORY_TURNS ?? "20");
    const limit = maxPairs > 0 ? maxPairs * 2 : Infinity;
    const truncated = isFinite(limit) && allTurns.length > limit;
    const turns = isFinite(limit) ? allTurns.slice(-limit) : allTurns;

    const lines: string[] = ["[Conversation history]"];
    if (truncated) {
      lines.push(`[... ${allTurns.length - turns.length} earlier turns omitted ...]`);
    }
    for (const turn of turns) {
      lines.push(`${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`);
    }
    lines.push("[End of history — continue the conversation]");
    return lines.join("\n");
  }

  setPendingJob(sessionId: string, jobId: string): void {
    this.pendingJobs.set(sessionId, jobId);
  }

  clearPendingJob(sessionId: string): void {
    this.pendingJobs.delete(sessionId);
  }

  getPendingJob(sessionId: string): string | undefined {
    return this.pendingJobs.get(sessionId);
  }

  destroy(): void {
    clearInterval(this.gcTimer);
    this.db.close();
  }
}

export const sessionStore = new SessionStore();

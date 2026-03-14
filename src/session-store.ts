import { DatabaseSync } from "node:sqlite";
import nodePath from "node:path";
import * as os from "node:os";
import { mkdirSync } from "node:fs";
import { mcpLog } from "./logging.js";

export const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const GC_INTERVAL_MS = 5 * 60 * 1000; // 5 min

export type TurnRole = "user" | "assistant";

export interface Turn {
  role: TurnRole;
  content: string;
}

export class SessionStore {
  private db: DatabaseSync;
  private gcTimer: ReturnType<typeof setInterval>;
  private readonly stmtCreate: ReturnType<DatabaseSync["prepare"]>;
  private readonly stmtExists: ReturnType<DatabaseSync["prepare"]>;
  private readonly stmtTouch: ReturnType<DatabaseSync["prepare"]>;
  private readonly stmtGetTurns: ReturnType<DatabaseSync["prepare"]>;
  private readonly stmtUpdateTurns: ReturnType<DatabaseSync["prepare"]>;
  private readonly stmtGcSelect: ReturnType<DatabaseSync["prepare"]>;
  private readonly stmtGcDelete: ReturnType<DatabaseSync["prepare"]>;
  private readonly stmtCount: ReturnType<DatabaseSync["prepare"]>;
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

    this.stmtCreate = this.db.prepare(
      "INSERT OR IGNORE INTO sessions (id, turns, last_accessed) VALUES (?, ?, ?)"
    );
    this.stmtExists = this.db.prepare("SELECT id FROM sessions WHERE id = ?");
    this.stmtTouch = this.db.prepare("UPDATE sessions SET last_accessed = ? WHERE id = ?");
    this.stmtGetTurns = this.db.prepare("SELECT turns FROM sessions WHERE id = ?");
    this.stmtUpdateTurns = this.db.prepare(
      "UPDATE sessions SET turns = ?, last_accessed = ? WHERE id = ?"
    );
    this.stmtGcSelect = this.db.prepare("SELECT id FROM sessions WHERE last_accessed < ?");
    this.stmtGcDelete = this.db.prepare("DELETE FROM sessions WHERE last_accessed < ?");
    this.stmtCount = this.db.prepare("SELECT COUNT(*) as n FROM sessions");

    this.gcTimer = setInterval(() => {
      try {
        const cutoff = Date.now() - ttlMs;
        const expiredRows = this.stmtGcSelect.all(cutoff) as { id: string }[];
        for (const row of expiredRows) {
          this.pendingJobs.delete(row.id);
        }
        this.stmtGcDelete.run(cutoff);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[gemini-cli-mcp] session GC failed: ${message}\n`
        );
        mcpLog("warning", "gc", { event: "session_gc_error", error: message });
      }
    }, gcIntervalMs);

    if (this.gcTimer.unref) this.gcTimer.unref();
  }

  create(id: string): void {
    this.stmtCreate.run(id, JSON.stringify([]), Date.now());
  }

  get(id: string): boolean {
    const row = this.stmtExists.get(id);
    if (!row) return false;
    this.stmtTouch.run(Date.now(), id);
    return true;
  }

  getTurns(id: string): Turn[] | undefined {
    const row = this.stmtGetTurns.get(id) as { turns: string } | undefined;
    if (!row) return undefined;
    try {
      this.stmtTouch.run(Date.now(), id);
    } catch (err) {
      // Touch failure is non-fatal: TTL accuracy is less important than returning data.
      process.stderr.write(
        `[gemini-cli-mcp] getTurns: failed to touch session ${id}: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
    try {
      return JSON.parse(row.turns) as Turn[];
    } catch (err) {
      process.stderr.write(
        `[gemini-cli-mcp] getTurns: session ${id} has corrupt turn data: ${err instanceof Error ? err.message : String(err)}\n`
      );
      throw new Error(`Session ${id} has corrupt turn data and cannot be exported`);
    }
  }

  appendTurn(id: string, role: TurnRole, content: string): void {
    this.db.exec("BEGIN");
    try {
      const row = this.stmtGetTurns.get(id) as { turns: string } | undefined;
      if (!row) {
        process.stderr.write(`[gemini-cli-mcp] appendTurn: session ${id} not found — turn dropped\n`);
        this.db.exec("ROLLBACK");
        return;
      }
      const turns: Turn[] = JSON.parse(row.turns);
      turns.push({ role, content });
      this.stmtUpdateTurns.run(JSON.stringify(turns), Date.now(), id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  formatHistory(id: string): string {
    const row = this.stmtGetTurns.get(id) as { turns: string } | undefined;
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

  getSessionCount(): number {
    return (this.stmtCount.get() as { n: number }).n;
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

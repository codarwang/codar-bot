/**
 * usage ledger — the §4 usage.sqlite accounting sink.
 *
 * Primary key (hour, bot_id, model, kind) with additive upsert (idempotent
 * re-ingest of the same bucket). Values mirror the M0-S3-verified shapes:
 * tokens as integers, cost_micros = round(usd × 1e6) per report.
 */
import { DatabaseSync } from "node:sqlite";

export interface UsageRecord {
  hour: string; // UTC 'YYYY-MM-DDTHH'
  botId: string;
  model: string; // 'provider/modelId'
  kind: "chat" | "tool" | "memory-review";
  /** Where the work happened (room turns / handoff runs carry it): the
   *  ROOM budget meters spend ATTRIBUTED to the room, not the members'
   *  global month totals — a new room with a hot member used to be born
   *  over-limit (dogfood D3). Null = not room-attributable (direct
   *  prompts, memory reviews). */
  roomId?: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  costMicros: number;
}

export interface UsageQuery {
  botId?: string;
  sinceHour?: string;
  kind?: UsageRecord["kind"];
  /** Filter by room attribution (exact id); rows recorded before the
   *  column existed read as NULL and never match. */
  roomId?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage (
  hour TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cache_write_1h INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  -- '' sentinel, NOT NULL: SQLite composite-PK NULLs never compare equal,
  -- so ON CONFLICT never fired for unattributed rows and every message_end
  -- grew a new row (D3 review P3-1). '' = unattributed by construction.
  room_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (hour, bot_id, model, kind, room_id)
)`;

export class UsageLedger {
  private readonly db: DatabaseSync;
  /** Post-write hook (budget enforcement checks after every record). */
  onRecord: ((botId: string) => void) | null = null;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    // PK migration (dogfood D3): room attribution joins the bucket key, so
    // the same hour×bot×model×kind splits per room. SQLite cannot ALTER a
    // PRIMARY KEY — rebuild the table; legacy rows carry NULL room_id
    // (unattributed: bot budgets still count them, room budgets do not).
    // Residue recovery (D3 R4 P3-1): a crash under the R3-era migration
    // could leave data stranded in usage_v1 (new empty `usage` beside it —
    // silently empty reports) or a stray usage_v1 next to a v0 table
    // (RENAME collision at startup). Adopt any stranded table first.
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usage_v1'").all() as Array<{ name: string }>;
    if (tables.length > 0) {
      this.adoptStranded();
    }
    const cols = this.db.prepare("PRAGMA table_info(usage)").all() as Array<{ name: string; notnull: number }>;
    const roomCol = cols.find((c) => c.name === "room_id");
    // Guard on presence AND nullability: a ledger migrated by the first
    // (nullable) revision keeps NULL rows forever and splits new
    // unattributed writes into a separate '' bucket (R2 verdict P3) —
    // rebuild it too.
    if (roomCol === undefined || roomCol.notnull === 0) {
      // Fresh v0 table OR v1 nullable-migrated table: rebuild under a temp
      // name. The whole rebuild rides ONE transaction — a mid-flight crash
      // must not leave an empty new table plus the data stranded in
      // usage_v1 (the second open then saw NOT NULL, skipped the migration,
      // and silently reported an empty ledger — R3 P2).
      const roomExpr = roomCol === undefined ? "''" : "COALESCE(room_id, '')";
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec("ALTER TABLE usage RENAME TO usage_v1");
        this.db.exec(SCHEMA);
        // v1 NULL rows and any '' rows written by the interim build can
        // share a bucket after COALESCE — aggregate instead of raw-copy so
        // the UNIQUE PK never collides.
        this.db.exec(
          "INSERT INTO usage (hour, bot_id, model, kind, input, output, cache_read, cache_write, cache_write_1h, cost_micros, room_id) " +
          `SELECT hour, bot_id, model, kind, SUM(input), SUM(output), SUM(cache_read), SUM(cache_write), SUM(cache_write_1h), SUM(cost_micros), ${roomExpr} ` +
          "FROM usage_v1 GROUP BY hour, bot_id, model, kind, " + roomExpr
        );
        this.db.exec("DROP TABLE usage_v1");
        this.db.exec("COMMIT");
      } catch (error) {
        // ROLLBACK itself throws "no transaction is active" when SQLite
        // already auto-rolled-back (BUSY/IO) — never mask the original
        // error (D3 R4 P3-3).
        try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
        throw error;
      }
    }
  }

  /** Fold a stranded usage_v1 (crash residue) back into `usage`.
   *  Runs inside the caller's migration transaction flow — here we are
   *  pre-transaction, so wrap our own. */
  private adoptStranded(): void {
    const mainCols = (this.db.prepare("PRAGMA table_info(usage)").all() as Array<{ name: string }>).map((c) => c.name);
    const hasRoom = mainCols.includes("room_id");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!hasRoom) {
        // v0 main table: data in v1 is NEWER — swap them so the normal
        // v0 path migrates the union.
        this.db.exec("ALTER TABLE usage RENAME TO usage_old_v0");
        this.db.exec("ALTER TABLE usage_v1 RENAME TO usage");
        this.db.exec(SCHEMA.replace(/usage/g, "usage_merge"));
        // Prefer stranded v1 data; v0 buckets merge alongside.
        const roomExprV1 = "COALESCE(room_id, '')";
        this.db.exec(
          "INSERT INTO usage_merge (hour, bot_id, model, kind, input, output, cache_read, cache_write, cache_write_1h, cost_micros, room_id) " +
          `SELECT hour, bot_id, model, kind, SUM(input), SUM(output), SUM(cache_read), SUM(cache_write), SUM(cache_write_1h), SUM(cost_micros), ${roomExprV1} FROM usage GROUP BY hour, bot_id, model, kind, ${roomExprV1}`
        );
        this.db.exec(
          "INSERT INTO usage_merge (hour, bot_id, model, kind, input, output, cache_read, cache_write, cache_write_1h, cost_micros, room_id) " +
          "SELECT hour, bot_id, model, kind, SUM(input), SUM(output), SUM(cache_read), SUM(cache_write), SUM(cache_write_1h), SUM(cost_micros), '' FROM usage_old_v0 GROUP BY hour, bot_id, model, kind"
        );
        this.db.exec("DROP TABLE usage");
        this.db.exec("DROP TABLE usage_old_v0");
        this.db.exec("ALTER TABLE usage_merge RENAME TO usage");
      } else {
        // Sentinel-era main table: merge the stranded rows in.
        this.db.exec(
          "INSERT INTO usage (hour, bot_id, model, kind, input, output, cache_read, cache_write, cache_write_1h, cost_micros, room_id) " +
          "SELECT hour, bot_id, model, kind, SUM(input), SUM(output), SUM(cache_read), SUM(cache_write), SUM(cache_write_1h), SUM(cost_micros), COALESCE(room_id, '') FROM usage_v1 GROUP BY hour, bot_id, model, kind, COALESCE(room_id, '')"
        );
        this.db.exec("DROP TABLE usage_v1");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
  }

  /** Additive upsert onto the (hour, bot, model, kind) bucket. NOT idempotent
   *  against replay: the caller dedupes via the per-session accounting
   *  watermark (architecture §4 reconciliation — M1-B/D); re-recording the
   *  same event double-counts by design of this sink. */
  record(u: UsageRecord): void {
    this.db
      .prepare(
        `INSERT INTO usage (hour, bot_id, model, kind, input, output, cache_read, cache_write, cache_write_1h, cost_micros, room_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hour, bot_id, model, kind, room_id) DO UPDATE SET
           input = input + excluded.input,
           output = output + excluded.output,
           cache_read = cache_read + excluded.cache_read,
           cache_write = cache_write + excluded.cache_write,
           cache_write_1h = cache_write_1h + excluded.cache_write_1h,
           cost_micros = cost_micros + excluded.cost_micros`
      )
      .run(
        u.hour, u.botId, u.model, u.kind,
        u.input, u.output, u.cacheRead, u.cacheWrite, u.cacheWrite1h, u.costMicros,
        u.roomId ?? ""
      );
    this.onRecord?.(u.botId);
  }

  /** Aggregate totals for a query window (per bot × model × kind rows —
   *  the §4 "每 Bot × 模型 × 用途" ledger shape). */
  totals(q: UsageQuery = {}): Array<{
    botId: string; model: string; kind: UsageRecord["kind"];
    input: number; output: number;
    cacheRead: number; cacheWrite: number; cacheWrite1h: number; costMicros: number;
  }> {
    const where: string[] = [];
    const args: Array<string> = [];
    if (q.botId !== undefined) { where.push("bot_id = ?"); args.push(q.botId); }
    if (q.sinceHour !== undefined) { where.push("hour >= ?"); args.push(q.sinceHour); }
    if (q.kind !== undefined) { where.push("kind = ?"); args.push(q.kind); }
    if (q.roomId !== undefined) { where.push("room_id = ?"); args.push(q.roomId); }
    const sql = `SELECT bot_id, model, kind,
        SUM(input) AS input, SUM(output) AS output,
        SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
        SUM(cache_write_1h) AS cache_write_1h, SUM(cost_micros) AS cost_micros
      FROM usage ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY bot_id, model, kind ORDER BY cost_micros DESC`;
    return (this.db.prepare(sql).all(...args) as Array<Record<string, number | string>>).map((row) => ({
      botId: String(row.bot_id),
      model: String(row.model),
      kind: String(row.kind) as UsageRecord["kind"],
      input: Number(row.input ?? 0),
      output: Number(row.output ?? 0),
      cacheRead: Number(row.cache_read ?? 0),
      cacheWrite: Number(row.cache_write ?? 0),
      cacheWrite1h: Number(row.cache_write_1h ?? 0),
      costMicros: Number(row.cost_micros ?? 0),
    }));
  }

  close(): void {
    this.db.close();
  }
}

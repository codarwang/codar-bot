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
  room_id TEXT,
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
    const pk = (this.db.prepare("PRAGMA table_info(usage)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!pk.includes("room_id")) {
      this.db.exec("ALTER TABLE usage RENAME TO usage_v1");
      this.db.exec(SCHEMA);
      this.db.exec(
        "INSERT INTO usage (hour, bot_id, model, kind, input, output, cache_read, cache_write, cache_write_1h, cost_micros, room_id) " +
        "SELECT hour, bot_id, model, kind, input, output, cache_read, cache_write, cache_write_1h, cost_micros, NULL FROM usage_v1"
      );
      this.db.exec("DROP TABLE usage_v1");
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
        u.roomId ?? null
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

/**
 * UsageLedger unit tests — idempotent additive upsert + totals (offline).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageLedger, type UsageRecord } from "../src/host/usage-ledger.js";

function rec(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    hour: "2026-11-05T10", botId: "bot_a", model: "p/m", kind: "chat",
    input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costMicros: 12,
    ...over,
  };
}

test("additive upsert: same bucket sums; distinct buckets stay separate rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "codar-ledger-"));
  try {
    const l = new UsageLedger(join(dir, "usage.sqlite"));
    l.record(rec());
    l.record(rec({ input: 5, output: 1, costMicros: 7 }));
    l.record(rec({ kind: "tool", botId: "bot_b", hour: "2026-11-05T11" }));
    const totals = l.totals();
    const chat = totals.find((t) => t.botId === "bot_a" && t.model === "p/m");
    assert.equal(chat?.input, 15);
    assert.equal(chat?.output, 3);
    assert.equal(chat?.costMicros, 19);
    assert.equal(totals.length, 2); // bot_a/p/m + bot_b/p/m(tool only merges same key)
    l.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("totals filters: bot + since + kind", () => {
  const dir = mkdtempSync(join(tmpdir(), "codar-ledger-"));
  try {
    const l = new UsageLedger(join(dir, "usage.sqlite"));
    l.record(rec({ hour: "2026-11-04T09", botId: "bot_old" }));
    l.record(rec({ hour: "2026-11-05T10", kind: "chat" }));
    l.record(rec({ hour: "2026-11-05T10", kind: "memory-review" }));
    assert.equal(l.totals({ botId: "bot_a" }).length, 2); // chat + memory-review rows
    const since = l.totals({ sinceHour: "2026-11-05T00" });
    assert.equal(since.length, 2); // bot_a chat + bot_a memory-review (bot_old excluded)
    assert.ok(since.every((t) => t.botId === "bot_a"));
    assert.equal(l.totals({ kind: "chat", botId: "bot_a" })[0]!.input, 10);
    l.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dogfood D3 review P3-1: unattributed rows MERGE into one bucket (NULL PK hole)", () => {
  const root = mkdtempSync(join(tmpdir(), "codar-ul-null-"));
  const ledger = new UsageLedger(join(root, "usage.sqlite"));
  try {
    const base = { hour: "2026-11-06T09", botId: "bot_x", model: "fake/f", kind: "chat" as const, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costMicros: 0 };
    // Two unattributed records in the same bucket (memory reviews / direct
    // prompts) — with the old NULL-PK these created TWO rows.
    ledger.record({ ...base, input: 10, output: 1, roomId: null });
    ledger.record({ ...base, input: 20, output: 2, roomId: null });
    const rows = ledger.totals({ botId: "bot_x" });
    assert.equal(rows.length, 1, "same bucket merges into ONE row");
    assert.equal(rows[0]!.input, 30, "inputs add up");
    // And a room-attributed row lands in its own QUERYABLE bucket (the
    // totals GROUP BY folds buckets per bot — attribution shows via the
    // roomId filter, and the row COUNT is observable at the table level).
    ledger.record({ ...base, input: 5, output: 0, roomId: "room_a" });
    assert.equal(ledger.totals({ roomId: "room_a" })[0]!.input, 5);
    assert.equal(ledger.totals({ botId: "bot_x" })[0]!.input, 35, "bot totals unchanged by attribution");
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("dogfood D3 R2: a v1 nullable-room_id ledger RE-MIGRATES to the sentinel schema", async () => {
  const root = mkdtempSync(join(tmpdir(), "codar-ul-v1-"));
  const dbPath = join(root, "usage.sqlite");
  try {
    // Hand-build the v1 (nullable) shape exactly as the first migration left it.
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`CREATE TABLE usage (
      hour TEXT NOT NULL, bot_id TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL,
      input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
      cache_write_1h INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0,
      room_id TEXT,
      PRIMARY KEY (hour, bot_id, model, kind, room_id))`);
    raw.prepare("INSERT INTO usage (hour, bot_id, model, kind, input) VALUES ('2026-11-06T09','b','m','chat',7)").run();
    // Collision shape (R4 teeth): NULL-PK quirk allows MULTIPLE NULL rows
    // in one bucket — the raw INSERT path pre-fix crashed on UNIQUE here.
    raw.prepare("INSERT INTO usage (hour, bot_id, model, kind, input, room_id) VALUES ('2026-11-06T09','b','m','chat',5,NULL)").run();
    raw.prepare("INSERT INTO usage (hour, bot_id, model, kind, input, room_id) VALUES ('2026-11-06T09','b','m','chat',3,'')").run();
    raw.close();
    // Opening with UsageLedger must rebuild to NOT NULL '' and fold the NULL row in.
    const ledger = new UsageLedger(dbPath);
    const cols = (ledger as unknown as { db: { prepare(q: string): { all(): Array<Record<string, number | string>> } } })
      .db.prepare("PRAGMA table_info(usage)").all();
    const roomCol = cols.find((c) => c.name === "room_id");
    assert.ok(roomCol !== undefined, "room_id column exists");
    assert.equal(Number(roomCol!.notnull), 1, "room_id is NOT NULL (the re-migration actually ran)");
    const nullRows = (ledger as unknown as { db: { prepare(q: string): { get(): unknown } } })
      .db.prepare("SELECT COUNT(*) AS n FROM usage WHERE room_id IS NULL").get();
    assert.equal(Number((nullRows as { n: number }).n), 0, "no NULL room_id rows survive");
    const rawRows = (ledger as unknown as { db: { prepare(q: string): { get(): unknown } } })
      .db.prepare("SELECT COUNT(*) AS n FROM usage").get();
    assert.equal(Number((rawRows as { n: number }).n), 1, "one bucket row (merged, not duplicated)");
    assert.equal(ledger.totals({ botId: "b" })[0]!.input, 15, "NULL and '' rows fold into one bucket (7+5+3)");
    // New unattributed writes MERGE with the migrated NULL row (both in '').
    ledger.record({ hour: "2026-11-06T09", botId: "b", model: "m", kind: "chat", input: 3, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costMicros: 0, roomId: null });
    assert.equal(ledger.totals({ botId: "b" })[0]!.input, 18, "NULL-legacy and ''-new rows share one bucket");
    ledger.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dogfood D3 R3: a v0 ledger (no room_id column) migrates without crashing and keeps data", async () => {
  const root = mkdtempSync(join(tmpdir(), "codar-ul-v0-"));
  const dbPath = join(root, "usage.sqlite");
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`CREATE TABLE usage (
      hour TEXT NOT NULL, bot_id TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL,
      input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
      cache_write_1h INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (hour, bot_id, model, kind))`);
    raw.prepare("INSERT INTO usage (hour, bot_id, model, kind, input) VALUES ('2026-11-06T09','b','m','chat',42)").run();
    raw.close();
    // v0 COALESCE regression: the SELECT referenced room_id on a table that
    // lacks the column — constructor threw, half-migrated state, second
    // open silently emptied the ledger (R3 P2).
    const ledger = new UsageLedger(dbPath);
    assert.equal(ledger.totals({ botId: "b" })[0]!.input, 42, "v0 data survives");
    ledger.record({ hour: "2026-11-06T09", botId: "b", model: "m", kind: "chat", input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costMicros: 0, roomId: null });
    assert.equal(ledger.totals({ botId: "b" })[0]!.input, 43, "merges into the sentinel bucket");
    ledger.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

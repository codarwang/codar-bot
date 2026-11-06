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

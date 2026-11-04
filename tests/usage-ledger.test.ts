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

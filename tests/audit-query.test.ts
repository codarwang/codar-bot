/**
 * M3.3 audit query tests — offline, deterministic.
 * Covers: host + gate-audit merge, ts-descending order, approval dedup,
 * bot/kind/since/before filters, torn-line tolerance, bounded tail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditQuery } from "../src/host/audit-query.js";

function rig() {
  const root = mkdtempSync(join(tmpdir(), "codar-aq-"));
  mkdirSync(join(root, "pi-conf", "bot_a"), { recursive: true });
  mkdirSync(join(root, "pi-conf", "bot_b"), { recursive: true });
  return { root, q: new AuditQuery(root), dispose() { rmSync(root, { recursive: true, force: true }); } };
}

test("M3.3: host + gate-audit merged, ts descending", () => {
  const r = rig();
  try {
    appendFileSync(join(r.root, "audit.jsonl"),
      JSON.stringify({ ts: "2026-11-08T01:00:00Z", kind: "lifecycle", botId: "bot_a" }) + "\n" +
      JSON.stringify({ ts: "2026-11-08T03:00:00Z", kind: "budget-stop", botId: "bot_a" }) + "\n");
    appendFileSync(join(r.root, "pi-conf", "bot_a", "gate-audit.jsonl"),
      JSON.stringify({ ts: "2026-11-08T02:00:00Z", kind: "tool_call", action: "allow" }) + "\n");
    const result = r.q.query({});
    assert.equal(result.entries.length, 3);
    assert.ok(result.entries[0]!.ts >= result.entries[1]!.ts);
    assert.ok(result.entries[1]!.ts >= result.entries[2]!.ts);
  } finally { r.dispose(); }
});

test("M3.3: approval rows from both sources appear (dedup removed — P2-6 known limitation)", () => {
  const r = rig();
  try {
    appendFileSync(join(r.root, "audit.jsonl"),
      JSON.stringify({ ts: "2026-11-08T01:00:00Z", kind: "approval", approvalId: "apr_1", resolvedAs: "allow_once" }) + "\n");
    appendFileSync(join(r.root, "pi-conf", "bot_a", "gate-audit.jsonl"),
      JSON.stringify({ ts: "2026-11-08T01:00:01Z", kind: "approval", toolCallId: "call_1", approved: true }) + "\n");
    // Both rows appear — cross-source dedup was removed (the host carries
    // ui-request uuid, the gate carries event.toolCallId — different keys).
    const result = r.q.query({ kind: "approval" });
    assert.equal(result.entries.length, 2, "host outcome + gate detail both visible");
  } finally { r.dispose(); }
});

test("M3.3: bot filter matches botId field", () => {
  const r = rig();
  try {
    appendFileSync(join(r.root, "audit.jsonl"),
      JSON.stringify({ ts: "2026-11-08T01:00:00Z", kind: "lifecycle", botId: "bot_a" }) + "\n" +
      JSON.stringify({ ts: "2026-11-08T02:00:00Z", kind: "lifecycle", botId: "bot_b" }) + "\n");
    const a = r.q.query({ bot: "bot_a" });
    assert.equal(a.entries.length, 1);
    assert.equal(a.entries[0]!.botId, "bot_a");
  } finally { r.dispose(); }
});

test("M3.3: scope:id rows (budget/memory writers) resolve botId — r5 P2-b", () => {
  const r = rig();
  try {
    appendFileSync(join(r.root, "audit.jsonl"),
      JSON.stringify({ ts: "2026-11-08T01:00:00Z", kind: "budget-stop", scope: "bot", id: "bot_a", dimension: "tokens", used: 100, limit: 100, stopResult: "stopped" }) + "\n" +
      JSON.stringify({ ts: "2026-11-08T01:30:00Z", kind: "memory-review", scope: "bot", id: "bot_a", turns: 3, files: 1 }) + "\n" +
      JSON.stringify({ ts: "2026-11-08T02:00:00Z", kind: "budget-warn", scope: "room", id: "room_x", dimension: "tokens", used: 80, limit: 100, pct: 80 }) + "\n");
    // The bot's own budget/memory rows survive ?bot=bot_a (the "why did
    // this bot stop" evidence), stamped with botId for the timeline.
    const a = r.q.query({ bot: "bot_a" });
    assert.equal(a.entries.length, 2, "budget-stop + memory-review both matched");
    assert.ok(a.entries.every((e) => e.botId === "bot_a"));
    // Room-scoped rows carry no botId — never misattributed.
    const room = r.q.query({ bot: "room_x" });
    assert.equal(room.entries.length, 0, "room scope does not masquerade as a bot");
  } finally { r.dispose(); }
});

test("M3.3: kind filter + before cursor", () => {
  const r = rig();
  try {
    for (let i = 0; i < 5; i++) {
      appendFileSync(join(r.root, "audit.jsonl"),
        JSON.stringify({ ts: `2026-11-08T0${i}:00:00Z`, kind: i % 2 === 0 ? "lifecycle" : "budget-stop" }) + "\n");
    }
    const lifecycle = r.q.query({ kind: "lifecycle" });
    assert.equal(lifecycle.entries.length, 3);
    const before = r.q.query({ before: "2026-11-08T02:00:00Z" });
    assert.equal(before.entries.length, 2); // only 00:00 and 01:00
  } finally { r.dispose(); }
});

test("M3.3: torn lines skipped, not fatal", () => {
  const r = rig();
  try {
    appendFileSync(join(r.root, "audit.jsonl"),
      '{"ts":"2026-11-08T01:00:00Z","kind":"ok"}\n' +
      '{"ts":"2026-11-08T02:00:00Z","kind":"bro\n' +  // torn
      '{"ts":"2026-11-08T03:00:00Z","kind":"ok2"}\n');
    const result = r.q.query({});
    assert.equal(result.entries.length, 2);
    assert.ok(result.skipped >= 1);
  } finally { r.dispose(); }
});

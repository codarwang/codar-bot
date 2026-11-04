/**
 * codar-gate audit module unit tests — offline, deterministic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIT_LINE_MAX,
  createAuditSink,
  formatAuditLine,
  projectUsage,
  summarizeInput,
  toolCallEntry,
} from "../extensions/codar-gate/audit.js";

test("summarizeInput bounds and degrades", () => {
  assert.equal(summarizeInput({ a: 1 }), '{"a":1}');
  const long = "x".repeat(600);
  const summary = summarizeInput({ long });
  assert.ok(summary.length < 600);
  assert.ok(summary.includes("[truncated"));
  // Unserializable input degrades to a marker instead of throwing.
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  assert.equal(summarizeInput(circular), "[unserializable-input]");
});

test("projectUsage whitelists numeric fields and keeps 1.5.0 additions", () => {
  const projected = projectUsage({
    input: 10,
    output: 20,
    cacheRead: 5,
    cacheWrite: 7,
    cacheWrite1h: 3,
    totalTokens: 42,
    reasoning: 11,
    evilExtra: "should be dropped",
    cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.7, total: 4.2, totalFromProvider: true },
  });
  assert.ok(projected);
  assert.equal(projected.input, 10);
  assert.equal(projected.cacheWrite1h, 3);
  assert.equal(projected.reasoning, 11);
  assert.equal(projected.cost.total, 4.2);
  assert.equal(projected.cost.totalFromProvider, true);
  assert.ok(!("evilExtra" in projected));
});

test("projectUsage returns undefined for empty/zero payloads", () => {
  assert.equal(projectUsage(undefined), undefined);
  assert.equal(projectUsage(null), undefined);
  assert.equal(projectUsage({}), undefined);
  assert.equal(projectUsage({ input: 0, output: 0, cost: {} }), undefined);
});

test("formatAuditLine replaces oversized lines with a parseable truncation marker", () => {
  // toolCallEntry's constructors bound every field, so the cap is exercised
  // directly with a hand-built oversized entry (defense-in-depth path).
  const huge = {
    kind: "tool_call",
    ts: "t",
    toolCallId: "c".repeat(AUDIT_LINE_MAX * 2),
    toolName: "write",
    inputSummary: "x",
    action: "gate",
    ruleId: "r",
  } as Parameters<typeof formatAuditLine>[0];
  const line = formatAuditLine(huge);
  assert.ok(line.length <= 512, "oversized lines must be replaced by a short marker");
  const parsed = JSON.parse(line.trim()) as { truncated?: boolean; originalBytes?: number };
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.originalBytes! > AUDIT_LINE_MAX);
});

test("sink appends parseable JSONL lines and propagates write failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "codar-audit-test-"));
  try {
    const sink = createAuditSink(join(dir, "audit.jsonl"));
    sink.append(toolCallEntry({ toolCallId: "c1", toolName: "read", input: {}, action: "allow", ruleId: "r1" }));
    sink.append({ kind: "approval", ts: "t", toolCallId: "c1", approved: true, waitedMs: 5 });
    const lines = readFileSync(sink.path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]!).kind, "tool_call");
    assert.equal(JSON.parse(lines[1]!).kind, "approval");
    // Fail-closed: a sink into a missing directory MUST throw (callers block).
    const bad = createAuditSink(join(dir, "no-such-dir", "audit.jsonl"));
    assert.throws(() => bad.append({ kind: "approval", ts: "t", toolCallId: "x", approved: false, waitedMs: 0 }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

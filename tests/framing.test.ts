/**
 * LineFramer unit tests — offline, deterministic. The U+2028/U+2029 cases are
 * the WorkerOS lesson pinned as a regression anchor: those code points are
 * valid inside JSON strings, and readline-style splitting corrupts them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LineFramer, LINE_MAX_BYTES } from "../src/driver/rpc-client.js";

test("splits complete lines on LF and keeps the remainder buffered", () => {
  const f = new LineFramer();
  const out = f.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":', "utf8"));
  assert.equal(out.length, 2);
  assert.equal(out[0]!.toString("utf8"), '{"a":1}');
  assert.equal(out[1]!.toString("utf8"), '{"b":2}');
  assert.equal(f.pending, '{"c":'.length);
  const more = f.push(Buffer.from('3}\n', "utf8"));
  assert.equal(more.length, 1);
  assert.equal(more[0]!.toString("utf8"), '{"c":3}');
});

test("U+2028/U+2029 inside a JSON string do NOT split the line", () => {
  const payload = { text: "linesephere" }; // U+2028, U+2029 embedded
  const line = JSON.stringify(payload);
  const f = new LineFramer();
  const out = f.push(Buffer.from(line, "utf8"));
  // The whole record is still unterminated — nothing emitted, all buffered.
  assert.equal(out.length, 0);
  const done = f.push(Buffer.from("\n", "utf8"));
  assert.equal(done.length, 1);
  assert.deepEqual(JSON.parse(done[0]!.toString("utf8")), payload);
});

test("empty lines are dropped; CRLF keeps the CR (JSON.parse tolerates trailing CR)", () => {
  const f = new LineFramer();
  const out = f.push(Buffer.from("\n\n{\"a\":1}\r\n", "utf8"));
  // Two bare LFs produce empty lines (dropped); the record survives with a
  // trailing CR, which JSON.parse accepts.
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]!.toString("utf8")).a, 1);
});

test("oversized line throws (bounded everything)", () => {
  const f = new LineFramer();
  const big = Buffer.alloc(LINE_MAX_BYTES + 1, 0x61);
  assert.throws(() => f.push(Buffer.concat([big, Buffer.from("\n")])), /LINE_MAX_BYTES/);
});

test("chunk boundaries mid-multibyte-UTF8 do not corrupt framing", () => {
  // 中文 across chunk boundary: 0x0A never appears inside the UTF-8 bytes,
  // and the framer is byte-level so this is safe by construction — pin it.
  const text = JSON.stringify({ msg: "中文内容" });
  const raw = Buffer.from(text + "\n", "utf8");
  const split = Math.floor(raw.length / 2);
  const f = new LineFramer();
  assert.equal(f.push(raw.subarray(0, split)).length, 0);
  const out = f.push(raw.subarray(split));
  assert.equal(out.length, 1);
  assert.deepEqual(JSON.parse(out[0]!.toString("utf8")), { msg: "中文内容" });
});

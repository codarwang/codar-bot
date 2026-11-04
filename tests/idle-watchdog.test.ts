/**
 * Idle-watchdog park interaction tests — offline, deterministic.
 *
 * Round-2 review caught the ordering bug: a ui_request's own arrival armed
 * the idle timer BEFORE the park was tracked, so a silent approval park
 * longer than idleTimeoutMs still killed the child. Round-3 added the
 * park-GC contract (child-side silent un-park via dialog timeout). These
 * tests pin the state machine via internal access (TS-private, runtime-visible).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcClient } from "../src/driver/rpc-client.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Internals {
  idleTimer: NodeJS.Timeout | null;
  openUiRequests: Set<string>;
  parkTimers: Map<string, NodeJS.Timeout>;
  armIdle(): void;
  trackPark(id: string, timeoutMs?: number): void;
  idleDeadline: boolean;
  dying: boolean;
}

function clientWith(idleTimeoutMs = 50): { client: RpcClient; internals: Internals } {
  const client = new RpcClient({ idleTimeoutMs });
  // Swallow late 'error' emits (an armed timer firing after the test ends
  // would otherwise surface as an uncaughtException).
  client.on("error", () => {});
  return { client, internals: client as unknown as Internals };
}

function disarm(i: Internals): void {
  if (i.idleTimer) clearTimeout(i.idleTimer);
  i.idleTimer = null;
  for (const t of i.parkTimers.values()) clearTimeout(t);
  i.parkTimers.clear();
}

test("idle timer arms when idle and is unarmed while a reply-pending ui request is open", () => {
  const { internals } = clientWith();
  internals.armIdle();
  assert.ok(internals.idleTimer !== null, "idle state arms the watchdog");

  internals.trackPark("req-1");
  internals.armIdle();
  assert.equal(internals.idleTimer, null, "parked state disarms (and clears) the watchdog");

  // Any further record during the park keeps it disarmed.
  internals.armIdle();
  assert.equal(internals.idleTimer, null);

  // After the last reply the watchdog re-arms fresh.
  internals.openUiRequests.delete("req-1");
  internals.armIdle();
  assert.ok(internals.idleTimer !== null, "unparking re-arms the watchdog");
  disarm(internals);
});

test("a stale timer armed before the park is cleared when the park begins", async () => {
  const { internals } = clientWith(50);
  internals.armIdle();
  internals.trackPark("req-2");
  internals.armIdle(); // this is the ui_request's own tracking pass
  assert.equal(internals.idleTimer, null, "stale timer cleared on park");
  await new Promise((resolve) => setTimeout(resolve, 90)); // > idleTimeoutMs
  assert.equal(internals.idleDeadline, false, "no idle deadline while parked (the round-2 bug)");
  internals.openUiRequests.delete("req-2");
  disarm(internals);
});

test("park GC: a child-advertised dialog timeout re-opens the watchdog after the deadline", async () => {
  // Long idle window so the re-armed watchdog is still PENDING at assertion
  // time (with the default 50ms it would legitimately fire first).
  const { internals } = clientWith(5_000);
  internals.armIdle();
  internals.trackPark("req-3", 60); // child says it will auto-resolve at 60ms
  internals.armIdle();
  assert.equal(internals.idleTimer, null, "parked: watchdog suspended");
  await new Promise((resolve) => setTimeout(resolve, 130)); // < 60ms + 1s grace
  assert.equal(internals.idleTimer, null, "within grace: still parked");
  await new Promise((resolve) => setTimeout(resolve, 1_100)); // past grace
  assert.equal(internals.openUiRequests.has("req-3"), false, "park GC removed the id");
  assert.ok(internals.idleTimer !== null, "watchdog re-armed after silent child-side un-park");
  disarm(internals);
});

test("dying/exited states refuse to re-arm", () => {
  const { internals } = clientWith();
  internals.dying = true;
  internals.armIdle();
  assert.equal(internals.idleTimer, null, "dying client never arms the idle watchdog");
});

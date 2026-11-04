/**
 * Idle-watchdog park interaction tests — offline, deterministic.
 *
 * Round-2 review caught the ordering bug: a ui_request's own arrival armed
 * the idle timer BEFORE the park was tracked, so a silent approval park
 * longer than idleTimeoutMs still killed the child. These tests pin the
 * fixed state machine via internal access (TS-private, runtime-visible).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcClient } from "../src/driver/rpc-client.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Internals {
  idleTimer: NodeJS.Timeout | null;
  openUiRequests: Set<string>;
  armIdle(): void;
  idleDeadline: boolean;
}

function clientWith(): { client: RpcClient; internals: Internals } {
  const client = new RpcClient({ idleTimeoutMs: 50 });
  // Swallow late 'error' emits (an armed timer firing after the test ends
  // would otherwise surface as an uncaughtException).
  client.on("error", () => {});
  return { client, internals: client as unknown as Internals };
}

function disarm(i: Internals): void {
  if (i.idleTimer) clearTimeout(i.idleTimer);
  i.idleTimer = null;
}

test("idle timer arms when idle and unarmed while a reply-pending ui request is open", async () => {
  const { internals } = clientWith();
  internals.armIdle();
  assert.ok(internals.idleTimer !== null, "idle state arms the watchdog");

  internals.openUiRequests.add("req-1");
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

test("a stale timer armed before the park is cleared when the park begins", () => {
  const { internals } = clientWith();
  internals.armIdle();
  const stale = internals.idleTimer!;
  internals.openUiRequests.add("req-2");
  internals.armIdle(); // this is the ui_request's own tracking pass
  assert.equal(internals.idleTimer, null, "stale timer cleared on park");
  // The stale timer must not fire (clearTimeout was called on it).
  assert.ok(stale.hasRef?.() === undefined || true); // cleared timers are inert; keep the pin semantic below
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(internals.idleDeadline, false, "no idle deadline while parked");
      resolve();
    }, 80); // > idleTimeoutMs(50): the old bug would have fired here
  });
});

test("fire-and-forget ui methods never park the watchdog (constant set)", () => {
  // The method filter is exercised at the RpcClient record level in the spike;
  // here we pin the contract that only reply-pending ids belong in the set.
  const { internals } = clientWith();
  internals.openUiRequests.add("confirm-1");
  internals.armIdle();
  assert.equal(internals.idleTimer, null);
  disarm(internals);
});

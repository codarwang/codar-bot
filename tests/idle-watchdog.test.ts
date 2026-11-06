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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
import assert from "node:assert/strict";
import { RpcClient } from "../src/driver/rpc-client.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Internals {
  idleTimer: NodeJS.Timeout | null;
  openUiRequests: Set<string>;
  parkTimers: Map<string, NodeJS.Timeout>;
  /** Work-guard state (dogfood QA ISSUE-003): outstanding commands. */
  pending: Map<string, { command: string; resolve: (r: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>;
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

test("idle timer is a WORK guard: disarmed with no outstanding work, armed under pending commands or parks (dogfood QA ISSUE-003)", () => {
  const { internals } = clientWith();
  // Healthy idle bot: no pending commands, no parks — the OLD semantics
  // armed here and crash-looped every idle bot every idleTimeoutMs (38
  // crash events in one dogfood day).
  internals.armIdle();
  assert.equal(internals.idleTimer, null, "idle state does NOT arm the watchdog");

  // Outstanding work arms it.
  internals.pending.set("cmd-1", { command: "prompt", resolve: () => undefined, reject: () => undefined, timer: setTimeout(() => undefined, 60_000) });
  internals.armIdle();
  assert.ok(internals.idleTimer !== null, "pending command arms the watchdog");

  // A park suspends it again (human-scale wait by design).
  internals.trackPark("req-1");
  internals.armIdle();
  assert.equal(internals.idleTimer, null, "parked state disarms (and clears) the watchdog");

  // Any further record during the park keeps it disarmed.
  internals.armIdle();
  assert.equal(internals.idleTimer, null);

  // After the last reply, the still-pending command re-arms it fresh.
  internals.openUiRequests.delete("req-1");
  internals.armIdle();
  assert.ok(internals.idleTimer !== null, "unparking re-arms while work is outstanding");

  // Work drains — disarmed again.
  internals.pending.delete("cmd-1");
  internals.armIdle();
  assert.equal(internals.idleTimer, null, "no outstanding work disarms the watchdog");
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

test("park GC: a child-advertised dialog timeout re-opens the watchdog after the deadline (while work is outstanding)", async () => {
  // Long idle window so the re-armed watchdog is still PENDING at assertion
  // time (with the default 50ms it would legitimately fire first).
  const { internals } = clientWith(5_000);
  // Work-guard semantics: the GC re-arm only matters when the parked
  // command is still outstanding (dogfood QA ISSUE-003) — an idle client
  // stays disarmed even after a stale park GCs.
  internals.pending.set("cmd-2", { command: "prompt", resolve: () => undefined, reject: () => undefined, timer: setTimeout(() => undefined, 60_000) });
  internals.armIdle();
  internals.trackPark("req-3", 60); // child says it will auto-resolve at 60ms
  internals.armIdle();
  assert.equal(internals.idleTimer, null, "parked: watchdog suspended");
  await new Promise((resolve) => setTimeout(resolve, 130)); // < 60ms + 1s grace
  assert.equal(internals.idleTimer, null, "within grace: still parked");
  await new Promise((resolve) => setTimeout(resolve, 1_100)); // past grace
  assert.equal(internals.openUiRequests.has("req-3"), false, "park GC removed the id");
  assert.ok(internals.idleTimer !== null, "watchdog re-armed after silent child-side un-park (work outstanding)");
  internals.pending.delete("cmd-2");
  internals.armIdle();
  assert.equal(internals.idleTimer, null, "work drained: disarmed again");
  disarm(internals);
});

test("dying/exited states refuse to re-arm", () => {
  const { internals } = clientWith();
  internals.dying = true;
  internals.armIdle();
  assert.equal(internals.idleTimer, null, "dying client never arms the idle watchdog");
});

test("dogfood QA ISSUE-003 regression: a healthy IDLE bot does not crash-loop on the idle watchdog", async () => {
  // Real child, shrunk watchdog: 1200ms. Old semantics killed the bot
  // ~1.2s after startup with zero outstanding work (38 crashes/day live).
  const { RpcClient } = await import("../src/driver/rpc-client.js");
  const client = new RpcClient({
    bin: process.execPath,
    argvPrefix: [resolve(HERE, "fixtures/fake-pi.mjs")],
    cwd: HERE,
    env: {},
    idleTimeoutMs: 1200,
    wallTimeoutMs: 60_000,
  });
  const errors: string[] = [];
  client.on("error", (e: Error) => errors.push(String(e)));
  await client.start({ model: "fake/f", thinking: "low", noSession: true });
  // Wait THREE watchdog windows with the bot idle.
  await new Promise((resolve) => setTimeout(resolve, 3800));
  const alive = client.pid !== undefined;
  client.kill();
  assert.equal(alive, true, "idle bot survives multiple watchdog windows");
  assert.equal(errors.length, 0, "no idle-timeout error while idle");
  // Contrast: a HANGING prompt (work outstanding, no records) must still
  // be cut by the watchdog — the guard is against idle silence, not stuck work.
  const c2 = new RpcClient({
    bin: process.execPath,
    argvPrefix: [resolve(HERE, "fixtures/fake-pi.mjs")],
    cwd: HERE,
    env: {},
    idleTimeoutMs: 800,
    wallTimeoutMs: 60_000,
  });
  let cut = false;
  c2.on("error", () => { cut = true; });
  await c2.start({ model: "fake/f", thinking: "low", noSession: true });
  void c2.prompt("please HANG forever").catch(() => "expected rejection");
  const dl = Date.now() + 5000;
  while (!cut && Date.now() < dl) await new Promise((r) => setTimeout(r, 100));
  c2.kill();
  assert.equal(cut, true, "a hanging prompt with no records IS cut by the watchdog");
});

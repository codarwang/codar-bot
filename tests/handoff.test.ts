/**
 * Handoff M2-B tests — fake-pi children, offline deterministic.
 * Covers: dispatch happy path (result→room+caller wake), request_id
 * idempotency, anti-cycle rejection, unknown/self target rejection,
 * works store lifecycle, progress events.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, defaultBudget } from "../src/host/store.js";
import { UsageLedger } from "../src/host/usage-ledger.js";
import { BotManager } from "../src/host/bot-manager.js";
import { RoomEngine } from "../src/host/room-engine.js";
import { Handoff } from "../src/host/handoff.js";
import { Budget } from "../src/host/budget.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(HERE, "fixtures/fake-pi.mjs");

async function rig() {
  const root = mkdtempSync(join(tmpdir(), "codar-ho-"));
  mkdirSync(join(root, "work"), { recursive: true });
  const store = Store.open(join(root, "state.json"), { create: true });
  const ledger = new UsageLedger(join(root, "usage.sqlite"));
  const bots = new BotManager(store, ledger, root, {
    bin: process.execPath, sandboxArgv: [FAKE_PI], env: {},
  });
  const chief = store.addBot({
    name: "Chief", role: "", chief: true,
    model: { provider: "fake", modelId: "f", thinkingLevel: "low" },
    workDir: join(root, "work"), sessionPath: null,
    sandbox: { mode: "host-not-isolated" }, budget: defaultBudget(),
  });
  const writer = store.addBot({
    name: "Writer", role: "", chief: false,
    model: { provider: "fake", modelId: "f", thinkingLevel: "low" },
    workDir: join(root, "work"), sessionPath: null,
    sandbox: { mode: "host-not-isolated" }, budget: defaultBudget(),
  });
  const room = store.addRoom({
    name: "default", members: [chief.id, writer.id], admin: chief.id,
    mode: "admin-reply", sharedDir: join(root, "s"), budget: defaultBudget(), goal: null,
  });
  const rooms = new RoomEngine(store, bots, join(root, "rooms"));
  const handoff = new Handoff(store, bots, rooms);
  bots.handoff = handoff;
  return {
    root, store, ledger, bots, rooms, handoff,
    chiefId: chief.id, writerId: writer.id, roomId: room.id,
    async dispose() {
      await bots.stopAll(); ledger.close(); store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("dispatch: work created, child runs out-of-band, result → room line + caller wake", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.chiefId);
    await r.bots.start(r.writerId);

    const progress: string[] = [];
    r.handoff.on("progress", (e: { oneLiner: string; status: string }) =>
      progress.push(`${e.status}:${e.oneLiner}`));

    const { workId, duplicate } = await r.handoff.dispatch({
      fromBot: r.chiefId, toBot: r.writerId,
      task: "Reply with the single word ALPHA.", requestId: "req-1", roomId: r.roomId,
    });
    assert.ok(workId.startsWith("work_"));
    assert.equal(duplicate, false);

    // Out-of-band: the child turn runs async; poll works → done.
    const deadline = Date.now() + 15_000;
    while (r.handoff.work(workId)!.status !== "done" && Date.now() < deadline) {
      await new Promise((s) => setTimeout(s, 150));
    }
    assert.equal(r.handoff.work(workId)!.status, "done");

    // Result landed in the room as a bot line from the writer.
    const hist = r.rooms.history(r.roomId);
    assert.ok(hist.some((m) => m.from.kind === "bot" && m.from.id === r.writerId && m.text === "ALPHA"));
    // Caller was woken (chief got the result as a prompt — its status stays
    // busy→idle from the wake turn).
    assert.ok(progress.some((p) => p.startsWith("working:")));
    assert.ok(progress.some((p) => p.startsWith("done:")));
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("request_id idempotency: same key = same work, no re-run", async () => {
  const r = await rig();
  try {
    const a = await r.handoff.dispatch({
      fromBot: r.chiefId, toBot: r.writerId, task: "t1", requestId: "same", roomId: null,
    });
    const b = await r.handoff.dispatch({
      fromBot: r.chiefId, toBot: r.writerId, task: "t1 again", requestId: "same", roomId: null,
    });
    assert.equal(a.workId, b.workId);
    assert.equal(b.duplicate, true);
    assert.equal(r.store.state.works.length, 1);
  } finally {
    await r.dispose();
  }
});

test("anti-cycle: dispatching to a bot pending on YOUR result is rejected", async () => {
  const r = await rig();
  try {
    // r1: writer dispatches to chief (chief is working FOR writer; writer
    // waits on chief's result).
    await r.handoff.dispatch({
      fromBot: r.writerId, toBot: r.chiefId, task: "t", requestId: "r1", roomId: null,
    });
    // The child dispatching BACK to its waiting parent = the §6.2 cycle
    // case ("A 派活给 B 后 B 反过来等 A") — rejected.
    await assert.rejects(
      () => r.handoff.dispatch({ fromBot: r.chiefId, toBot: r.writerId, task: "t", requestId: "r2", roomId: null }),
      /cycle/
    );
    // A THIRD bot's unrelated dispatch, and the parent dispatching again to a
    // DIFFERENT child, are both fine (no wait-cycle).
    const ok = await r.handoff.dispatch({
      fromBot: r.writerId, toBot: r.chiefId, task: "t2", requestId: "r3", roomId: null,
    });
    assert.ok(ok.workId.startsWith("work_"));
  } finally {
    await r.dispose();
  }
});

test("rejections: unknown target and self-dispatch throw honest errors", async () => {
  const r = await rig();
  try {
    await assert.rejects(
      () => r.handoff.dispatch({ fromBot: r.chiefId, toBot: "bot_none", task: "t", requestId: "x1", roomId: null }),
      /unknown bot/
    );
    await assert.rejects(
      () => r.handoff.dispatch({ fromBot: r.chiefId, toBot: r.chiefId, task: "t", requestId: "x2", roomId: null }),
      /yourself/
    );
  } finally {
    await r.dispose();
  }
});

test("bridge e2e: a DISPATCH turn from chief drives Handoff through the ui bridge", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.chiefId);
    await r.bots.start(r.writerId);
    // Chief's DISPATCH turn → gate parks message_bot on the bridge →
    // BotManager routes to handoff.dispatch → tool result accepted.
    const reply = await r.bots.prompt(r.chiefId, "please DISPATCH the weekly report to Writer");
    assert.equal(reply, "DISPATCHED:ok");
    // A work for chief→writer now exists.
    const w = r.store.state.works.find((x) => x.parent === r.chiefId && x.child === r.writerId);
    assert.ok(w !== undefined, "work created via the bridge");
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("multi-room: a DISPATCH prompted from room B routes its work back to room B, not rooms.find()'s first hit", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    // Chief (and Writer) are members of TWO rooms; rig's "default" is the
    // first in state — roomOf()'s find() would always land there.
    const studio = r.store.addRoom({
      name: "studio", members: [r.chiefId, r.writerId], admin: r.chiefId,
    } as Parameters<Store["addRoom"]>[0]);
    await r.bots.start(r.chiefId);
    await r.bots.start(r.writerId);
    // Prompt Chief WITH the studio context (what RoomEngine does on a turn).
    const reply = await r.bots.prompt(r.chiefId, "please DISPATCH the weekly report to Writer", "chat", studio.id);
    assert.equal(reply, "DISPATCHED:ok");
    const w = r.store.state.works.find((x) => x.parent === r.chiefId && x.child === r.writerId);
    assert.ok(w !== undefined, "work created via the bridge");
    assert.equal(w!.roomId, studio.id, "dispatch context room wins over rooms.find() first hit");
    // Drain the out-of-band work before dispose.
    const deadline = Date.now() + 20_000;
    while (r.handoff.work(w!.id)!.status !== "done" && Date.now() < deadline) {
      await new Promise((s) => setTimeout(s, 150));
    }
    assert.equal(r.handoff.work(w!.id)!.status, "done");
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("M2-B R1: busy-child dispatch retries on idle (no starvation); different calls = different works", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.chiefId);
    await r.bots.start(r.writerId);
    // Occupy the writer with a slow room turn…
    const slowTurn = r.rooms.userSay(r.roomId, "@Writer take it SLOW");
    await new Promise((s) => setTimeout(s, 150)); // writer now "working"
    // …then dispatch to it — the work queues as pending.
    const { workId } = await r.handoff.dispatch({
      fromBot: r.chiefId, toBot: r.writerId,
      task: "Reply with the single word ALPHA.", requestId: "retry-1", roomId: null,
    });
    await new Promise((s) => setTimeout(s, 100));
    assert.equal(r.handoff.work(workId)!.status, "pending", "queued while busy");
    await slowTurn; // writer settles → goes idle → the pending work auto-retries
    const deadline = Date.now() + 15_000;
    while (r.handoff.work(workId)!.status !== "done" && Date.now() < deadline) {
      await new Promise((s) => setTimeout(s, 150));
    }
    assert.equal(r.handoff.work(workId)!.status, "done", "retried on idle — no starvation");

    // Two identical tasks under DIFFERENT keys = two distinct works.
    const a = await r.handoff.dispatch({ fromBot: r.chiefId, toBot: r.writerId, task: "same text", requestId: "k1", roomId: null });
    const b = await r.handoff.dispatch({ fromBot: r.chiefId, toBot: r.writerId, task: "same text", requestId: "k2", roomId: null });
    assert.notEqual(a.workId, b.workId);
    // Drain: out-of-band children must finish before dispose (a closed ledger
    // under a running work = suite-level unhandled rejection).
    const drain = Date.now() + 20_000;
    const pendingWorks = () => r.store.state.works.filter((w) => w.status === "pending" || w.status === "working");
    while (pendingWorks().length > 0 && Date.now() < drain) {
      await new Promise((s2) => setTimeout(s2, 150));
    }
    assert.equal(pendingWorks().length, 0, "all out-of-band works drained");
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("M2-B R1: §5.5 restart sweep — pending/working works fail on store reopen", async () => {
  const r = await rig();
  try {
    await r.handoff.dispatch({ fromBot: r.chiefId, toBot: r.writerId, task: "t", requestId: "s1", roomId: null });
    r.store.updateWork(r.store.state.works[0]!.id, { status: "working" });
    const reopened = Store.open(r.store.statePath);
    assert.equal(reopened.state.works[0]!.status, "failed", "host-restart sweep (§5.5)");
    reopened.close();
  } finally {
    await r.dispose();
  }
});

test("M2-B R2: failed work releases its request_id — a retry creates a NEW work", async () => {
  const r = await rig();
  try {
    const a = await r.handoff.dispatch({ fromBot: r.chiefId, toBot: r.writerId, task: "t", requestId: "rel-1", roomId: null });
    r.store.updateWork(a.workId, { status: "failed" });
    const b = await r.handoff.dispatch({ fromBot: r.chiefId, toBot: r.writerId, task: "retry", requestId: "rel-1", roomId: null });
    assert.notEqual(a.workId, b.workId, "terminal work must not answer duplicate-ok");
    assert.equal(b.duplicate, false);
  } finally {
    await r.dispose();
  }
});

test("M2-C R3: handoff per-task wall clock interrupts an over-running child", async () => {
  const r = await rig();
  // Wire exactly as host.ts does: the child's deadline comes from Budget.
  const budget = new Budget(r.store, r.ledger, r.bots, r.rooms, r.root);
  r.handoff.deadlineMs = (botId) => budget.wallDeadlineMs(botId);
  r.store.updateBot(r.writerId, { budget: { ...defaultBudget(), maxWallMs: 600 } });
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.chiefId);
    await r.bots.start(r.writerId);
    const t0 = Date.now();
    const { workId } = await r.handoff.dispatch({
      fromBot: r.chiefId, toBot: r.writerId,
      task: "take it SLOW", requestId: "wall-1", roomId: r.roomId,
    });
    // SLOW settles at ~1.5s; the wall clock must cut it at 600ms. Without
    // the clock the work only goes terminal after the full SLOW run.
    const deadline = Date.now() + 5_000;
    while (r.handoff.work(workId)!.status !== "failed" && Date.now() < deadline) {
      await new Promise((s2) => setTimeout(s2, 50));
    }
    assert.equal(r.handoff.work(workId)!.status, "failed", "an interrupted run is FAILED, never done");
    assert.ok(Date.now() - t0 < 1_300, "wall clock fired (well under the 1.5s SLOW run)");
    // Observable cut (§5.3 never-silent): the room records the interruption.
    assert.ok(
      r.rooms.history(r.roomId).some((m) => m.from.kind === "system" && m.text.includes("interrupted")),
      "interruption lands as a room system line"
    );
    // Interrupted before the reply existed: no late OK may land in the room.
    assert.ok(
      !r.rooms.history(r.roomId).some((m) => m.from.kind === "bot" && m.text.includes("OK")),
      "aborted child must not deliver its late reply"
    );
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("M2-C R4: interrupted handoff never delivers the child's PREVIOUS answer as its result", async () => {
  const r = await rig();
  const budget = new Budget(r.store, r.ledger, r.bots, r.rooms, r.root);
  r.handoff.deadlineMs = (botId) => budget.wallDeadlineMs(botId);
  r.store.updateBot(r.writerId, { budget: { ...defaultBudget(), maxWallMs: 600 } });
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.chiefId);
    await r.bots.start(r.writerId);
    // Task 1 completes normally → one ALPHA line in the room.
    const first = await r.handoff.dispatch({
      fromBot: r.chiefId, toBot: r.writerId,
      task: "Reply with the single word ALPHA.", requestId: "stale-1", roomId: r.roomId,
    });
    const d1 = Date.now() + 15_000;
    while (r.handoff.work(first.workId)!.status !== "done" && Date.now() < d1) {
      await new Promise((s2) => setTimeout(s2, 100));
    }
    assert.equal(r.handoff.work(first.workId)!.status, "done");
    // Let the caller's wake turn settle so the writer's LAST text is ALPHA.
    const d2 = Date.now() + 15_000;
    while (r.bots.status(r.writerId) !== "idle" && Date.now() < d2) {
      await new Promise((s2) => setTimeout(s2, 100));
    }
    // Task 2 (SLOW) gets wall-clocked at 600ms: pi's harvest then points at
    // the PREVIOUS turn's ALPHA — the phantom the guard must refuse.
    const second = await r.handoff.dispatch({
      fromBot: r.chiefId, toBot: r.writerId,
      task: "take it SLOW", requestId: "stale-2", roomId: r.roomId,
    });
    const d3 = Date.now() + 5_000;
    while (r.handoff.work(second.workId)!.status !== "failed" && Date.now() < d3) {
      await new Promise((s2) => setTimeout(s2, 50));
    }
    assert.equal(r.handoff.work(second.workId)!.status, "failed", "interrupted task must fail");
    const alphaLines = r.rooms.history(r.roomId)
      .filter((m) => m.from.kind === "bot" && m.from.id === r.writerId && m.text === "ALPHA");
    assert.equal(alphaLines.length, 1, "the stale ALPHA must NOT be delivered a second time");
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("M2-C R4: dispatch into a budget-paused room's member is rejected honestly", async () => {
  const r = await rig();
  try {
    // Budget-pause the room (reason "budget", the §5.3 gate reads it).
    r.rooms.pause(r.roomId, "budget", "test pause");
    await assert.rejects(
      () => r.handoff.dispatch({
        fromBot: r.chiefId, toBot: r.writerId, task: "t", requestId: "gate-1", roomId: r.roomId,
      }),
      /budget-paused/
    );
    assert.equal(r.store.state.works.length, 0, "no work record for a refused dispatch");
  } finally {
    await r.dispose();
  }
});

test("M2-C R5: budget gates run the stale-pause test — a next-month pause lifts instead of refusing", async () => {
  const r = await rig();
  const budget = new Budget(r.store, r.ledger, r.bots, r.rooms, r.root);
  r.handoff.stalePauseCheck = (roomId) => budget.rolloverIfStale(roomId);
  try {
    // Budget-pause the room, backdate the stamp to last month, restart
    // (fresh Budget memory) — the gate must lift the pause, not reject.
    r.rooms.pause(r.roomId, "budget", "test pause");
    const old = new Date(Date.now() - 32 * 24 * 3600 * 1000).toISOString();
    r.store.updateRoom(r.roomId, { pausedAt: old });
    const stale = new Budget(r.store, r.ledger, r.bots, r.rooms, r.root);
    r.handoff.stalePauseCheck = (roomId) => stale.rolloverIfStale(roomId);
    const { workId } = await r.handoff.dispatch({
      fromBot: r.chiefId, toBot: r.writerId, task: "t", requestId: "stale-gate-1", roomId: r.roomId,
    });
    assert.ok(workId.startsWith("work_"), "dispatch is NOT refused — the stale pause lifted");
    assert.equal(r.store.room(r.roomId)!.status, "active");
    // The current-month control still refuses (gate is not a bypass).
    r.rooms.pause(r.roomId, "budget", "pause again");
    await assert.rejects(
      () => r.handoff.dispatch({
        fromBot: r.chiefId, toBot: r.writerId, task: "t", requestId: "stale-gate-2", roomId: r.roomId,
      }),
      /budget-paused/
    );
  } finally {
    await r.dispose();
  }
});

test("M2-C R5: cross-room run-side gate notifies the REQUESTER's room, not just the child's", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    // A second room holding ONLY the writer; the default room keeps only
    // the chief — a true cross-room dispatch (chief@A → writer@B).
    r.store.updateRoom(r.roomId, { members: [r.chiefId] });
    const roomB = r.store.addRoom({
      name: "b", members: [r.writerId], admin: r.writerId,
      mode: "admin-reply", sharedDir: join(r.root, "s2"), budget: defaultBudget(), goal: null,
    });
    await r.bots.start(r.writerId);
    // Occupy the writer so the dispatch queues as pending…
    const slowTurn = r.rooms.userSay(roomB.id, "@Writer take it SLOW");
    await new Promise((s2) => setTimeout(s2, 150));
    const { workId } = await r.handoff.dispatch({
      fromBot: r.chiefId, toBot: r.writerId, task: "t", requestId: "xroom-1", roomId: r.roomId,
    });
    // …then budget-pause the CHILD's room before the writer goes idle.
    r.rooms.pause(roomB.id, "budget", "child room paused");
    await slowTurn; // writer settles → idle → runChild → run-side gate
    const d = Date.now() + 5_000;
    while (r.handoff.work(workId)!.status !== "failed" && Date.now() < d) {
      await new Promise((s2) => setTimeout(s2, 50));
    }
    assert.equal(r.handoff.work(workId)!.status, "failed", "queued work refused under the child's pause");
    // The REQUESTER's room (work.roomId) carries the notice (R5 P3-1).
    assert.ok(
      r.rooms.history(r.roomId).some((m) => m.from.kind === "system" && m.text.includes("not started")),
      "requester room notified"
    );
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("M2-C R6: run-side gate lifts a STALE pause and lets the queued work run", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    const budget = new Budget(r.store, r.ledger, r.bots, r.rooms, r.root);
    r.handoff.stalePauseCheck = (roomId) => budget.rolloverIfStale(roomId);
    await r.bots.start(r.writerId);
    // Queue the work behind a busy child…
    const slowTurn = r.rooms.userSay(r.roomId, "@Writer take it SLOW");
    await new Promise((s2) => setTimeout(s2, 150));
    const { workId } = await r.handoff.dispatch({
      fromBot: r.chiefId, toBot: r.writerId, task: "Reply with the single word ALPHA.", requestId: "lift-1", roomId: null,
    });
    assert.equal(r.handoff.work(workId)!.status, "pending", "queued while busy");
    // …then pause the room with a LAST-month stamp: on the child'"'"'s next
    // idle the run-side gate must LIFT the stale pause, not fail the work.
    r.rooms.pause(r.roomId, "budget", "stale pause");
    const old = new Date(Date.now() - 32 * 24 * 3600 * 1000).toISOString();
    r.store.updateRoom(r.roomId, { pausedAt: old });
    await slowTurn;
    const d = Date.now() + 15_000;
    while (r.handoff.work(workId)!.status !== "done" && Date.now() < d) {
      await new Promise((s2) => setTimeout(s2, 100));
    }
    assert.equal(r.handoff.work(workId)!.status, "done", "stale pause lifted — queued work ran");
    assert.equal(r.store.room(r.roomId)!.status, "active");
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("M2-C R6: multi-room member — any budget-paused member room refuses dispatch", async () => {
  const r = await rig();
  try {
    // Writer stays in the default room AND joins a second, paused room.
    const roomB = r.store.addRoom({
      name: "b", members: [r.writerId], admin: r.writerId,
      mode: "admin-reply", sharedDir: join(r.root, "s2"), budget: defaultBudget(), goal: null,
    });
    r.rooms.pause(roomB.id, "budget", "second room paused");
    await assert.rejects(
      () => r.handoff.dispatch({
        fromBot: r.chiefId, toBot: r.writerId, task: "t", requestId: "multi-1", roomId: r.roomId,
      }),
      /budget-paused/
    );
    assert.equal(r.store.state.works.length, 0, "no work record leaked");
  } finally {
    await r.dispose();
  }
});

test("M2-C R6: room-less refused work wakes the parent with the notice", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.chiefId);
    await r.bots.start(r.writerId);
    // Queue a room-less work behind a busy child, then pause before idle.
    const slowTurn = r.rooms.userSay(r.roomId, "@Writer take it SLOW");
    await new Promise((s2) => setTimeout(s2, 150));
    const { workId } = await r.handoff.dispatch({
      fromBot: r.chiefId, toBot: r.writerId, task: "t", requestId: "wake-1", roomId: null,
    });
    r.rooms.pause(r.roomId, "budget", "paused");
    await slowTurn;
    const d = Date.now() + 15_000;
    while (r.handoff.work(workId)!.status !== "failed" && Date.now() < d) {
      await new Promise((s2) => setTimeout(s2, 50));
    }
    assert.equal(r.handoff.work(workId)!.status, "failed");
    // The parent receives the refusal as a wake prompt (observable in its
    // transcript) — no silent dead-end for room-less works.
    const wDeadline = Date.now() + 15_000;
    let saw = false;
    while (!saw && Date.now() < wDeadline) {
      const msgs = await r.bots.messages(r.chiefId);
      saw = msgs.some((m) => m.role === "user" && m.text.includes("not started"));
      if (!saw) await new Promise((s2) => setTimeout(s2, 100));
    }
    assert.ok(saw, "parent woken with the budget-paused notice");
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

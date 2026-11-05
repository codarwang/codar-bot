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

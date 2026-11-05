/**
 * room-engine orchestration tests — fake-pi children, offline deterministic
 * (PRD §7). Covers the M2-A loop: userSay → responder pick → context inject
 * → bot reply appended → ping-pong pause → pause lift on user message →
 * messages.jsonl persistence + watermark incremental injection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, defaultBudget } from "../src/host/store.js";
import { UsageLedger } from "../src/host/usage-ledger.js";
import { BotManager } from "../src/host/bot-manager.js";
import { RoomEngine } from "../src/host/room-engine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(HERE, "fixtures/fake-pi.mjs");

async function rig(guards?: { pingPongN: number; replyTimeoutMs: number }) {
  const root = mkdtempSync(join(tmpdir(), "codar-room-"));
  mkdirSync(join(root, "work"), { recursive: true });
  const store = Store.open(join(root, "state.json"), { create: true });
  const ledger = new UsageLedger(join(root, "usage.sqlite"));
  const bots = new BotManager(store, ledger, root, {
    bin: process.execPath, sandboxArgv: [FAKE_PI],
    env: { FAKE_PI_SESSION_FILE: "/tmp/fs" },
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
    mode: "admin-reply", sharedDir: join(root, "shared"),
    budget: defaultBudget(), goal: null,
    ...(guards !== undefined ? { guards } : {}),
  });
  const rooms = new RoomEngine(store, bots, join(root, "rooms"));
  return {
    root, store, ledger, bots, rooms, chiefId: chief.id, writerId: writer.id, roomId: room.id,
    async dispose() {
      await bots.stopAll();
      ledger.close(); store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("userSay: admin-reply default → chief answers; reply appended; context carries the user text", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.chiefId);
    await r.bots.start(r.writerId);
    const res = await r.rooms.userSay(r.roomId, "Reply with the single word ALPHA.");
    assert.deepEqual(res.responders, [r.chiefId]);

    const hist = r.rooms.history(r.roomId);
    // user msg + bot reply (+ any system lines)
    assert.ok(hist.some((m) => m.from.kind === "user" && m.text.includes("ALPHA")));
    assert.ok(hist.some((m) => m.from.kind === "bot" && m.from.id === r.chiefId && m.text === "ALPHA"));
    // seq is monotone
    const seqs = hist.map((m) => m.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));

    // durable on disk (turn-engine is the sole writer §3)
    const onDisk = readFileSync(join(r.root, "rooms", r.roomId, "messages.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l) as { from: { kind: string } });
    assert.equal(onDisk.length, hist.length);

    // slots reflect the posted turn
    assert.equal(r.rooms.slots(r.roomId)[r.chiefId], "posted");
    assert.equal(r.rooms.slots(r.roomId)[r.writerId], "waiting");
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("userSay @mention routes to the named bot, not the admin", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.chiefId);
    await r.bots.start(r.writerId);
    const res = await r.rooms.userSay(r.roomId, "@Writer Reply with the single word BRAVO.");
    assert.deepEqual(res.responders, [r.writerId]);
    const hist = r.rooms.history(r.roomId);
    assert.ok(hist.some((m) => m.from.id === r.writerId && m.text === "BRAVO"));
    assert.ok(!hist.some((m) => m.from.id === r.chiefId && m.from.kind === "bot"));
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("ping-pong guard: N consecutive pure BOT replies (@all fan-out) pause; user message lifts", async () => {
  const r = await rig({ pingPongN: 2, replyTimeoutMs: 180_000 });
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.chiefId);
    await r.bots.start(r.writerId);

    const pauses: string[] = [];
    r.rooms.on("system", (e: { text: string }) => {
      if (e.text.includes("paused")) pauses.push(e.text);
    });

    // Two SEPARATE user messages, each with one pure reply: user participation
    // resets the counter between turns (PRD 3.3-1 targets bot-to-bot idle
    // talk, not answers to distinct user messages) — no pause.
    await r.rooms.userSay(r.roomId, "Reply with the single word ALPHA.");
    await r.rooms.userSay(r.roomId, "Reply with the single word BRAVO.");
    assert.equal(pauses.length, 0, "user-separated pure replies never accumulate");
    assert.equal(r.store.room(r.roomId)!.status, "active");

    // @all fans out to BOTH bots in one message → two consecutive pure bot
    // replies → pause at N=2 (the §3.3-1 self-talk scenario).
    const res = await r.rooms.userSay(r.roomId, "@all Reply with the single word OK.");
    assert.equal(res.responders.length, 2);
    assert.equal(pauses.length, 1, "second consecutive bot reply in the fan-out pauses");
    assert.equal(r.store.room(r.roomId)!.status, "paused");
    assert.ok(pauses[0]!.includes("waiting for you"));

    // Next user message lifts a ping-pong pause (§5.3 resume policy).
    const res2 = await r.rooms.userSay(r.roomId, "Reply with the single word ALPHA.");
    assert.deepEqual(res2.responders, [r.chiefId], "pause lifted, chief answers again");
    assert.equal(r.store.room(r.roomId)!.status, "active");
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("budget pause does NOT lift on user message (§5.3)", async () => {
  const r = await rig();
  try {
    r.rooms.pause(r.roomId, "budget", "room budget exhausted");
    assert.equal(r.store.room(r.roomId)!.status, "paused");
    await assert.rejects(
      () => r.rooms.userSay(r.roomId, "hello"),
      /budget-paused/
    );
    assert.equal(r.store.room(r.roomId)!.status, "paused");
    // Explicit resume works.
    r.rooms.resume(r.roomId, "budget adjusted");
    assert.equal(r.store.room(r.roomId)!.status, "active");
  } finally {
    await r.dispose();
  }
});

test("incremental injection: the second turn only carries NEW messages (watermark)", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.chiefId);
    await r.bots.start(r.writerId);

    const contexts: string[] = [];
    const origPrompt = r.bots.prompt.bind(r.bots);
    (r.bots as unknown as { prompt: (id: string, msg: string) => Promise<string> }).prompt =
      async (id: string, msg: string) => {
        contexts.push(msg);
        return origPrompt(id, msg);
      };

    await r.rooms.userSay(r.roomId, "Reply with the single word ALPHA.");
    await r.rooms.userSay(r.roomId, "@Writer Reply with the single word BRAVO.");

    assert.equal(contexts.length, 2);
    // First context: only the first user message.
    assert.ok(contexts[0]!.includes("ALPHA"));
    assert.ok(!contexts[0]!.includes("BRAVO"));
    // Second context (Writer): first user msg + chief's reply + second msg —
    // the second user message IS present, and prior history comes along once.
    assert.ok(contexts[1]!.includes("BRAVO"));
    assert.ok(contexts[1]!.includes("ALPHA"));
    // Header contract (§5.1a).
    assert.ok(contexts[1]!.startsWith("You are Writer in team room"));
    assert.ok(contexts[1]!.includes("Shared files live in ~/shared"));
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("history(since) filters by seq; runtime rebuilds from disk tail on second engine", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.chiefId);
    await r.rooms.userSay(r.roomId, "Reply with the single word ALPHA.");
    const all = r.rooms.history(r.roomId);
    const tail = r.rooms.history(r.roomId, all[0]!.seq);
    assert.equal(tail.length, all.length - 1);

    // A fresh engine over the same disk resumes seq without collision.
    const rooms2 = new RoomEngine(r.store, r.bots, join(r.root, "rooms"));
    await rooms2.userSay(r.roomId, "Reply with the single word BRAVO.");
    const all2 = rooms2.history(r.roomId);
    const seqs = all2.map((m) => m.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(all2[all2.length - 1]!.seq, all[all.length - 1]!.seq + 2);
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("reply timeout: no first token ⇒ slot timed-out, no ping-pong feed, watermark NOT advanced", async () => {
  const r = await rig({ pingPongN: 2, replyTimeoutMs: 400 });
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.chiefId);
    // SLOW = 1.5s silence, watchdog fires at 400ms.
    const sys: string[] = [];
    r.rooms.on("system", (e: { text: string }) => sys.push(e.text));
    const res = await r.rooms.userSay(r.roomId, "take it SLOW");
    assert.deepEqual(res.responders, [r.chiefId]);
    assert.equal(r.rooms.slots(r.roomId)[r.chiefId], "timed-out");
    assert.ok(sys.some((t) => t.includes("timed out")));
    // Timeout did NOT feed the guard.
    assert.equal(r.store.room(r.roomId)!.status, "active");
    // The timed-out turn's context WAS delivered (prompt accepted) ⇒ the
    // watermark committed, and the next turn injects ONLY the new message
    // (no duplication of the delivered SLOW context in the bot session).
    const ctxs: string[] = [];
    const orig = r.bots.prompt.bind(r.bots);
    (r.bots as unknown as { prompt: (id: string, m: string) => Promise<string> }).prompt =
      async (id: string, m: string) => { ctxs.push(m); return orig(id, m); };
    await r.rooms.userSay(r.roomId, "Reply with the single word ALPHA.");
    assert.ok(!ctxs[0]!.includes("[user] take it SLOW"), "delivered context is not re-injected");
    assert.ok(ctxs[0]!.includes("ALPHA"));
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("round-robin: consecutive userSay rotates chief→writer→chief", async () => {
  const root = mkdtempSync(join(tmpdir(), "codar-rr-"));
  mkdirSync(join(root, "work"), { recursive: true });
  const store = Store.open(join(root, "state.json"), { create: true });
  const ledger = new UsageLedger(join(root, "usage.sqlite"));
  const bots = new BotManager(store, ledger, root, {
    bin: process.execPath, sandboxArgv: [FAKE_PI], env: {},
  });
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    const a = store.addBot({ name: "Chief", role: "", chief: true, model: { provider: "fake", modelId: "f", thinkingLevel: "low" }, workDir: join(root, "work"), sessionPath: null, sandbox: { mode: "host-not-isolated" }, budget: defaultBudget() });
    const b = store.addBot({ name: "Writer", role: "", chief: false, model: { provider: "fake", modelId: "f", thinkingLevel: "low" }, workDir: join(root, "work"), sessionPath: null, sandbox: { mode: "host-not-isolated" }, budget: defaultBudget() });
    const room = store.addRoom({ name: "rr", members: [a.id, b.id], admin: a.id, mode: "round-robin", sharedDir: join(root, "s"), budget: defaultBudget(), goal: null });
    const rooms = new RoomEngine(store, bots, join(root, "rooms"));
    await bots.start(a.id); await bots.start(b.id);
    const r1 = await rooms.userSay(room.id, "Reply with the single word ALPHA.");
    const r2 = await rooms.userSay(room.id, "Reply with the single word ALPHA.");
    const r3 = await rooms.userSay(room.id, "Reply with the single word ALPHA.");
    assert.deepEqual([r1.responders, r2.responders, r3.responders], [[a.id], [b.id], [a.id]]);
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await bots.stopAll(); ledger.close(); store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent userSays serialize per room — no message loss, no slot stomp", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.chiefId);
    // Two messages racing: the queue must run them one after the other and
    // BOTH must reach the bot's context across the two turns.
    const [res1, res2] = await Promise.all([
      r.rooms.userSay(r.roomId, "take it SLOW"),           // 1.5s turn
      (async () => {
        await new Promise((s) => setTimeout(s, 50));        // lands mid-turn-1
        return r.rooms.userSay(r.roomId, "Reply with the single word BRAVO.");
      })(),
    ]);
    assert.deepEqual(res1.responders, [r.chiefId]);
    assert.deepEqual(res2.responders, [r.chiefId]);
    // The second message's context must contain BOTH user messages
    // (serialization ⇒ the 409/watermark-stomp window is gone).
    const hist = r.rooms.history(r.roomId);
    assert.ok(hist.some((m) => m.from.kind === "user" && m.text.includes("SLOW")));
    assert.ok(hist.some((m) => m.from.kind === "user" && m.text.includes("BRAVO")));
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("restart keeps a budget pause un-liftable (§5.3 / R1 P1-3)", async () => {
  const r = await rig();
  try {
    r.rooms.pause(r.roomId, "budget", "room budget exhausted");
    // Simulated restart: a fresh engine over the same store.
    const rooms2 = new RoomEngine(r.store, r.bots, join(r.root, "rooms"));
    await assert.rejects(() => rooms2.userSay(r.roomId, "hello"), /budget-paused/);
    assert.equal(r.store.room(r.roomId)!.status, "paused");
    // Ping-pong pause persists too, and a user message lifts it.
    r.rooms.resume(r.roomId, "resume");
    r.rooms.pause(r.roomId, "ping-pong", "idle talk");
    const rooms3 = new RoomEngine(r.store, r.bots, join(r.root, "rooms"));
    const res = await rooms3.userSay(r.roomId, "Reply with the single word OK.");
    assert.equal(res.responders.length, 1);
    assert.equal(r.store.room(r.roomId)!.status, "active");
  } finally {
    await r.dispose();
  }
});

/**
 * Memory M2-D tests — offline deterministic, fake-pi review child.
 * Covers: pure parse/validate, snapshot freeze bytes, reviewModel fallback,
 * ingest→review lifecycle (files/pending/ledger/reviews.log), broken/huge
 * fail-safe, team threshold, budget-paused gate, room/handoff wiring, and
 * the memory API routes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, defaultBudget } from "../src/host/store.js";
import { UsageLedger } from "../src/host/usage-ledger.js";
import { BotManager } from "../src/host/bot-manager.js";
import { RoomEngine } from "../src/host/room-engine.js";
import { Handoff } from "../src/host/handoff.js";
import { Budget } from "../src/host/budget.js";
import {
  MemoryEngine,
  parseReviewOutput,
  validateUpdate,
} from "../src/host/memory.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(HERE, "fixtures/fake-pi.mjs");

const turn = (speaker: string, text: string) => ({ ts: new Date().toISOString(), speaker, text });

/** Unit rig: store + ledger + memory only (the review child spawns its own
 *  fake-pi via the engine's spawn defaults — no BotManager involved). */
async function rig() {
  const root = mkdtempSync(join(tmpdir(), "codar-mem-"));
  mkdirSync(join(root, "work"), { recursive: true });
  const store = Store.open(join(root, "state.json"), { create: true });
  const ledger = new UsageLedger(join(root, "usage.sqlite"));
  const chief = store.addBot({
    name: "Chief", role: "", chief: true,
    model: { provider: "fake", modelId: "f", thinkingLevel: "low" },
    workDir: join(root, "work"), sessionPath: null,
    sandbox: { mode: "host-not-isolated" }, budget: defaultBudget(),
  });
  const room = store.addRoom({
    name: "default", members: [chief.id], admin: chief.id,
    mode: "admin-reply", sharedDir: join(root, "s"), budget: defaultBudget(), goal: null,
  });
  const rooms = new RoomEngine(store, new BotManager(store, ledger, root, { bin: process.execPath, sandboxArgv: [FAKE_PI], env: {} }), join(root, "rooms"));
  const memory = new MemoryEngine(store, ledger, root, { bin: process.execPath, sandboxArgv: [FAKE_PI], env: {} });
  return {
    root, store, ledger, rooms, memory, chiefId: chief.id, roomId: room.id,
    async dispose() {
      ledger.close(); store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function drain(memory: MemoryEngine, scope: "bot" | "room" | "team", id: string, ms = 10_000): Promise<number> {
  const deadline = Date.now() + ms;
  let n = memory.pendingCount(scope, id);
  while (n > 0 && Date.now() < deadline) {
    await new Promise((s) => setTimeout(s, 80));
    n = memory.pendingCount(scope, id);
  }
  return n;
}

// --- pure helpers -----------------------------------------------------------------

test("parseReviewOutput: FILE blocks, DELETE markers, dedup, END terminator", () => {
  const u = parseReviewOutput(
    "<<<FILE entry.md>>>\nabc\n<<<FILE topics/x.md>>>\nX\n<<<DELETE topics/old.md>>>\n<<<FILE main.md>>>\nM\n<<<FILE entry.md>>>\nDUP-IGNORED\n<<<END>>>\ntrailing noise"
  )!;
  assert.ok(u);
  assert.deepEqual(
    u.files.map((f) => f.path),
    ["entry.md", "topics/x.md", "main.md"]
  );
  assert.equal(u.files[0]!.content, "abc");
  assert.deepEqual(u.deletes, ["topics/old.md"]);
  assert.equal(validateUpdate(u), null);
});

test("parseReviewOutput: prose without blocks → null (unparseable)", () => {
  assert.equal(parseReviewOutput("I updated the memory, trust me."), null);
});

test("validateUpdate: 2× budget and topic-count caps reject", () => {
  const huge = parseReviewOutput(`<<<FILE entry.md>>>\n${"x".repeat(5_000)}\n<<<END>>>`)!;
  assert.match(validateUpdate(huge)!, /2x budget/);
  const many: string[] = [];
  for (let i = 0; i < 9; i++) many.push(`<<<FILE topics/t${i}.md>>>\nT`);
  const u = parseReviewOutput(`${many.join("\n")}\n<<<END>>>`)!;
  assert.match(validateUpdate(u)!, /too many topics/);
});

// --- snapshot freeze ----------------------------------------------------------------

test("snapshot: empty scope injects nothing; files are the frozen bytes", async () => {
  const r = await rig();
  try {
    assert.equal(r.memory.snapshot("bot", r.chiefId), "", "no memory yet → no injection");
    r.memory.writeFile("bot", r.chiefId, "entry.md", "Chief prefers zh.\n");
    const a = r.memory.snapshot("bot", r.chiefId);
    const b = r.memory.snapshot("bot", r.chiefId);
    assert.equal(a, b, "byte-stable between mutations (freeze)");
    assert.match(a, /### Memory — Chief/);
    assert.match(a, /Chief prefers zh\./);
    r.memory.writeFile("bot", r.chiefId, "entry.md", "Changed.\n");
    assert.notEqual(r.memory.snapshot("bot", r.chiefId), a, "a mutation unfreezes");
    assert.throws(() => r.memory.writeFile("bot", r.chiefId, "../escape.md", "x"), /invalid memory path/);
  } finally {
    await r.dispose();
  }
});

// --- reviewModel fallback --------------------------------------------------------------

test("resolveReviewModel: global slot wins; owner fallback bot/admin/chief; none → null", async () => {
  const r = await rig();
  try {
    assert.deepEqual(r.memory.resolveReviewModel("bot", r.chiefId), { provider: "fake", modelId: "f", thinkingLevel: "low" });
    assert.deepEqual(r.memory.resolveReviewModel("room", r.roomId), { provider: "fake", modelId: "f", thinkingLevel: "low" }, "room → admin's model");
    assert.deepEqual(r.memory.resolveReviewModel("team", "team"), { provider: "fake", modelId: "f", thinkingLevel: "low" }, "team → chief's model");
    r.store.setReviewModel({ provider: "zai", modelId: "glm-5.3", thinkingLevel: "high" });
    assert.deepEqual(r.memory.resolveReviewModel("bot", r.chiefId), { provider: "zai", modelId: "glm-5.3", thinkingLevel: "high" }, "D3 slot overrides");
  } finally {
    await r.dispose();
  }
});

// --- review lifecycle -------------------------------------------------------------------

test("review ok: files written, pending cleared, ledger row, reviews.log, audit", async () => {
  const r = await rig();
  try {
    r.memory.ingestTurn("bot", r.chiefId, turn("user", "请用中文回复，保持简洁"));
    r.memory.ingestTurn("bot", r.chiefId, turn("Chief", "好的，我会保持简洁。"));
    const outcome = await r.memory.review("bot", r.chiefId);
    assert.equal(outcome, "reviewed");
    const files = r.memory.files("bot", r.chiefId);
    assert.deepEqual(files.map((f) => f.path).sort(), ["entry.md", "main.md", "topics/style.md"]);
    assert.equal(r.memory.pendingCount("bot", r.chiefId), 0);
    assert.match(r.memory.snapshot("bot", r.chiefId), /concise answers/);
    // Ledger row under the SCOPE id with kind=memory-review (§4 台账).
    const rows = r.ledger.totals({ botId: r.chiefId, kind: "memory-review" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.input, 30);
    assert.equal(rows[0]!.output, 6);
    // Durable per-scope review log + audit line.
    assert.match(readFileSync(join(r.root, "memory", "bots", r.chiefId, "reviews.log"), "utf8"), /turns=2 files=3/);
    assert.match(readFileSync(join(r.root, "audit.jsonl"), "utf8"), /"kind":"memory-review"/);
  } finally {
    await r.dispose();
  }
});

test("review broken output: old files kept, pending kept, audited as rejected", async () => {
  const r = await rig();
  try {
    process.env.FAKE_PI_MEM_REVIEW = "broken";
    r.memory.writeFile("bot", r.chiefId, "entry.md", "PRECIOUS\n");
    r.memory.ingestTurn("bot", r.chiefId, turn("user", "x"));
    assert.equal(await r.memory.review("bot", r.chiefId), "rejected");
    assert.equal(r.memory.files("bot", r.chiefId)[0]!.content.trim(), "PRECIOUS");
    assert.equal(r.memory.pendingCount("bot", r.chiefId), 1, "pending survives for the next pass");
    assert.match(readFileSync(join(r.root, "audit.jsonl"), "utf8"), /memory-review-rejected/);
  } finally {
    delete process.env.FAKE_PI_MEM_REVIEW;
    await r.dispose();
  }
});

test("review huge file: hard-rejected at 2× budget, nothing written", async () => {
  const r = await rig();
  try {
    process.env.FAKE_PI_MEM_REVIEW = "huge";
    r.memory.ingestTurn("bot", r.chiefId, turn("user", "x"));
    assert.equal(await r.memory.review("bot", r.chiefId), "rejected");
    assert.equal(r.memory.files("bot", r.chiefId).length, 0);
    assert.equal(r.memory.pendingCount("bot", r.chiefId), 1);
  } finally {
    delete process.env.FAKE_PI_MEM_REVIEW;
    await r.dispose();
  }
});

// --- scheduling policy --------------------------------------------------------------------

test("team scope batches at the threshold; bot/room review per settle", async () => {
  const r = await rig();
  try {
    for (let i = 0; i < 4; i++) r.memory.ingestTurn("team", "team", turn("user", `t${i}`));
    r.memory.schedule("team", "team");
    await new Promise((s) => setTimeout(s, 300));
    assert.equal(r.memory.pendingCount("team", "team"), 4, "below threshold → no review");
    assert.ok(!existsSync(join(r.root, "memory", "team", "reviews.log")));
    r.memory.ingestTurn("team", "team", turn("user", "t4"));
    r.memory.schedule("team", "team");
    assert.equal(await drain(r.memory, "team", "team"), 0, "5th turn triggers the batch review");
  } finally {
    await r.dispose();
  }
});

test("budget-paused room does not review; resume unblocks", async () => {
  const r = await rig();
  try {
    r.rooms.pause(r.roomId, "budget", "paused for test");
    r.memory.ingestTurn("room", r.roomId, turn("user", "x"));
    r.memory.schedule("room", r.roomId);
    await new Promise((s) => setTimeout(s, 300));
    assert.equal(r.memory.pendingCount("room", r.roomId), 1, "no spend while §5.3-held");
    r.rooms.resume(r.roomId, "resumed");
    r.memory.schedule("room", r.roomId);
    assert.equal(await drain(r.memory, "room", r.roomId), 0);
  } finally {
    await r.dispose();
  }
});

// --- wiring (host-equivalent) ----------------------------------------------------------------

async function fullRig() {
  const root = mkdtempSync(join(tmpdir(), "codar-memw-"));
  mkdirSync(join(root, "work"), { recursive: true });
  const store = Store.open(join(root, "state.json"), { create: true });
  const ledger = new UsageLedger(join(root, "usage.sqlite"));
  const bots = new BotManager(store, ledger, root, { bin: process.execPath, sandboxArgv: [FAKE_PI], env: {} });
  const chief = store.addBot({
    name: "Chief", role: "", chief: true,
    model: { provider: "fake", modelId: "f", thinkingLevel: "low" },
    workDir: join(root, "work"), sessionPath: null,
    sandbox: { mode: "host-not-isolated" }, budget: defaultBudget(),
  });
  const room = store.addRoom({
    name: "default", members: [chief.id], admin: chief.id,
    mode: "admin-reply", sharedDir: join(root, "s"), budget: defaultBudget(), goal: null,
  });
  const rooms = new RoomEngine(store, bots, join(root, "rooms"));
  const handoff = new Handoff(store, bots, rooms);
  bots.handoff = handoff;
  const budget = new Budget(store, ledger, bots, rooms, root);
  const memory = new MemoryEngine(store, ledger, root, { bin: process.execPath, sandboxArgv: [FAKE_PI], env: {} });
  // host.ts 同款接线
  const memoryTurn = (roomId: string | null, botId: string, text: string): void => {
    const botName = store.bot(botId)?.name ?? botId;
    const t = { ts: new Date().toISOString(), speaker: botName, text: text.slice(0, 4_000) };
    memory.ingestTurn("bot", botId, t);
    if (roomId !== null) memory.ingestTurn("room", roomId, t);
    memory.ingestTurn("team", "team", { ...t, speaker: `default/${botName}` });
    memory.schedule("bot", botId);
    if (roomId !== null) memory.schedule("room", roomId);
    memory.schedule("team", "team");
  };
  rooms.onTurnSettled = (roomId, botId, reply) => memoryTurn(roomId, botId, reply);
  rooms.memoryTail = (botId, roomId) => {
    const parts = [memory.snapshot("bot", botId), memory.snapshot("room", roomId), memory.snapshot("team", "team")].filter((x) => x.length > 0);
    return parts.length > 0 ? parts.join("\n\n") : null;
  };
  handoff.onWorkDone = (work, result) => memoryTurn(work.roomId, work.child, `result: ${result.slice(0, 200)}`);
  handoff.memoryTail = (botId) => memory.snapshot("bot", botId) || null;
  return {
    root, store, ledger, bots, rooms, handoff, budget, memory,
    chiefId: chief.id, roomId: room.id,
    async dispose() {
      await bots.stopAll(); ledger.close(); store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("wiring: a real room turn feeds bot+room+team; review lands; next prompt carries the frozen snapshot", async () => {
  const r = await fullRig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.chiefId);
    const before = r.rooms.previewContext(r.roomId, r.chiefId);
    assert.ok(!before.includes("### Memory"), "no memory injected before any review");
    await r.rooms.userSay(r.roomId, "Reply with the single word ALPHA.");
    // Bot-scope review is scheduled on the settle and drains asynchronously.
    assert.equal(await drain(r.memory, "bot", r.chiefId), 0, "bot review ran");
    assert.equal(await drain(r.memory, "room", r.roomId), 0, "room review ran");
    // Team batches at 5 — a single turn leaves it pending.
    assert.equal(r.memory.pendingCount("team", "team"), 1, "team waits for its threshold");
    // The NEXT prompt carries the frozen snapshot in its tail (§5.1a).
    const after = r.rooms.previewContext(r.roomId, r.chiefId);
    assert.match(after, /### Memory — Chief/);
    assert.match(after, /concise answers/);
    // Room-scope memory too.
    assert.match(after, /### Memory — room default/);
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

// --- API routes ------------------------------------------------------------------------------

test("memory API: GET files/pending, PUT edit, settings reviewModel round-trip", async () => {
  const root = mkdtempSync(join(tmpdir(), "codar-mem-api-"));
  mkdirSync(join(root, "work"), { recursive: true });
  process.env.CODAR_BOT_HOME = root;
  process.env.CODAR_BOT_PORT = "0";
  const { Host } = await import("../src/host/host.js");
  const host = Host.boot({ dataRoot: root, bin: process.execPath, argv: [FAKE_PI] });
  try {
    const port = await host.start();
    const chief = host.store.addBot({
      name: "C", role: "", chief: true,
      model: { provider: "fake", modelId: "f", thinkingLevel: "low" },
      workDir: join(root, "work"), sessionPath: null,
      sandbox: { mode: "host-not-isolated" }, budget: defaultBudget(),
    });
    // Empty at first.
    const empty = (await (await fetch(`http://127.0.0.1:${port}/api/memory/bots/${chief.id}`)).json()) as { files: unknown[]; pending: number };
    assert.deepEqual(empty, { files: [], pending: 0 });
    // Manual edit round-trips and is visible.
    const put = await fetch(`http://127.0.0.1:${port}/api/memory/bots/${chief.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "entry.md", content: "manual note" }),
    });
    assert.equal(put.status, 200);
    const got = (await (await fetch(`http://127.0.0.1:${port}/api/memory/bots/${chief.id}`)).json()) as { files: Array<{ path: string; content: string }> };
    assert.deepEqual(got.files, [{ path: "entry.md", content: "manual note\n" }]);
    // Whitelist guard.
    const bad = await fetch(`http://127.0.0.1:${port}/api/memory/bots/${chief.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "../state.json", content: "x" }),
    });
    assert.equal(bad.status, 400);
    // Settings: reviewModel slot round-trip.
    assert.deepEqual(
      (await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json()) as { reviewModel: unknown },
      { reviewModel: null }
    );
    const setModel = await fetch(`http://127.0.0.1:${port}/api/settings/review-model`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "zai", modelId: "glm-5.3", thinkingLevel: "high" }),
    });
    assert.equal(setModel.status, 200);
    const settings = (await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json()) as { reviewModel: { modelId: string } };
    assert.equal(settings.reviewModel.modelId, "glm-5.3");
  } finally {
    await host.shutdown();
    delete process.env.CODAR_BOT_HOME;
    delete process.env.CODAR_BOT_PORT;
    rmSync(root, { recursive: true, force: true });
  }
});

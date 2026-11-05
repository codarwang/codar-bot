/**
 * Memory M2-D tests — offline deterministic, fake-pi review child.
 * Covers: pure parse/validate, snapshot freeze bytes, reviewModel fallback,
 * ingest→review lifecycle (files/pending/ledger/reviews.log), broken/huge
 * fail-safe, team threshold, budget-paused gate, room/handoff wiring, and
 * the memory API routes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const bots = new BotManager(store, ledger, root, { bin: process.execPath, sandboxArgv: [FAKE_PI], env: {} });
  const rooms = new RoomEngine(store, bots, join(root, "rooms"));
  const memory = new MemoryEngine(store, ledger, root, { bin: process.execPath, sandboxArgv: [FAKE_PI], env: {} });
  return {
    root, store, ledger, bots, rooms, memory, chiefId: chief.id, roomId: room.id,
    async dispose() {
      ledger.close(); store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Wait until the scope's pending queue drains AND `done()` holds (the
 *  P1-1 claim-rename makes pendingCount hit 0 the moment a review STARTS —
 *  pending alone no longer proves the apply landed). */
async function drain(
  memory: MemoryEngine,
  scope: "bot" | "room" | "team",
  id: string,
  done: () => boolean = () => true,
  ms = 10_000
): Promise<number> {
  const deadline = Date.now() + ms;
  let n = memory.pendingCount(scope, id);
  while ((n > 0 || !done()) && Date.now() < deadline) {
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
    // Bot-scope review is scheduled on the settle and drains asynchronously;
    // done() waits for the APPLY (files on disk), not just the claim.
    assert.equal(
      await drain(r.memory, "bot", r.chiefId, () => r.memory.files("bot", r.chiefId).length > 0),
      0,
      "bot review ran"
    );
    assert.equal(
      await drain(r.memory, "room", r.roomId, () => r.memory.files("room", r.roomId).length > 0),
      0,
      "room review ran"
    );
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

// --- M2-D R1 regressions ---------------------------------------------------------

test("R1 P1-1: a turn ingested MID-review is never swallowed by the apply", async () => {
  const r = await rig();
  try {
    process.env.FAKE_PI_MEM_DELAY_MS = "400";
    r.memory.ingestTurn("bot", r.chiefId, turn("user", "turn-A"));
    const inFlight = r.memory.review("bot", r.chiefId);
    await new Promise((s2) => setTimeout(s2, 150));
    r.memory.ingestTurn("bot", r.chiefId, turn("user", "turn-B")); // lands mid-review
    assert.equal(await inFlight, "reviewed");
    assert.equal(r.memory.pendingCount("bot", r.chiefId), 1, "turn-B survives the apply");
    assert.equal(await r.memory.review("bot", r.chiefId), "reviewed");
    assert.equal(r.memory.pendingCount("bot", r.chiefId), 0);
  } finally {
    delete process.env.FAKE_PI_MEM_DELAY_MS;
    await r.dispose();
  }
});

test("R1 P1-2: a crashing review child fails the review WITHOUT killing the host", async () => {
  const r = await rig();
  try {
    process.env.FAKE_PI_MEM_REVIEW = "crash";
    r.memory.ingestTurn("bot", r.chiefId, turn("user", "x"));
    // If RpcClient's zero-listener "error" emit still threw, this await (or
    // the process) would die before the assertion.
    assert.equal(await r.memory.review("bot", r.chiefId), "failed");
    assert.equal(r.memory.pendingCount("bot", r.chiefId), 1, "claimed lines restored");
    assert.match(readFileSync(join(r.root, "audit.jsonl"), "utf8"), /memory-review-failed/);
    assert.ok(true, "host process still alive");
  } finally {
    delete process.env.FAKE_PI_MEM_REVIEW;
    await r.dispose();
  }
});

test("R1: DELETE marker removes a topic file end-to-end", async () => {
  const r = await rig();
  try {
    r.memory.ingestTurn("bot", r.chiefId, turn("user", "x"));
    assert.equal(await r.memory.review("bot", r.chiefId), "reviewed");
    assert.ok(r.memory.files("bot", r.chiefId).some((f) => f.path === "topics/style.md"), "style.md exists after ok review");
    process.env.FAKE_PI_MEM_REVIEW = "delete";
    r.memory.ingestTurn("bot", r.chiefId, turn("user", "y"));
    assert.equal(await r.memory.review("bot", r.chiefId), "reviewed");
    assert.ok(!r.memory.files("bot", r.chiefId).some((f) => f.path === "topics/style.md"), "DELETE removed it");
    assert.ok(r.memory.files("bot", r.chiefId).some((f) => f.path === "entry.md" && f.content.includes("kept.")));
  } finally {
    delete process.env.FAKE_PI_MEM_REVIEW;
    await r.dispose();
  }
});

test("R1 P2-2: one pass consumes at most REVIEW_TURNS_MAX; the rest wait", async () => {
  const r = await rig();
  try {
    for (let i = 0; i < 45; i++) r.memory.ingestTurn("bot", r.chiefId, turn("user", `t${i}`));
    assert.equal(await r.memory.review("bot", r.chiefId), "reviewed");
    assert.equal(r.memory.pendingCount("bot", r.chiefId), 5, "cap leaves the tail");
    assert.match(readFileSync(join(r.root, "memory", "bots", r.chiefId, "reviews.log"), "utf8"), /turns=40/);
  } finally {
    await r.dispose();
  }
});

test("R1 P2-2: a failed review cools the scope down — auto-schedule no-ops", async () => {
  const r = await rig();
  try {
    process.env.FAKE_PI_MEM_REVIEW = "broken";
    r.memory.ingestTurn("bot", r.chiefId, turn("user", "x"));
    assert.equal(await r.memory.review("bot", r.chiefId), "rejected");
    r.memory.ingestTurn("bot", r.chiefId, turn("user", "y"));
    r.memory.schedule("bot", r.chiefId);
    await new Promise((s2) => setTimeout(s2, 300));
    assert.equal(r.memory.pendingCount("bot", r.chiefId), 2, "cooldown blocks the auto retry");
  } finally {
    delete process.env.FAKE_PI_MEM_REVIEW;
    await r.dispose();
  }
});

test("R1: single-flight follow-up drains turns that arrived mid-review", async () => {
  const r = await rig();
  try {
    process.env.FAKE_PI_MEM_DELAY_MS = "300";
    r.memory.ingestTurn("bot", r.chiefId, turn("user", "A"));
    r.memory.schedule("bot", r.chiefId);
    await new Promise((s2) => setTimeout(s2, 100));
    r.memory.ingestTurn("bot", r.chiefId, turn("user", "B"));
    r.memory.schedule("bot", r.chiefId); // in-flight — must be a no-op
    // totals() aggregates per hour+model+kind: two runs of usage(30,6) land
    // as ONE row with input 60 — the audit log proves the run count.
    const rowsOf = () => r.ledger.totals({ botId: r.chiefId, kind: "memory-review" });
    assert.equal(
      await drain(r.memory, "bot", r.chiefId, () => rowsOf().reduce((a, x) => a + x.input, 0) === 60),
      0,
      "follow-up pass consumed B"
    );
    assert.equal(rowsOf().reduce((a, x) => a + x.input, 0), 60, "exactly two review runs (30 input each)");
    assert.equal(readFileSync(join(r.root, "audit.jsonl"), "utf8").split("\n").filter((l) => l.includes('"kind":"memory-review"')).length, 2);
  } finally {
    delete process.env.FAKE_PI_MEM_DELAY_MS;
    await r.dispose();
  }
});

test("R1 P3-2: a manual edit during a running review wins — the apply refuses", async () => {
  const r = await rig();
  try {
    process.env.FAKE_PI_MEM_DELAY_MS = "300";
    r.memory.ingestTurn("bot", r.chiefId, turn("user", "x"));
    const inFlight = r.memory.review("bot", r.chiefId);
    await new Promise((s2) => setTimeout(s2, 100));
    r.memory.writeFile("bot", r.chiefId, "entry.md", "MANUAL EDIT\n");
    assert.equal(await inFlight, "rejected", "stale-basis apply refused");
    assert.match(r.memory.snapshot("bot", r.chiefId), /MANUAL EDIT/, "the edit is intact");
    assert.equal(r.memory.pendingCount("bot", r.chiefId), 1, "pending restored for retry");
  } finally {
    delete process.env.FAKE_PI_MEM_DELAY_MS;
    await r.dispose();
  }
});

test("R1 P3-4: manual edits live under the same 2x size budget", async () => {
  const r = await rig();
  try {
    assert.throws(
      () => r.memory.writeFile("bot", r.chiefId, "entry.md", "x".repeat(5_000)),
      /2x budget/
    );
  } finally {
    await r.dispose();
  }
});

test("R1 P2-3: room-scoped review spend feeds the room budget window", async () => {
  const r = await rig();
  const budget = new Budget(r.store, r.ledger, r.bots, r.rooms, r.root);
  void budget;
  try {
    const room = r.store.room(r.roomId)!;
    r.store.updateRoom(r.roomId, { budget: { ...room.budget, maxTokens: 100 } });
    // A room-scoped memory review burns 90 tokens under the room's own id.
    r.ledger.record({
      hour: new Date().toISOString().slice(0, 13), botId: r.roomId, model: "fake/f",
      kind: "memory-review", input: 80, output: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costMicros: 0,
    });
    // Any member write re-evaluates the window: 90 (own) + 15 (member) ≥ 100.
    r.ledger.record({
      hour: new Date().toISOString().slice(0, 13), botId: r.chiefId, model: "fake/f",
      kind: "chat", input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costMicros: 0,
    });
    const dl = Date.now() + 5_000;
    while (r.store.room(r.roomId)!.status !== "paused" && Date.now() < dl) {
      await new Promise((s2) => setTimeout(s2, 50));
    }
    assert.equal(r.store.room(r.roomId)!.status, "paused", "review spend counts toward the room window");
    assert.equal(r.store.room(r.roomId)!.pauseReason, "budget");
  } finally {
    await r.dispose();
  }
});

test("R1: handoff onWorkDone feeds the child bot scope end-to-end", async () => {
  const r = await fullRig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    const writer = r.store.addBot({
      name: "Writer", role: "", chief: false,
      model: { provider: "fake", modelId: "f", thinkingLevel: "low" },
      workDir: join(r.root, "work"), sessionPath: null,
      sandbox: { mode: "host-not-isolated" }, budget: defaultBudget(),
    });
    r.store.updateRoom(r.roomId, { members: [r.chiefId, writer.id] });
    await r.bots.start(r.chiefId);
    await r.bots.start(writer.id);
    const { workId } = await r.handoff.dispatch({
      fromBot: r.chiefId, toBot: writer.id,
      task: "Reply with the single word ALPHA.", requestId: "mem-ho-1", roomId: r.roomId,
    });
    const dl = Date.now() + 15_000;
    while (r.handoff.work(workId)!.status !== "done" && Date.now() < dl) {
      await new Promise((s2) => setTimeout(s2, 100));
    }
    assert.equal(r.handoff.work(workId)!.status, "done");
    // The child's run (task+result) ingested into ITS bot scope and the
    // scheduled review drained it.
    assert.equal(
      await drain(r.memory, "bot", writer.id, () => r.memory.files("bot", writer.id).length > 0),
      0,
      "handoff run reviewed for the child scope"
    );
    assert.match(r.memory.snapshot("bot", writer.id), /### Memory — Writer/);
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("R2 P1-1: a child dying before the settle wait attaches cannot kill the host", async () => {
  const r = await rig();
  try {
    process.env.FAKE_PI_MEM_REVIEW = "startdie"; // exits before ANY rpc output
    r.memory.ingestTurn("bot", r.chiefId, turn("user", "x"));
    assert.equal(await r.memory.review("bot", r.chiefId), "failed", "start() path fails honestly");
    assert.equal(r.memory.pendingCount("bot", r.chiefId), 1, "claimed lines restored");
    // And the early-return ordering: the prompt command's FIRST response is
    // the rejection (the fixture rejects before any started event — the old
    // placement let a duplicate fail() land after success and the leg silently
    // rode the 3-minute wall abort instead, R3). It must fail FAST.
    process.env.FAKE_PI_MEM_REVIEW = "promptfail";
    r.memory.ingestTurn("bot", r.chiefId, turn("user", "y"));
    const t0 = Date.now();
    assert.equal(await r.memory.review("bot", r.chiefId), "failed", "prompt-reject path fails honestly");
    assert.ok(Date.now() - t0 < 5_000, "the rejection ordering, not a wall-clock abort");
    assert.equal(r.memory.pendingCount("bot", r.chiefId), 2, "nothing stranded in inflight");
    assert.ok(true, "host process still alive — no unhandled rejection");
  } finally {
    delete process.env.FAKE_PI_MEM_REVIEW;
    await r.dispose();
  }
});

test("R2 P2-1: a torn pending line drops with an audit instead of wedging the scope", async () => {
  const r = await rig();
  try {
    const pendingPath = join(r.root, "memory", "bots", r.chiefId, "pending.jsonl");
    mkdirSync(dirname(pendingPath), { recursive: true });
    // One torn line (crash mid-append) ahead of one good line.
    writeFileSync(pendingPath, '{"ts":"2026-11-05T00:00:00.000Z","speaker":"u","text":"half-a-lin\n');
    r.memory.ingestTurn("bot", r.chiefId, turn("user", "good turn"));
    assert.equal(await r.memory.review("bot", r.chiefId), "reviewed", "the good line still reviews");
    assert.equal(r.memory.pendingCount("bot", r.chiefId), 0, "no wedge — queue drains");
    assert.ok(r.memory.files("bot", r.chiefId).length > 0);
    assert.match(readFileSync(join(r.root, "audit.jsonl"), "utf8"), /memory-review-torn/);
  } finally {
    await r.dispose();
  }
});

test("R3 P3: a claim whose lines are ALL torn consumes without paying for a review", async () => {
  const r = await rig();
  try {
    const pendingPath = join(r.root, "memory", "bots", r.chiefId, "pending.jsonl");
    mkdirSync(dirname(pendingPath), { recursive: true });
    writeFileSync(pendingPath, '{"torn":\n{"also torn\n');
    assert.equal(await r.memory.review("bot", r.chiefId), "skipped", "zero good turns = no paid pass");
    assert.equal(r.memory.pendingCount("bot", r.chiefId), 0, "claim consumed");
    assert.equal(r.ledger.totals({ botId: r.chiefId, kind: "memory-review" }).length, 0, "nothing billed");
    assert.equal(r.memory.files("bot", r.chiefId).length, 0, "no unprompted file mutation");
    assert.match(readFileSync(join(r.root, "audit.jsonl"), "utf8"), /memory-review-torn/);
  } finally {
    await r.dispose();
  }
});

test("R4 P1: a scope with no resolvable review model must not spin the follow-up loop", async () => {
  const r = await rig();
  try {
    // Single-bot rig: deleting the chief leaves the room with a dangling
    // admin AND the team without its chief — every scope loses its model.
    r.store.removeBot(r.chiefId);
    r.memory.ingestTurn("room", r.roomId, turn("user", "x"));
    const t0 = Date.now();
    r.memory.schedule("room", r.roomId); // must be a no-op, not a spin
    await new Promise((s2) => setTimeout(s2, 500)); // the loop starved this in the bug
    const elapsed = Date.now() - t0;
    // With the fix, schedule() is a no-op at the gate — the audit file may
    // not even exist (zero spins, zero skip audits).
    let skips = 0;
    try {
      skips = readFileSync(join(r.root, "audit.jsonl"), "utf8")
        .split("\n").filter((l) => l.includes("memory-review-skipped")).length;
    } catch {
      skips = 0;
    }
    assert.ok(elapsed >= 450 && elapsed < 2_000, "event loop alive (timer fired on time)");
    assert.ok(skips <= 1, `no spin (skip audits: ${skips})`);
    assert.equal(r.memory.pendingCount("room", r.roomId), 1, "turns wait for a model, never lost");
  } finally {
    await r.dispose();
  }
});

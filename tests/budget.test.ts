/**
 * Budget enforcement tests — fake-pi children, offline deterministic.
 * Covers: bot stop on token limit, room pause on room limit, 80% warn
 * once-per-window, limit-raise resumes a budget-paused room, sticky stop
 * within a window, ledger-hook wiring.
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
import { Budget, monthKey } from "../src/host/budget.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(HERE, "fixtures/fake-pi.mjs");

async function rig(botBudget?: Partial<ReturnType<typeof defaultBudget>>) {
  const root = mkdtempSync(join(tmpdir(), "codar-bud-"));
  mkdirSync(join(root, "work"), { recursive: true });
  const store = Store.open(join(root, "state.json"), { create: true });
  const ledger = new UsageLedger(join(root, "usage.sqlite"));
  const bots = new BotManager(store, ledger, root, {
    bin: process.execPath, sandboxArgv: [FAKE_PI], env: {},
  });
  const budgetConfig = { ...defaultBudget(), ...(botBudget ?? {}) };
  const chief = store.addBot({
    name: "Chief", role: "", chief: true,
    model: { provider: "fake", modelId: "f", thinkingLevel: "low" },
    workDir: join(root, "work"), sessionPath: null,
    sandbox: { mode: "host-not-isolated" }, budget: budgetConfig,
  });
  const room = store.addRoom({
    name: "default", members: [chief.id], admin: chief.id,
    mode: "admin-reply", sharedDir: join(root, "s"), budget: defaultBudget(), goal: null,
  });
  const rooms = new RoomEngine(store, bots, join(root, "rooms"));
  const budget = new Budget(store, ledger, bots, rooms, root);
  return {
    root, store, ledger, bots, rooms, budget, chiefId: chief.id, roomId: room.id,
    async dispose() {
      await bots.stopAll(); ledger.close(); store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function monthHour(): string {
  return `${monthKey()}-01T00`;
}

test("bot over token limit: stopped, room broadcast, audit line, sticky", async () => {
  const r = await rig({ maxTokens: 100 });
  try {
    const events: string[] = [];
    r.budget.on("budget", (e: { level: string; dimension: string; pct: number }) =>
      events.push(`${e.level}:${e.dimension}:${e.pct}`));

    // Simulate the ledger write path (the hook fires on record).
    const hour = monthHour();
    r.ledger.record({
      hour, botId: r.chiefId, model: "fake/f", kind: "chat",
      input: 90, output: 5, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costMicros: 0,
    });
    // 95/100 = 95% ≥ 80 → warn fired once.
    assert.ok(events.some((e) => e.startsWith("warn:tokens:")));
    assert.equal(r.bots.status(r.chiefId), "stopped", "never started → stays stopped");

    // Cross 100%.
    r.ledger.record({
      hour, botId: r.chiefId, model: "fake/f", kind: "chat",
      input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costMicros: 0,
    });
    assert.ok(events.some((e) => e.startsWith("stop:tokens:")), "stop event fired");
    // The room broadcast is async (fires after bots.stop resolves — R2 P3-6
    // ordering): wait for it.
    const bDeadline = Date.now() + 5_000;
    while (
      !r.rooms.history(r.roomId).some((m) => m.from.kind === "system" && m.text.includes("BUDGET STOPPED")) &&
      Date.now() < bDeadline
    ) {
      await new Promise((s2) => setTimeout(s2, 50));
    }
    const hist = r.rooms.history(r.roomId);
    assert.ok(hist.some((m) => m.from.kind === "system" && m.text.includes("BUDGET STOPPED")));
    // Audit line.
    const audit = (await import("node:fs")).readFileSync(join(r.root, "audit.jsonl"), "utf8");
    assert.ok(audit.includes("budget-stop"));
    // Warn fired exactly once for this window.
    assert.equal(events.filter((e) => e.startsWith("warn:")).length, 1);
  } finally {
    await r.dispose();
  }
});

test("room over cost limit: paused via rooms.pause (un-liftable by user msg)", async () => {
  const root = mkdtempSync(join(tmpdir(), "codar-bud2-"));
  mkdirSync(join(root, "work"), { recursive: true });
  const store = Store.open(join(root, "state.json"), { create: true });
  const ledger = new UsageLedger(join(root, "usage.sqlite"));
  const bots = new BotManager(store, ledger, root, { bin: process.execPath, sandboxArgv: [FAKE_PI], env: {} });
  try {
    const chief = store.addBot({
      name: "Chief", role: "", chief: true,
      model: { provider: "fake", modelId: "f", thinkingLevel: "low" },
      workDir: join(root, "work"), sessionPath: null,
      sandbox: { mode: "host-not-isolated" }, budget: defaultBudget(),
    });
    const room = store.addRoom({
      name: "d", members: [chief.id], admin: chief.id,
      mode: "admin-reply", sharedDir: join(root, "s"), goal: null,
      budget: { ...defaultBudget(), maxCostMicros: 1000 },
    });
    const rooms = new RoomEngine(store, bots, join(root, "rooms"));
    const budget = new Budget(store, ledger, bots, rooms, root);
    ledger.record({
      hour: monthHour(), botId: chief.id, model: "fake/f", kind: "chat",
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costMicros: 1500,
    });
    assert.equal(store.room(room.id)!.status, "paused");
    assert.equal(store.room(room.id)!.pauseReason, "budget");
    await assert.rejects(() => rooms.userSay(room.id, "hello"), /budget-paused/);
    void budget;
  } finally {
    await bots.stopAll(); ledger.close(); store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("limit raise resumes a budget-paused room (§5.3 recovery)", async () => {
  const r = await rig();
  try {
    const room = r.store.room(r.roomId)!;
    r.store.updateRoom(r.roomId, { budget: { ...room.budget, maxCostMicros: 100 } });
    r.ledger.record({
      hour: monthHour(), botId: r.chiefId, model: "fake/f", kind: "chat",
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costMicros: 150,
    });
    assert.equal(r.store.room(r.roomId)!.status, "paused");
    // Raise the limit (the recovery path the API PUT exercises).
    const paused = r.store.room(r.roomId)!;
    r.store.updateRoom(r.roomId, { budget: { ...paused.budget, maxCostMicros: 10000 } });
    r.rooms.resume(r.roomId, "budget adjusted — room resumed");
    assert.equal(r.store.room(r.roomId)!.status, "active");
  } finally {
    await r.dispose();
  }
});

test("M2-C R1: sticky stop — subsequent over-limit writes do not re-broadcast", async () => {
  const r = await rig({ maxTokens: 100 });
  try {
    const stops: string[] = [];
    r.budget.on("budget", (e: { level: string }) => { if (e.level === "stop") stops.push("x"); });
    const hour = monthHour();
    for (let i = 0; i < 3; i++) {
      r.ledger.record({
        hour, botId: r.chiefId, model: "fake/f", kind: "chat",
        input: 50, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costMicros: 0,
      });
    }
    assert.equal(stops.length, 1, "one stop event, sticky afterwards");
    const bDeadline2 = Date.now() + 5_000;
    while (
      r.rooms.history(r.roomId).filter((m) => m.from.kind === "system" && m.text.includes("BUDGET STOPPED")).length < 1 &&
      Date.now() < bDeadline2
    ) {
      await new Promise((s2) => setTimeout(s2, 50));
    }
    const sys = r.rooms.history(r.roomId).filter((m) => m.from.kind === "system" && m.text.includes("BUDGET STOPPED"));
    assert.equal(sys.length, 1, "one broadcast (sticky — no storm)");
  } finally {
    await r.dispose();
  }
});

test("M2-C R1: maxTurns wired — settled turns stop the bot at the limit", async () => {
  const r = await rig({ maxTurns: 2 });
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.chiefId);
    await r.rooms.userSay(r.roomId, "Reply with the single word ALPHA.");
    assert.equal(r.store.room(r.roomId)!.status, "active", "1 turn < 2 limit");
    await r.rooms.userSay(r.roomId, "Reply with the single word BRAVO.");
    assert.equal(r.bots.status(r.chiefId), "stopped", "2nd settle hits maxTurns → stopped");
    assert.ok(r.rooms.history(r.roomId).some((m) => m.from.kind === "system" && m.text.includes("turns")));
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("M2-C R1: HTTP GET /api/budget/:id reports month usage (route regression)", async () => {
  const root = mkdtempSync(join(tmpdir(), "codar-bud-http-"));
  mkdirSync(join(root, "work"), { recursive: true });
  mkdirSync(join(root, "web-dist"), { recursive: true });
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
    host.ledger.record({
      hour: monthHour(), botId: chief.id, model: "fake/f", kind: "chat",
      input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costMicros: 12,
    });
    const detail = (await (await fetch(`http://127.0.0.1:${port}/api/budget/${chief.id}`)).json()) as {
      scope: string; tokens: number; costMicros: number; budget: { maxTokens: number };
    };
    assert.equal(detail.scope, "bot");
    assert.equal(detail.tokens, 12);
    assert.equal(detail.costMicros, 12);
    const collection = (await (await fetch(`http://127.0.0.1:${port}/api/budget`)).json()) as Array<{ id: string }>;
    assert.ok(Array.isArray(collection) && collection.some((x) => x.id === chief.id));
  } finally {
    await host.shutdown();
    delete process.env.CODAR_BOT_HOME;
    delete process.env.CODAR_BOT_PORT;
    rmSync(root, { recursive: true, force: true });
  }
});

test("M2-C R2: start/restart settle is NOT counted as a turn (working→idle only)", async () => {
  const r = await rig({ maxTurns: 3 });
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.chiefId); // starting→idle must not burn a turn
    await r.rooms.userSay(r.roomId, "Reply with the single word ALPHA."); // turn 1
    assert.equal(r.bots.status(r.chiefId), "idle", "1 turn < 3 limit, still alive");
    await r.rooms.userSay(r.roomId, "Reply with the single word BRAVO."); // turn 2
    assert.equal(r.bots.status(r.chiefId), "idle", "2 turns < 3, still alive");
    await r.rooms.userSay(r.roomId, "Reply with the single word OK."); // turn 3 = limit
    assert.equal(r.bots.status(r.chiefId), "stopped", "3rd REAL turn hits maxTurns");
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("M2-C R3: restart (no in-memory state) keeps a budget-paused room paused", async () => {
  const r = await rig();
  try {
    // Tighten the room, cross it, get paused.
    const room = r.store.room(r.roomId)!;
    r.store.updateRoom(r.roomId, { budget: { ...room.budget, maxCostMicros: 100 } });
    r.ledger.record({
      hour: monthHour(), botId: r.chiefId, model: "fake/f", kind: "chat",
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costMicros: 150,
    });
    const pDeadline = Date.now() + 5_000;
    while (r.store.room(r.roomId)!.status !== "paused" && Date.now() < pDeadline) {
      await new Promise((s2) => setTimeout(s2, 50));
    }
    assert.equal(r.store.room(r.roomId)!.status, "paused");
    // A NEW Budget instance = host restarted (empty scopes map). The old bug
    // treated "no state" as a rollover and un-paused the still-over room.
    const reborn = new Budget(r.store, r.ledger, r.bots, r.rooms, r.root);
    reborn.rolloverIfStale(r.roomId);
    assert.equal(r.store.room(r.roomId)!.status, "paused", "no-state ≠ rollover — pause survives restart");
    await assert.rejects(() => r.rooms.userSay(r.roomId, "hello"), /budget-paused/);
  } finally {
    await r.dispose();
  }
});

test("M2-C R3: PATCH /api/bots/:id budget edit re-arms the sticky stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "codar-bud-patch-"));
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
      sandbox: { mode: "host-not-isolated" },
      budget: { ...defaultBudget(), maxTokens: 100 },
    });
    const room = host.store.addRoom({
      name: "d", members: [chief.id], admin: chief.id,
      mode: "admin-reply", sharedDir: join(root, "s"), goal: null, budget: defaultBudget(),
    });
    const sysLines = async (): Promise<number> => {
      const res = await fetch(`http://127.0.0.1:${port}/api/rooms/${room.id}/messages`);
      const body = (await res.json()) as { messages: Array<{ from: { kind: string }; text: string }> };
      return body.messages.filter((m) => m.from.kind === "system" && m.text.includes("BUDGET STOPPED")).length;
    };
    const waitLines = async (n: number): Promise<number> => {
      const dl = Date.now() + 5_000;
      let c = await sysLines();
      while (c < n && Date.now() < dl) { await new Promise((s2) => setTimeout(s2, 50)); c = await sysLines(); }
      return c;
    };
    // First breach → stop #1 (sticky within the window). 105/100 crosses
    // the limit outright (a 95% write would only warn).
    host.ledger.record({
      hour: monthHour(), botId: chief.id, model: "fake/f", kind: "chat",
      input: 90, output: 15, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costMicros: 0,
    });
    assert.equal(await waitLines(1), 1, "first stop broadcast");
    // PATCH the bot budget (full 4-field body) — re-arm via THIS route.
    const patch = await fetch(`http://127.0.0.1:${port}/api/bots/${chief.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budget: { maxTokens: 200, maxCostMicros: 20_000_000, maxTurns: 2_000, maxWallMs: 3_600_000 } }),
    });
    assert.equal(patch.status, 200);
    // Sticky without re-arm would swallow this second breach.
    host.ledger.record({
      hour: monthHour(), botId: chief.id, model: "fake/f", kind: "chat",
      input: 250, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costMicros: 0,
    });
    assert.equal(await waitLines(2), 2, "re-armed: a fresh breach stops again");
  } finally {
    await host.shutdown();
    delete process.env.CODAR_BOT_HOME;
    delete process.env.CODAR_BOT_PORT;
    rmSync(root, { recursive: true, force: true });
  }
});

test("M2-C R3: room budget PUT — insufficient raise keeps the stop sticky; a real clear re-arms + resumes", async () => {
  const root = mkdtempSync(join(tmpdir(), "codar-bud-put-"));
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
    const room = host.store.addRoom({
      name: "d", members: [chief.id], admin: chief.id,
      mode: "admin-reply", sharedDir: join(root, "s"), goal: null,
      budget: { ...defaultBudget(), maxCostMicros: 100 },
    });
    const pauseLines = async (): Promise<number> => {
      const res = await fetch(`http://127.0.0.1:${port}/api/rooms/${room.id}/messages`);
      const body = (await res.json()) as { messages: Array<{ from: { kind: string }; text: string }> };
      return body.messages.filter((m) => m.from.kind === "system" && m.text.includes("ROOM PAUSED")).length;
    };
    host.ledger.record({
      hour: monthHour(), botId: chief.id, model: "fake/f", kind: "chat",
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costMicros: 150,
    });
    const pDeadline = Date.now() + 5_000;
    while (host.store.room(room.id)!.status !== "paused" && Date.now() < pDeadline) {
      await new Promise((s2) => setTimeout(s2, 50));
    }
    assert.equal(host.store.room(room.id)!.status, "paused");
    assert.equal(await pauseLines(), 1);
    // Insufficient raise (150 used > 120): stays paused, sticky NOT re-armed.
    const put1 = await fetch(`http://127.0.0.1:${port}/api/budget/${room.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxCostMicros: 120 }),
    });
    assert.equal(put1.status, 200);
    assert.equal(host.store.room(room.id)!.status, "paused", "insufficient raise must not resume");
    // Another write over the (new) limit: with sticky intact this is a no-op —
    // no second pause ceremony.
    host.ledger.record({
      hour: monthHour(), botId: chief.id, model: "fake/f", kind: "chat",
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costMicros: 100,
    });
    await new Promise((s2) => setTimeout(s2, 500));
    assert.equal(await pauseLines(), 1, "sticky survives an insufficient raise — no phantom re-stop");
    // Real clear: resume + re-arm.
    const put2 = await fetch(`http://127.0.0.1:${port}/api/budget/${room.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxCostMicros: 10_000 }),
    });
    assert.equal(put2.status, 200);
    assert.equal(host.store.room(room.id)!.status, "active", "real clear resumes");
  } finally {
    await host.shutdown();
    delete process.env.CODAR_BOT_HOME;
    delete process.env.CODAR_BOT_PORT;
    rmSync(root, { recursive: true, force: true });
  }
});

test("M2-C R4: pausedAt month stamp makes next-month auto-resume durable across restarts", async () => {
  const r = await rig();
  try {
    const room = r.store.room(r.roomId)!;
    r.store.updateRoom(r.roomId, { budget: { ...room.budget, maxCostMicros: 100 } });
    r.ledger.record({
      hour: monthHour(), botId: r.chiefId, model: "fake/f", kind: "chat",
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costMicros: 150,
    });
    const pDeadline = Date.now() + 5_000;
    while (r.store.room(r.roomId)!.status !== "paused" && Date.now() < pDeadline) {
      await new Promise((s2) => setTimeout(s2, 50));
    }
    const paused = r.store.room(r.roomId)!;
    assert.equal(paused.status, "paused");
    assert.ok(typeof paused.pausedAt === "string", "pause records a durable timestamp");
    // SAME month, fresh Budget (restart): the pause holds.
    const sameMonth = new Budget(r.store, r.ledger, r.bots, r.rooms, r.root);
    sameMonth.rolloverIfStale(r.roomId);
    assert.equal(r.store.room(r.roomId)!.status, "paused", "same-month stamp does not resume");
    // The pause lands in a PREVIOUS month: rollover resumes — no manual PUT.
    const old = new Date(Date.now() - 32 * 24 * 3600 * 1000).toISOString();
    r.store.updateRoom(r.roomId, { pausedAt: old });
    const nextMonth = new Budget(r.store, r.ledger, r.bots, r.rooms, r.root);
    nextMonth.rolloverIfStale(r.roomId);
    assert.equal(r.store.room(r.roomId)!.status, "active", "old-month stamp auto-resumes (§5.3)");
    assert.equal(r.store.room(r.roomId)!.pauseReason, null);
  } finally {
    await r.dispose();
  }
});

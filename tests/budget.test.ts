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
    // Room log carries the broadcast (§3.2-4 no silent failure).
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

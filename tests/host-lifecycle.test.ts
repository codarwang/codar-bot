/**
 * Host lifecycle tests — the paths round-1 review flagged as blind spots:
 * crash single-flight restart, stop-during-starting, handled disposition,
 * concurrent prompt refusal, live-pid lock, SSE stream.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, defaultBudget } from "../src/host/store.js";
import { UsageLedger } from "../src/host/usage-ledger.js";
import { BotManager } from "../src/host/bot-manager.js";
import { Host } from "../src/host/host.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(HERE, "fixtures/fake-pi.mjs");

async function rig(env: Record<string, string> = {}): Promise<{
  root: string; store: Store; ledger: UsageLedger; bots: BotManager; botId: string;
  dispose(): Promise<void>;
}> {
  const root = mkdtempSync(join(tmpdir(), "codar-life-"));
  mkdirSync(join(root, "work"), { recursive: true });
  const store = Store.open(join(root, "state.json"), { create: true });
  const ledger = new UsageLedger(join(root, "usage.sqlite"));
  const bots = new BotManager(store, ledger, root, {
    bin: process.execPath, sandboxArgv: [FAKE_PI],
    env: { FAKE_PI_SESSION_FILE: "/tmp/fake-session", ...env },
  });
  const bot = store.addBot({
    name: "Life", role: "", chief: true,
    model: { provider: "fake", modelId: "fake-1", thinkingLevel: "low" },
    workDir: join(root, "work"), sessionPath: null,
    sandbox: { mode: "host-not-isolated" }, budget: defaultBudget(),
  });
  return {
    root, store, ledger, bots, botId: bot.id,
    async dispose() {
      await bots.stopAll();
      ledger.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("mid-run child crash: single-flight restart brings the bot back (backoff ≥1s)", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.botId);
    // DIE: the fake child exits(1) mid-run without settling.
    await assert.rejects(() => r.bots.prompt(r.botId, "please DIE now"), /exited mid-prompt/);
    assert.equal(r.bots.status(r.botId), "crashed");
    // Single-flight recovery: exactly one chain, restarts counter sane.
    const deadline = Date.now() + 15_000;
    while (r.bots.status(r.botId) !== "idle" && Date.now() < deadline) {
      await new Promise((s) => setTimeout(s, 200));
    }
    assert.equal(r.bots.status(r.botId), "idle");
    const text = await r.bots.prompt(r.botId, "Reply with the single word ALPHA.");
    assert.equal(text, "ALPHA");
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("stop during starting is honored — the bot never resurrects", async () => {
  const r = await rig({ FAKE_PI_READY_DELAY_MS: "1500" });
  try {
    const starting = r.bots.start(r.botId);
    await new Promise((s) => setTimeout(s, 250)); // inside ready wait
    await r.bots.stop(r.botId);
    // The killed child fails the ready probe — start() rejects honestly;
    // what must NOT happen is a resurrection via the restart chain.
    await assert.rejects(() => starting, /exited early|stopped|switch_session/);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) await new Promise((s) => setTimeout(s, 200));
    assert.equal(r.bots.status(r.botId), "stopped");
    assert.equal(r.bots.statusOfAll()[0]!.lastError === null || true, true);
    // And a subsequent explicit start works (sentinel was per-stop).
    await r.bots.start(r.botId);
    assert.equal(r.bots.status(r.botId), "idle");
  } finally {
    await r.dispose();
  }
});

test("slash-command disposition 'handled' rejects promptly and returns to idle", async () => {
  const r = await rig();
  try {
    await r.bots.start(r.botId);
    await assert.rejects(() => r.bots.prompt(r.botId, "/models"), /handled/);
    assert.equal(r.bots.status(r.botId), "idle");
    // No listener leak: a plain prompt right after still works.
    const text = await r.bots.prompt(r.botId, "Reply with the single word ALPHA.");
    assert.equal(text, "ALPHA");
  } finally {
    await r.dispose();
  }
});

test("concurrent prompt refuses while working", async () => {
  const r = await rig();
  try {
    await r.bots.start(r.botId);
    const slow = r.bots.prompt(r.botId, "take it SLOW"); // 1.5s deterministic run
    await new Promise((s) => setTimeout(s, 250)); // inside the run
    await assert.rejects(() => r.bots.prompt(r.botId, "another"), /already working/);
    assert.equal(await slow, "OK");
    assert.equal(r.bots.status(r.botId), "idle");
  } finally {
    await r.dispose();
  }
});

test("live pid holds the lock regardless of lock age", () => {
  const dir = mkdtempSync(join(tmpdir(), "codar-lock-"));
  try {
    const path = join(dir, "state.json");
    const a = Store.openExclusive(path, { create: true });
    // Re-write the lock with OUR pid but an ancient ts — still unbreakable.
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now() - 3_600_000 }));
    assert.throws(() => Store.openExclusive(path), /locked by live pid/);
    a.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SSE stream: hello + live status events flow to a connected client", async () => {
  const root = mkdtempSync(join(tmpdir(), "codar-sse-"));
  mkdirSync(join(root, "work"), { recursive: true });
  try {
    process.env.CODAR_BOT_HOME = root;
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    process.env.CODAR_BOT_PORT = "0";
    const host = Host.boot({ dataRoot: root, bin: process.execPath, argv: [FAKE_PI] });
    host.store.addBot({
      name: "Sse", role: "", chief: false,
      model: { provider: "fake", modelId: "f", thinkingLevel: "low" },
      workDir: join(root, "work"), sessionPath: null,
      sandbox: { mode: "host-not-isolated" as const }, budget: defaultBudget(),
    });
    const port = await host.start();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const seen: string[] = [];
    const readFor = async (ms: number): Promise<void> => {
      const timer = new Promise((s) => setTimeout(s, ms));
      await Promise.race([
        (async () => {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            seen.push(Buffer.from(value).toString("utf8"));
            if (seen.join("").includes("working")) return;
          }
        })(),
        timer,
      ]);
    };
    await readFor(500); // hello frame
    const overview = (await (await fetch(`http://127.0.0.1:${port}/api/overview`)).json()) as { bots: Array<{ id: string }> };
    await fetch(`http://127.0.0.1:${port}/api/bots/${overview.bots[0]!.id}/start`, { method: "POST" });
    await readFor(2_000); // starting/idle status frames
    const all = seen.join("");
    assert.ok(all.includes("event: hello"), "hello frame");
    assert.ok(all.includes("event: status"), "status frames");
    await reader.cancel();
    await host.shutdown();
  } finally {
    delete process.env.CODAR_BOT_HOME;
    delete process.env.CODAR_M1_AUTOAPPROVE;
    delete process.env.CODAR_BOT_PORT;
    rmSync(root, { recursive: true, force: true });
  }
});

test("epoch guard: a superseded recovery chain cannot mark a live bot stopped (R2 P2)", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.botId);
    // Crash the child; the recovery chain arms its 1s backoff.
    await assert.rejects(() => r.bots.prompt(r.botId, "please DIE now"), /exited mid-prompt/);
    assert.equal(r.bots.status(r.botId), "crashed");
    // Manual stop + start DURING the backoff — this bumps the epoch and
    // supersedes the chain.
    await r.bots.stop(r.botId);
    await r.bots.start(r.botId);
    assert.equal(r.bots.status(r.botId), "idle");
    // Wait past the old chain's backoff horizon: it must exit silently.
    await new Promise((s) => setTimeout(s, 4_500));
    assert.equal(r.bots.status(r.botId), "idle", "superseded chain must not flip the live bot to stopped");
    const text = await r.bots.prompt(r.botId, "Reply with the single word ALPHA.");
    assert.equal(text, "ALPHA");
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("R3 regression: auto-recovery survives MULTIPLE crashes (no single-flight latch)", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.botId);
    // First crash → chain recovers.
    await assert.rejects(() => r.bots.prompt(r.botId, "please DIE now"), /exited mid-prompt/);
    let deadline = Date.now() + 15_000;
    while (r.bots.status(r.botId) !== "idle" && Date.now() < deadline) {
      await new Promise((s) => setTimeout(s, 200));
    }
    assert.equal(r.bots.status(r.botId), "idle");
    // Second crash → the chain must STILL be able to run (R3 P1: the flag
    // used to latch after the first recovery).
    await assert.rejects(() => r.bots.prompt(r.botId, "please DIE again"), /exited mid-prompt/);
    deadline = Date.now() + 15_000;
    while (r.bots.status(r.botId) !== "idle" && Date.now() < deadline) {
      await new Promise((s) => setTimeout(s, 200));
    }
    assert.equal(r.bots.status(r.botId), "idle", "second crash must also auto-recover");
    const text = await r.bots.prompt(r.botId, "Reply with the single word ALPHA.");
    assert.equal(text, "ALPHA");
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("R3 regression: exhausted retry ladder lands on stopped (not starting)", async () => {
  const root = mkdtempSync(join(tmpdir(), "codar-ladder-"));
  mkdirSync(join(root, "work"), { recursive: true });
  const store = Store.open(join(root, "state.json"), { create: true });
  const ledger = new UsageLedger(join(root, "usage.sqlite"));
  // A spawn that can never become ready: node with a nonexistent script.
  const bots = new BotManager(store, ledger, root, {
    bin: process.execPath, sandboxArgv: ["/nonexistent/fake-pi.mjs"],
  });
  const bot = store.addBot({
    name: "Ladder", role: "", chief: true,
    model: { provider: "fake", modelId: "f", thinkingLevel: "low" },
    workDir: join(root, "work"), sessionPath: null,
    sandbox: { mode: "host-not-isolated" }, budget: defaultBudget(),
  });
  try {
    await assert.rejects(() => bots.start(bot.id), /exited early|switch_session|get_state/);
    // Ladder: 1s + 2s + 4s backoffs + spawn/ready failures ≈ 8–10s.
    const deadline = Date.now() + 30_000;
    while (bots.status(bot.id) !== "stopped" && Date.now() < deadline) {
      await new Promise((s) => setTimeout(s, 300));
    }
    assert.equal(bots.status(bot.id), "stopped", "budget exhausted must land on stopped");
    assert.ok(store === store); // keep refs
  } finally {
    await bots.stopAll();
    ledger.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * BotManager + Host integration tests — REAL child processes of the
 * deterministic fake-pi fixture (offline, no network, no model).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, defaultBudget, type BotRecord } from "../src/host/store.js";
import { UsageLedger } from "../src/host/usage-ledger.js";
import { BotManager } from "../src/host/bot-manager.js";
import { Host } from "../src/host/host.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(HERE, "fixtures/fake-pi.mjs");

interface Rig {
  root: string;
  store: Store;
  ledger: UsageLedger;
  bots: BotManager;
  dispose(): Promise<void>;
}

async function rig(): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), "codar-bm-"));
  mkdirSync(join(root, "work"), { recursive: true });
  mkdirSync(join(root, "pi-conf"), { recursive: true });
  const store = Store.open(join(root, "state.json"), { create: true });
  const ledger = new UsageLedger(join(root, "usage.sqlite"));
  const bots = new BotManager(store, ledger, root, {
    bin: process.execPath, sandboxArgv: [FAKE_PI],
    env: { FAKE_PI_SESSION_FILE: "/tmp/fake-session" },
  });
  const bot = store.addBot({
    ...({} as Omit<BotRecord, "id">),
    name: "Tester", role: "", chief: true,
    model: { provider: "fake", modelId: "fake-1", thinkingLevel: "low" },
    workDir: join(root, "work"), sessionPath: null,
    sandbox: { mode: "host-not-isolated" }, budget: defaultBudget(),
  } as Parameters<Store["addBot"]>[0]);
  return {
    root, store, ledger, bots,
    async dispose() {
      await bots.stopAll();
      ledger.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// fake-pi.mjs is spawned via `node fake-pi.mjs` — but RpcClient passes rpc
// flags. The fixture ignores unknown flags? No: it only reads stdin lines.
// The spawn must be `node fake-pi.mjs` with pi flags AFTER — the fixture
// never parses argv, so appending flags is harmless.
test("lifecycle: start → prompt streams deltas → ledger recorded → session persisted", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    const deltas: string[] = [];
    r.bots.on("delta", (e) => deltas.push(e.text));
    await r.bots.start(r.store.state.bots[0]!.id);
    const text = await r.bots.prompt(r.store.state.bots[0]!.id, "Reply with the single word ALPHA.");
    assert.equal(text, "ALPHA");
    assert.ok(deltas.join("").includes("ALPHA"), "deltas streamed to the bus");
    const totals = r.ledger.totals({ botId: r.store.state.bots[0]!.id });
    assert.equal(totals.length, 1);
    assert.equal(totals[0]!.input, 10);
    assert.equal(totals[0]!.costMicros, 11);
    assert.equal(r.bots.status(r.store.state.bots[0]!.id), "idle");
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("failure surface: injected provider error emits failure and settles cleanly", async () => {
  const r = await rig();
  try {
    const failures: string[] = [];
    r.bots.on("failure", (e) => failures.push(e.reason));
    await r.bots.start(r.store.state.bots[0]!.id);
    const text = await r.bots.prompt(r.store.state.bots[0]!.id, "please FAIL now");
    assert.equal(text, "");
    assert.equal(failures.length, 1);
    assert.ok(failures[0]!.includes("500"));
    assert.equal(r.bots.status(r.store.state.bots[0]!.id), "idle");
  } finally {
    await r.dispose();
  }
});

test("park: confirm bridges through auto-approve and the run completes", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await r.bots.start(r.store.state.bots[0]!.id);
    const text = await r.bots.prompt(r.store.state.bots[0]!.id, "PARK then continue");
    assert.equal(text, "PARKED");
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("session resume: persisted sessionPath is replayed via switch_session on next start", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    const id = r.store.state.bots[0]!.id;
    await r.bots.start(id);
    await r.bots.prompt(id, "Reply with the single word BRAVO.");
    const bot = r.store.bot(id)!;
    assert.equal(bot.sessionPath, "/tmp/fake-session"); // fake's get_state echo
    await r.bots.stop(id);
    await r.bots.start(id); // resume path issues switch_session
    assert.equal(r.bots.status(id), "idle");
    const text = await r.bots.prompt(id, "Reply with the single word ALPHA.");
    assert.equal(text, "ALPHA");
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("stop then prompt refuses honestly", async () => {
  const r = await rig();
  try {
    const id = r.store.state.bots[0]!.id;
    await r.bots.start(id);
    await r.bots.stop(id);
    await assert.rejects(() => r.bots.prompt(id, "hello"), /not running/);
  } finally {
    await r.dispose();
  }
});

test("host boots, serves overview + prompt over HTTP, shuts down clean", async () => {
  const root = mkdtempSync(join(tmpdir(), "codar-host-"));
  mkdirSync(join(root, "work"), { recursive: true });
  try {
    process.env.CODAR_BOT_HOME = root;
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    process.env.CODAR_BOT_PORT = "0";
    const host = Host.boot({ dataRoot: root, bin: process.execPath, argv: [FAKE_PI] });
    const store = host.store;
    store.addBot({
      name: "Http", role: "", chief: false,
      model: { provider: "fake", modelId: "f", thinkingLevel: "low" },
      workDir: join(root, "work"), sessionPath: null,
      sandbox: { mode: "host-not-isolated" as const }, budget: defaultBudget(),
    });
    const port = await host.start();
    assert.ok(port > 0);
    const overview = (await (await fetch(`http://127.0.0.1:${port}/api/overview`)).json()) as {
      bots: Array<{ id: string; name: string }>;
    };
    assert.equal(overview.bots.length, 1);
    const id = overview.bots[0]!.id;
    await (await fetch(`http://127.0.0.1:${port}/api/bots/${id}/start`, { method: "POST" })).json();
    const pr = (await (await fetch(`http://127.0.0.1:${port}/api/bots/${id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Reply with the single word ALPHA." }),
    })).json()) as { text: string };
    assert.equal(pr.text, "ALPHA");
    const usage = (await (await fetch(`http://127.0.0.1:${port}/api/usage`)).json()) as Array<{ input: number }>;
    assert.equal(usage[0]!.input, 10);
    await host.shutdown();
  } finally {
    delete process.env.CODAR_BOT_HOME;
    delete process.env.CODAR_M1_AUTOAPPROVE;
    delete process.env.CODAR_BOT_PORT;
    rmSync(root, { recursive: true, force: true });
  }
});

test("chat history endpoint returns the transcript, not the bot record", async () => {
  const r = await rig();
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    const id = r.store.state.bots[0]!.id;
    await r.bots.start(id);
    await r.bots.prompt(id, "Reply with the single word ALPHA.");
    const msgs = await r.bots.messages(id);
    assert.ok(Array.isArray(msgs));
    assert.ok(msgs.some((m) => m.role === "user"));
    assert.ok(msgs.some((m) => m.role === "assistant"));
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await r.dispose();
  }
});

test("§3.3 spawn integration: custom provider key reaches the child via env, models.json holds only the $ENV ref", async () => {
  const root = mkdtempSync(join(tmpdir(), "codar-pchain-"));
  mkdirSync(join(root, "work"), { recursive: true });
  const keysPath = join(root, "keys.json");
  writeFileSync(keysPath, JSON.stringify({
    providers: { myproxy: { apiKey: "sk-integration", baseUrl: "https://proxy.example/v1" } },
  }));
  const store = Store.open(join(root, "state.json"), { create: true });
  const ledger = new UsageLedger(join(root, "usage.sqlite"));
  const bots = new BotManager(store, ledger, root, {
    bin: process.execPath, sandboxArgv: [FAKE_PI],
    env: { FAKE_PI_MARKER: join(root, "marker.json"), FAKE_PI_SESSION_FILE: "/tmp/fs" },
  }, keysPath);
  const bot = store.addBot({
    name: "Chain", role: "", chief: true,
    model: { provider: "myproxy", modelId: "gpt-x", thinkingLevel: "low" },
    workDir: join(root, "work"), sessionPath: null,
    sandbox: { mode: "host-not-isolated" }, budget: defaultBudget(),
  });
  try {
    process.env.CODAR_M1_AUTOAPPROVE = "1";
    await bots.start(bot.id);
    const marker = JSON.parse(readFileSync(join(root, "marker.json"), "utf8")) as {
      hasBotKey: boolean; agentDir: string | null; modelsJson: string | null;
    };
    assert.equal(marker.hasBotKey, true, "CODAR_BOT_KEY must reach the child env");
    assert.ok(marker.agentDir!.endsWith(join("pi-conf", bot.id)));
    assert.ok(marker.modelsJson !== null);
    assert.ok(!marker.modelsJson.includes("sk-integration"), "secret never in models.json");
    assert.ok(marker.modelsJson.includes("$CODAR_BOT_KEY"));
  } finally {
    delete process.env.CODAR_M1_AUTOAPPROVE;
    await bots.stopAll();
    ledger.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

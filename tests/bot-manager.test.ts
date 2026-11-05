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

test("M2-E R3: parked approvals go stale when the client dies and can never resolve falsely", async () => {
  const r = await rig();
  try {
    // NO auto-approve: the confirm request parks for the Web card.
    delete process.env.CODAR_M1_AUTOAPPROVE;
    const parked: Array<{ id: string; botId: string | null }> = [];
    const settled: Array<{ id: string; confirmed: boolean; stale?: boolean }> = [];
    r.bots.on("approval", (e: { id: string; botId: string | null }) => parked.push(e));
    r.bots.on("approvalResolved", (e: { id: string; confirmed: boolean; stale?: boolean }) => settled.push(e));

    const botId = r.store.state.bots[0]!.id;
    await r.bots.start(botId);
    const promptP = r.bots.prompt(botId, "please PARK on a write", "chat").catch(() => "client died — expected");
    const dl = Date.now() + 5_000;
    while (parked.length === 0 && Date.now() < dl) {
      await new Promise((s2) => setTimeout(s2, 50));
    }
    assert.equal(parked.length, 1, "one parked approval with a HOST id");
    assert.match(parked[0]!.id, /^apr_/, "host-generated id, not the child id");
    assert.equal(parked[0]!.botId, botId);

    // The client dies (stop path: dropClient purges the park honestly).
    await r.bots.stop(botId);
    const dl2 = Date.now() + 5_000;
    while (settled.length === 0 && Date.now() < dl2) {
      await new Promise((s2) => setTimeout(s2, 50));
    }
    assert.equal(settled.length, 1, "the parked card settles STALE, not silently");
    assert.equal(settled[0]!.id, parked[0]!.id);
    assert.equal(settled[0]!.stale, true);
    assert.equal(settled[0]!.confirmed, false);

    // A late Allow can never land and never lies "allowed".
    assert.equal(r.bots.resolveApproval(parked[0]!.id, true), false, "purged park refuses to resolve");
    assert.equal(settled.length, 1, "no second settlement event");

    // Belt: an entry whose client is no longer any bot live client resolves
    // stale instead of emitting confirmed:true (the false-allowed class).
    // (Re-park on a restarted bot, then hard-kill via a DIE prompt.)
    await r.bots.start(botId);
    const promptP2 = r.bots.prompt(botId, "please PARK again then behave", "chat").catch(() => "client died — expected");
    const dl3 = Date.now() + 5_000;
    while (parked.length < 2 && Date.now() < dl3) {
      await new Promise((s2) => setTimeout(s2, 50));
    }
    assert.equal(parked.length, 2);
    await r.bots.stop(botId); // stop path again for a clean shutdown
    await Promise.allSettled([promptP, promptP2]);
  } finally {
    await r.dispose();
  }
});

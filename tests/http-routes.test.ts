/**
 * HTTP route tests — the surface the R1 review flagged as uncovered
 * (messages routing, rooms validation, bot CRUD guards).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Host } from "../src/host/host.js";
import { defaultBudget } from "../src/host/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(HERE, "fixtures/fake-pi.mjs");

async function boot(): Promise<{ root: string; port: number; host: Host; botId: string }> {
  const root = mkdtempSync(join(tmpdir(), "codar-routes-"));
  mkdirSync(join(root, "work"), { recursive: true });
  process.env.CODAR_BOT_HOME = root;
  process.env.CODAR_BOT_PORT = "0";
  process.env.CODAR_M1_AUTOAPPROVE = "1";
  const host = Host.boot({ dataRoot: root, bin: process.execPath, argv: [FAKE_PI] });
  const bot = host.store.addBot({
    name: "Routes", role: "", chief: true,
    model: { provider: "fake", modelId: "f", thinkingLevel: "low" },
    workDir: join(root, "work"), sessionPath: null,
    sandbox: { mode: "host-not-isolated" as const }, budget: defaultBudget(),
  });
  const port = await host.start();
  return { root, port, host, botId: bot.id };
}

async function teardown(host: Host, root: string): Promise<void> {
  await host.shutdown();
  delete process.env.CODAR_BOT_HOME;
  delete process.env.CODAR_BOT_PORT;
  delete process.env.CODAR_M1_AUTOAPPROVE;
  rmSync(root, { recursive: true, force: true });
}

const json = async (port: number, path: string, init?: RequestInit): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, init);

test("GET /bots/:id vs /bots/:id/messages route by action (R1 regression)", async () => {
  const t = await boot();
  try {
    await (await json(t.port, `/api/bots/${t.botId}/start`, { method: "POST" })).json();
    await (await json(t.port, `/api/bots/${t.botId}/prompt`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Reply with the single word ALPHA." }),
    })).json();
    const record = (await (await json(t.port, `/api/bots/${t.botId}`)).json()) as Record<string, unknown>;
    assert.equal(record["name"], "Routes"); // plain GET still returns the record
    const history = (await (await json(t.port, `/api/bots/${t.botId}/messages`)).json()) as {
      messages: Array<{ role: string }>;
    };
    assert.ok(Array.isArray(history.messages));
    assert.ok(history.messages.some((m) => m.role === "assistant"));
  } finally {
    await teardown(t.host, t.root);
  }
});

test("rooms POST validates members/admin/mode/sharedDir and enforces unique names", async () => {
  const t = await boot();
  try {
    const bad1 = await json(t.port, "/api/rooms", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", members: ["bot_missing"], admin: t.botId }),
    });
    assert.equal(bad1.status, 400);
    const bad2 = await json(t.port, "/api/rooms", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", members: [t.botId], admin: t.botId, sharedDir: "relative/path" }),
    });
    assert.equal(bad2.status, 400);
    const ok = await json(t.port, "/api/rooms", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "warroom", members: [t.botId], admin: t.botId }),
    });
    assert.equal(ok.status, 201);
    const dup = await json(t.port, "/api/rooms", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "warroom", members: [t.botId], admin: t.botId }),
    });
    assert.equal(dup.status, 409);
    const rooms = (await (await json(t.port, "/api/rooms")).json()) as Array<{ name: string }>;
    assert.ok(rooms.some((r) => r.name === "warroom"));
  } finally {
    await teardown(t.host, t.root);
  }
});

test("bot CRUD guards: duplicate name 409, docker mode honored, patch immutables 400", async () => {
  const t = await boot();
  try {
    const dup = await json(t.port, "/api/bots", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Routes", workDir: "/tmp/x" }),
    });
    assert.equal(dup.status, 409);
    const docker = await json(t.port, "/api/bots", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Sandboxed", workDir: "/tmp/x", sandbox: { mode: "docker" } }),
    });
    assert.equal(docker.status, 201); // M1-D: the runner landed, docker mode is valid
    const dockerBody = (await docker.json()) as { sandbox: { mode: string } };
    assert.equal(dockerBody.sandbox.mode, "docker", "requested mode must be honored, not downgraded");
    const badMode = await json(t.port, "/api/bots", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "BadMode", workDir: "/tmp/x", sandbox: { mode: "vm" } }),
    });
    assert.equal(badMode.status, 400);
    const patch = await json(t.port, `/api/bots/${t.botId}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chief: true }),
    });
    assert.equal(patch.status, 400);
    const relWork = await json(t.port, "/api/bots", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Rel", workDir: "relative" }),
    });
    assert.equal(relWork.status, 400);
  } finally {
    await teardown(t.host, t.root);
  }
});

test("lower-layer error mapping: bad JSON 400, unknown bot 404, busy/stopped 409 (R4 gap)", async () => {
  const t = await boot();
  try {
    const badJson = await json(t.port, "/api/bots", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
    });
    assert.equal(badJson.status, 400);
    const unknownStart = await json(t.port, "/api/bots/bot_missing/start", { method: "POST" });
    assert.equal(unknownStart.status, 404);
    const stoppedPrompt = await json(t.port, `/api/bots/${t.botId}/prompt`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    assert.equal(stoppedPrompt.status, 409);
    await (await json(t.port, `/api/bots/${t.botId}/start`, { method: "POST" })).json();
    const dupStart = await json(t.port, `/api/bots/${t.botId}/start`, { method: "POST" });
    assert.equal(dupStart.status, 409);
    const badProvider = await json(t.port, "/api/bots", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Evil", workDir: "/tmp/e", model: { provider: "a;b$(rm)", modelId: "x", thinkingLevel: "low" } }),
    });
    assert.equal(badProvider.status, 400);
    const junkDelete = await json(t.port, `/api/bots/${t.botId}/junk`, { method: "DELETE" });
    assert.equal(junkDelete.status, 404);
    // R5: unknown bot on action routes is 404, stopped-but-known stays 409.
    const unknownPrompt = await json(t.port, "/api/bots/bot_missing/prompt", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x" }),
    });
    assert.equal(unknownPrompt.status, 404);
    // PATCH model charset guard REALLY present this time (shared validator).
    const evilPatch = await json(t.port, `/api/bots/${t.botId}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: { provider: "a;b$(rm)", modelId: "../../etc", thinkingLevel: "low" } }),
    });
    assert.equal(evilPatch.status, 400);
    // JSON null body is a 400, not a TypeError 500.
    const nullBody = await json(t.port, "/api/bots", {
      method: "POST", headers: { "content-type": "application/json" }, body: "null",
    });
    assert.equal(nullBody.status, 400);
  } finally {
    await teardown(t.host, t.root);
  }
});

test("provider discovery + chief-derived defaults (v3): POST model default, GET /api/providers, PATCH→start rebuild", async () => {
  const t = await boot();
  try {
    // POST without a model defaults to the CHIEF's model (never a hardcoded
    // provider — the old zai-coding-cn fallback handed strangers a provider
    // they have no key for). boot() seeds chief "Routes" on fake/f/low.
    const created = await json(t.port, "/api/bots", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Defaulted", workDir: join(t.root, "work") }),
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { model: { provider: string; modelId: string; thinkingLevel: string } };
    assert.deepEqual(createdBody.model, { provider: "fake", modelId: "f", thinkingLevel: "low" });

    // GET /api/providers: presets + bots-only provider, no keys.json yet.
    const list1 = (await (await json(t.port, "/api/providers")).json()) as {
      providers: Array<{ id: string; configured: boolean; models: Array<{ id: string }> }>;
    };
    const by1 = (id: string) => list1.providers.find((p) => p.id === id);
    assert.ok(by1("openai") !== undefined && by1("openai")!.configured === false);
    assert.ok(by1("openai")!.models.some((m) => m.id === "gpt-5.4"), "curated pick listed");
    assert.ok(by1("fake") !== undefined, "bots-only provider listed");
    assert.deepEqual(by1("fake")!.models.map((m) => m.id), ["f"]);

    // keys.json written AFTER boot shows up without a restart (per-request
    // loadKeys — same freshness contract as spawns).
    writeFileSync(join(t.root, "keys.json"), JSON.stringify({ providers: { "zai-coding-cn": { apiKey: "k" } } }));
    const list2 = (await (await json(t.port, "/api/providers")).json()) as {
      providers: Array<{ id: string; configured: boolean }>;
    };
    const zai = list2.providers.find((p) => p.id === "zai-coding-cn");
    assert.ok(zai !== undefined && zai.configured === true, "init-added key is live");
    assert.ok(list2.providers.findIndex((p) => p.configured) <= list2.providers.findIndex((p) => p.id === "zai-coding-cn"), "configured sorts first");

    // Malformed keys.json → 500 with the loadKeys message (honest, and the
    // boot-time fail-fast already covered the same validation).
    writeFileSync(join(t.root, "keys.json"), "{broken");
    const bad = await json(t.port, "/api/providers");
    assert.equal(bad.status, 500);

    // PATCH model → start → pi-conf models.json rebuilt for the NEW model
    // (models.json only materializes at start — the "takes effect on next
    // start" contract). Restore a valid keys.json first, then PATCH "Routes"
    // onto a configured relay provider with an explicit model.
    writeFileSync(join(t.root, "keys.json"), JSON.stringify({
      providers: { myrelay: { apiKey: "k-relay", api: "openai-completions", baseUrl: "https://relay.example/v1" } },
    }));
    const patched = await json(t.port, `/api/bots/${t.botId}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: { provider: "myrelay", modelId: "rm-9", thinkingLevel: "low" } }),
    });
    assert.equal(patched.status, 200);
    const started = await json(t.port, `/api/bots/${t.botId}/start`, { method: "POST" });
    assert.equal(started.status, 200);
    const confDoc = JSON.parse(
      readFileSync(join(t.root, "pi-conf", t.botId, "models.json"), "utf8")
    ) as { providers: { myrelay: { baseUrl: string; apiKey: string; models: Array<{ id: string }> } } };
    assert.equal(confDoc.providers.myrelay.baseUrl, "https://relay.example/v1");
    assert.equal(confDoc.providers.myrelay.apiKey, "$CODAR_BOT_KEY");
    assert.equal(confDoc.providers.myrelay.models[0]!.id, "rm-9");
    // stop the started bot so teardown is clean
    await json(t.port, `/api/bots/${t.botId}/stop`, { method: "POST" });
  } finally {
    await teardown(t.host, t.root);
  }
});

test("serveStatic: containment, fallback content-type, malformed encoding (web UI regression)", async () => {
  const root = mkdtempSync(join(tmpdir(), "codar-static-"));
  mkdirSync(join(root, "web-dist", "assets"), { recursive: true });
  mkdirSync(join(root, "web-dist-evil"), { recursive: true });
  writeFileSync(join(root, "web-dist", "index.html"), "<html>ok</html>");
  writeFileSync(join(root, "web-dist", "assets", "app-abc.js"), "console.log(1)");
  writeFileSync(join(root, "web-dist-evil", "secret.txt"), "SECRET");
  const host = Host.boot({
    dataRoot: root,
    bin: process.execPath,
    argv: [FAKE_PI],
    webDir: join(root, "web-dist"),
  });
  try {
    process.env.CODAR_BOT_HOME = root;
    process.env.CODAR_BOT_PORT = "0";
    const port = await host.start();
    const get = async (path: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}${path}`);
    const idx = await get("/");
    assert.equal(idx.status, 200);
    assert.equal(idx.headers.get("content-type"), "text/html; charset=utf-8");
    const asset = await get("/assets/app-abc.js");
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const spa = await get("/chat");
    assert.equal(spa.status, 200);
    assert.equal(spa.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal((await get("/assets/missing.js")).status, 404);
    const evil = await get("/%2e%2e%2fweb-dist-evil%2fsecret.txt");
    assert.equal(evil.status, 404);
    assert.ok(!(await evil.text()).includes("SECRET"));
    assert.equal((await get("/%zz")).status, 400);
    await host.shutdown();
  } finally {
    delete process.env.CODAR_BOT_HOME;
    delete process.env.CODAR_BOT_PORT;
    rmSync(root, { recursive: true, force: true });
  }
});

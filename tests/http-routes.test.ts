/**
 * HTTP route tests — the surface the R1 review flagged as uncovered
 * (messages routing, rooms validation, bot CRUD guards).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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

test("bot CRUD guards: duplicate name 409, docker mode 501, patch immutables 400", async () => {
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

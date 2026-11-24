/**
 * HTTP route tests for the §3.3 entry surface (v0.14, PRD 3.7) — real Host
 * boot (same harness as http-routes.test.ts) + a local mock upstream for the
 * test endpoint. Locked route contracts:
 *  - GET /api/settings/providers: masked echo, zero key material in the BODY
 *  - PUT: 200 + write-on-disk + audit line; invalid payloads 400; nothing is
 *    written when validation rejects
 *  - DELETE: in-use → 409 naming the bots; unused → 200 and the entry is gone
 *  - POST test: stored-values-only composition (entry ?? preset, NO body
 *    overrides — the P1 key-exfil channel); a body-supplied baseUrl must
 *    never be dialed, a stored key must never ride it
 *  - drive-by CSRF guard: cross-origin mutating writes 403 (skipped for
 *    Bearer-authenticated callers, R2-F3)
 *  - chief bootstrap default: POST /api/bots chief:true without workDir gets
 *    <dataRoot>/work (§3.2 Web-wizard parity with init); workers still 400
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Host } from "../src/host/host.js";
import { defaultBudget } from "../src/host/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(HERE, "fixtures/fake-pi.mjs");
const KEY = "sk-route-test-abcdef0123456789";

interface Boot {
  root: string;
  port: number;
  host: Host;
  chiefId: string;
}

async function boot(withChief = true): Promise<Boot> {
  const root = mkdtempSync(join(tmpdir(), "codar-pset-routes-"));
  mkdirSync(join(root, "work"), { recursive: true });
  process.env.CODAR_BOT_HOME = root;
  process.env.CODAR_BOT_PORT = "0";
  process.env.CODAR_M1_AUTOAPPROVE = "1";
  const host = Host.boot({ dataRoot: root, bin: process.execPath, argv: [FAKE_PI] });
  let chiefId = "";
  if (withChief) {
    const chief = host.store.addBot({
      name: "Chief", role: "", chief: true,
      model: { provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "low" },
      workDir: join(root, "work"), sessionPath: null,
      sandbox: { mode: "host-not-isolated" as const }, budget: defaultBudget(),
    });
    chiefId = chief.id;
  }
  const port = await host.start();
  return { root, port, host, chiefId };
}

async function teardown(t: Boot): Promise<void> {
  await t.host.shutdown();
  delete process.env.CODAR_BOT_HOME;
  delete process.env.CODAR_BOT_PORT;
  delete process.env.CODAR_M1_AUTOAPPROVE;
  rmSync(t.root, { recursive: true, force: true });
}

const json = async (port: number, path: string, init?: RequestInit): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, init);
const postJson = (port: number, path: string, body: unknown): RequestInit =>
  ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("GET providers echoes masked; PUT writes key+audit; body never carries the raw key", async () => {
  const t = await boot();
  try {
    const before = await json(t.port, "/api/settings/providers");
    assert.equal(before.status, 200);
    const beforeBody = await before.text();
    assert.ok(!beforeBody.includes(KEY));
    assert.ok(beforeBody.includes("deepseek"), "presets listed");

    const put = await json(t.port, "/api/settings/providers/deepseek", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: KEY }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.text();
    assert.ok(!putBody.includes(KEY), "PUT response must mask the key");
    assert.ok(putBody.includes("sk-…6789"), "PUT response carries the masked echo");

    // On-disk truth: the key landed, merge kept the shape, audit got its line.
    const doc = JSON.parse(readFileSync(join(t.root, "keys.json"), "utf8")) as {
      providers: { deepseek: { apiKey?: string } };
    };
    assert.equal(doc.providers.deepseek?.apiKey, KEY);
    const audit = readFileSync(join(t.root, "audit.jsonl"), "utf8");
    assert.ok(audit.includes('"provider.key.set"'));
    assert.ok(!audit.includes(KEY));

    // Freshness: the DISCOVERY surface sees the new key without a restart
    // (same per-request re-read contract as bot spawns).
    const disc = (await (await json(t.port, "/api/providers")).json()) as {
      providers: Array<{ id: string; configured: boolean }>;
    };
    assert.ok(disc.providers.find((p) => p.id === "deepseek")?.configured);
  } finally {
    await teardown(t);
  }
});

test("PUT validation: bad api / http baseUrl / empty key are 400 and leave the file untouched", async () => {
  const t = await boot();
  try {
    const bad = async (body: Record<string, unknown>): Promise<Response> =>
      json(t.port, "/api/settings/providers/myrelay", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
    assert.equal((await bad({ api: "grpc" })).status, 400);
    assert.equal((await bad({ baseUrl: "http://relay.example.com" })).status, 400);
    assert.equal((await bad({ apiKey: "  " })).status, 400);
    assert.equal((await bad({})).status, 400, "empty patch is nothing to update");
    assert.equal((await bad({ apiKey: 42 })).status, 400, "non-string key type rejected");
    assert.ok(!existsSyncQuiet(join(t.root, "keys.json")) || !readFileSync(join(t.root, "keys.json"), "utf8").includes("myrelay"),
      "rejected writes leave nothing behind");
    const badId = await json(t.port, "/api/settings/providers/bad%20id!", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey: "x-1234567890" }),
    });
    assert.equal(badId.status, 400);
  } finally {
    await teardown(t);
  }
});

function existsSyncQuiet(p: string): boolean {
  try { return readFileSync(p, "utf8").length >= 0; } catch { return false; }
}

test("DELETE: in-use (chief provider or review model) → 409 naming them; unused → 200 + gone", async () => {
  const t = await boot();
  try {
    // Chief runs on deepseek → deepseek is in-use.
    const put = await json(t.port, "/api/settings/providers/deepseek", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: KEY }),
    });
    assert.equal(put.status, 200);
    const del = await json(t.port, "/api/settings/providers/deepseek", { method: "DELETE" });
    assert.equal(del.status, 409);
    const delBody = (await del.json()) as { error: string };
    assert.ok(delBody.error.includes("Chief"), "409 names the in-use bot");

    // reviewModel alone also blocks.
    t.host.store.setReviewModel({ provider: "myrelay", modelId: "r1", thinkingLevel: "low" });
    await json(t.port, "/api/settings/providers/myrelay", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: KEY }),
    });
    const del2 = await json(t.port, "/api/settings/providers/myrelay", { method: "DELETE" });
    assert.equal(del2.status, 409);
    assert.ok(((await del2.json()) as { error: string }).error.includes("memory review"));

    // Unused preset-with-entry → 200 and the entry disappears.
    await json(t.port, "/api/settings/providers/groq", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: KEY }),
    });
    const del3 = await json(t.port, "/api/settings/providers/groq", { method: "DELETE" });
    assert.equal(del3.status, 200);
    const after = (await (await json(t.port, "/api/settings/providers")).json()) as {
      providers: Array<{ id: string; entryPresent: boolean }>;
    };
    assert.equal(after.providers.find((p) => p.id === "groq")?.entryPresent, false);
    // Preset without an entry → nothing to remove → 404.
    const del4 = await json(t.port, "/api/settings/providers/anthropic", { method: "DELETE" });
    assert.equal(del4.status, 404);
  } finally {
    await teardown(t);
  }
});

test("POST test: NO body overrides (P1 regression) — stored-only composition, mock must see zero requests", async () => {
  const t = await boot(false);
  let mockHits = 0;
  let seenAuth: string | null = null;
  const server: Server = createServer((req, res) => {
    mockHits += 1;
    seenAuth = req.headers.authorization ?? null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-model-a" }] }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const addr = server.address();
  const mport = typeof addr === "object" && addr !== null ? addr.port : 0;
  try {
    // P1-1 regression: a body-supplied baseUrl must NEVER pair with the
    // stored key. Save a key, then drive-by-style ask the route to test
    // "myrelay" at the mock (attacker) URL. Expect: zero requests to the
    // mock, honest "no baseUrl" outcome (no stored/preset endpoint).
    await json(t.port, "/api/settings/providers/myrelay", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-saved-1234567890abc" }),
    });
    const r1 = (await (await json(t.port, "/api/settings/providers/myrelay/test", postJson(t.port, "", {
      baseUrl: `http://127.0.0.1:${mport}/v1`, apiKey: "sk-body-override-key-xyz",
    }))).json()) as { ok: boolean; error?: { code: string; message: string } };
    assert.equal(r1.ok, false);
    assert.equal(r1.error?.code, "network");
    assert.match(r1.error?.message ?? "", /no baseUrl/);
    assert.equal(mockHits, 0, "body-supplied baseUrl must not be dialed");
    assert.equal(seenAuth, null, "stored key must not ride a body-supplied URL");

    // Stored endpoint composition works (no body at all). .invalid is a
    // reserved TLD — DNS always fails, so this classifies offline-safe as
    // network without touching the real internet.
    await json(t.port, "/api/settings/providers/myrelay", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://no-such-host.invalid/v1" }),
    });
    const r2 = (await (await json(t.port, "/api/settings/providers/myrelay/test", postJson(t.port, "", {}))).json()) as {
      ok: boolean; error?: { code: string };
    };
    assert.equal(r2.ok, false);
    // DNS behavior differs by environment (a hanging resolver aborts as
    // timeout, a fast NXDOMAIN lands as network) — both mean "did not reach".
    assert.ok(r2.error?.code === "network" || r2.error?.code === "timeout", `unexpected code ${r2.error?.code}`);
    assert.equal(mockHits, 0, "still no request to the unrelated mock");

    // Malformed id → 400 (same charset rule as PUT/DELETE).
    const badId = await json(t.port, "/api/settings/providers/bad%20id!/test", postJson(t.port, "", {}));
    assert.equal(badId.status, 400);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await teardown(t);
  }
});

test("P2-1: hand-edited non-string fields degrade honestly — no 500 anywhere on the surface", async () => {
  const t = await boot(false);
  try {
    writeFileSync(join(t.root, "keys.json"), JSON.stringify({
      providers: { myrelay: { apiKey: 123456, baseUrl: 999, api: 7 } },
    }), "utf8");
    const get = await json(t.port, "/api/settings/providers");
    assert.equal(get.status, 200, "report must not crash on non-string fields");
    const report = (await get.json()) as { providers: Array<{ id: string; keyPresent: boolean; maskedKey: string | null; entryPresent: boolean }> };
    const relay = report.providers.find((p) => p.id === "myrelay")!;
    assert.equal(relay.keyPresent, false, "numeric apiKey reads as unset");
    assert.equal(relay.maskedKey, null);

    const test = await json(t.port, "/api/settings/providers/myrelay/test", postJson(t.port, "", {}));
    assert.equal(test.status, 200, "test route must not crash on non-string entry fields");
    const result = (await test.json()) as { ok: boolean; error?: { code: string } };
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "network");

    // PUT still works over the mangled entry (rewrite with proper strings).
    const put = await json(t.port, "/api/settings/providers/myrelay", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-fixed-1234567890ab", baseUrl: "https://relay.example.com/v1" }),
    });
    assert.equal(put.status, 200);
    const after = (await (await json(t.port, "/api/settings/providers")).json()) as {
      providers: Array<{ id: string; keyPresent: boolean; maskedKey: string | null }>;
    };
    const fixed = after.providers.find((p) => p.id === "myrelay")!;
    assert.equal(fixed.keyPresent, true);
    assert.equal(fixed.maskedKey, "sk-…90ab");
  } finally {
    await teardown(t);
  }
});

test("drive-by CSRF guard: cross-origin mutating writes are 403; same-origin and no-Origin pass", async () => {
  const t = await boot(false);
  try {
    const evil = await fetch(`http://127.0.0.1:${t.port}/api/settings/providers/myrelay`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ apiKey: "sk-evil-1234567890abc" }),
    });
    assert.equal(evil.status, 403, "mismatched Origin on a mutating call must be rejected");
    const jsonOrigin = await fetch(`http://127.0.0.1:${t.port}/api/settings/providers/myrelay`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${t.port}` },
      body: JSON.stringify({ apiKey: "sk-ours-1234567890ab" }),
    });
    assert.equal(jsonOrigin.status, 200, "same-origin UI writes pass");
    const noOrigin = await json(t.port, "/api/settings/providers/groq", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-cli-12345678901abc" }),
    });
    assert.equal(noOrigin.status, 200, "non-browser clients (no Origin header) pass");
    const evilNull = await fetch(`http://127.0.0.1:${t.port}/api/settings/providers/openai`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "null" },
      body: JSON.stringify({ apiKey: "x" }),
    });
    assert.equal(evilNull.status, 403, "null origin (sandboxed frame) is rejected");
  } finally {
    await teardown(t);
  }
});

test("chief bootstrap default: chief without workDir gets <root>/work; worker still 400s", async () => {
  const t = await boot(false); // wizard scenario = fresh install, no chief yet
  try {
    const wizardChief = await json(t.port, "/api/bots", postJson(t.port, "", {
      name: "WizardChief", chief: true,
      model: { provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "low" },
    }));
    assert.equal(wizardChief.status, 201);
    const created = (await wizardChief.json()) as { workDir: string };
    assert.equal(created.workDir, join(t.root, "work"), "workDir defaults to init's choice");

    const worker = await json(t.port, "/api/bots", postJson(t.port, "", {
      name: "NoWorkDir", model: { provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "low" },
    }));
    assert.equal(worker.status, 400, "workers keep the explicit workDir requirement");

    // An explicit chief workDir is honored — but only ONE chief may exist:
    // the single-chief invariant refuses the second creation outright
    // (409), whatever workDir it names.
    const second = await json(t.port, "/api/bots", postJson(t.port, "", {
      name: "SecondChief", chief: true, workDir: "/tmp/elsewhere",
      model: { provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "low" },
    }));
    assert.equal(second.status, 409);
  } finally {
    await teardown(t);
  }
});

test("settings surface rides the CODAR_API_TOKEN gate (write path is not auth-exempt)", async () => {
  const t = await boot();
  try {
    process.env.CODAR_API_TOKEN = "sekrit";
    const noAuth = await json(t.port, "/api/settings/providers/deepseek", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey: KEY }) });
    assert.equal(noAuth.status, 401, "PUT without the token must not pass");
    const withAuth = await json(t.port, "/api/settings/providers/deepseek", {
      method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer sekrit" },
      body: JSON.stringify({ apiKey: KEY }),
    });
    assert.equal(withAuth.status, 200);
    const withQuery = await json(t.port, `/api/settings/providers?token=sekrit`);
    assert.equal(withQuery.status, 200);
  } finally {
    delete process.env.CODAR_API_TOKEN;
    await teardown(t);
  }
});

test("R2-F1: PUT that leaves a mangled non-string apiKey alone must not crash the audit line", async () => {
  const t = await boot(false);
  try {
    writeFileSync(join(t.root, "keys.json"), JSON.stringify({
      providers: { myrelay: { apiKey: 123456 } },
    }), "utf8");
    const put = await json(t.port, "/api/settings/providers/myrelay", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://relay.example.com/v1" }),
    });
    assert.equal(put.status, 200, "unrelated PUT must not die on the preserved numeric apiKey");
    const audit = readFileSync(join(t.root, "audit.jsonl"), "utf8");
    assert.ok(audit.includes('"provider.key.set"'));
    assert.ok(audit.includes('"maskedKey":null'), "mangled key audits as no-usable-key, never crashes");
    const doc = JSON.parse(readFileSync(join(t.root, "keys.json"), "utf8")) as {
      providers: { myrelay: { apiKey?: unknown; baseUrl?: string } };
    };
    assert.equal(doc.providers.myrelay?.apiKey, 123456, "untouched field stays untouched (honest file)");
    assert.equal(doc.providers.myrelay?.baseUrl, "https://relay.example.com/v1");
  } finally {
    await teardown(t);
  }
});

test("R2-F3: Bearer-authenticated callers skip the Origin guard (proxy-host mismatch stays usable)", async () => {
  const t = await boot(false);
  try {
    process.env.CODAR_API_TOKEN = "sekrit";
    // Cross-origin Origin + valid Bearer → the token vouches, no 403.
    const tokened = await fetch(`http://127.0.0.1:${t.port}/api/settings/providers/myrelay`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "https://ui.example.com",
        authorization: "Bearer sekrit",
      },
      body: JSON.stringify({ apiKey: "sk-proxy-123456789abc" }),
    });
    assert.equal(tokened.status, 200, "valid Bearer must not be bricked by a host-mismatched Origin");
    // Cross-origin Origin + wrong Bearer → 401 (auth gate, not the guard).
    const badToken = await fetch(`http://127.0.0.1:${t.port}/api/settings/providers/myrelay`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "https://ui.example.com",
        authorization: "Bearer wrong",
      },
      body: JSON.stringify({ apiKey: "x" }),
    });
    assert.equal(badToken.status, 401);
  } finally {
    delete process.env.CODAR_API_TOKEN;
    await teardown(t);
  }
});

/**
 * provider-settings tests — the §3.3 entry surface (v0.14, PRD 3.7), offline.
 *
 * Locked contracts (each tied to its review-relevant clause):
 *  - masked echo: NO response/report ever carries key material (strong
 *    assertion: serialized output must not contain the raw key anywhere)
 *  - writes are load→merge→writeKeys: sibling fields (entry.models!) and
 *    other providers survive; file lands 0600
 *  - audit lines carry maskedKey at most — audit.jsonl must not contain the
 *    raw key either (same strong assertion as the surface)
 *  - DELETE-side in-use protection is the route's job (needs the store) —
 *    covered in provider-settings-routes.test.ts
 *  - testProvider: one request, no probing; auth/not_found/timeout/network
 *    classification against a local mock upstream; key never appears in any
 *    failure message
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  maskKey,
  providerSettingsReport,
  PROVIDER_APIS,
  removeProvider,
  testProvider,
  upsertProvider,
} from "../src/host/provider-settings.js";
import { loadKeys, PROVIDER_PRESETS } from "../src/host/provider-config.js";
import type { BotRecord, BotModelRef } from "../src/host/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function root(): string {
  return mkdtempSync(join(tmpdir(), "codar-psettings-"));
}

const KEY = "sk-secret-abcdef0123456789";
const OTHER_KEY = "sk-other-9988776655443322";

function fakeBot(provider: string, modelId: string, id = "bot_x", name = id): BotRecord {
  return {
    id, name, role: "", chief: false,
    model: { provider, modelId, thinkingLevel: "low" },
    workDir: "/tmp/w", sessionPath: null,
    sandbox: { mode: "host-not-isolated" }, budget: { maxTokens: 0, maxCostMicros: 0, maxTurns: 0, maxWallMs: 0 },
  };
}

function keysPath(r: string): string {
  return join(r, "keys.json");
}

function auditPath(r: string): string {
  return join(r, "audit.jsonl");
}

// --- maskKey -------------------------------------------------------------------

test("maskKey: ≥16 chars shows prefix+suffix, shorter is all dots (nothing usable leaks)", () => {
  assert.equal(maskKey("sk-prod-1234567890abcdef"), "sk-…cdef");
  assert.equal(maskKey("short"), "••••");
  assert.equal(maskKey("123456789"), "••••");
  assert.equal(maskKey("12345678901"), "••••"); // 11 chars — prefix+suffix would show 7 of 11 (R1 P3-3)
  assert.equal(maskKey("123456789012345"), "••••"); // 15 chars, still below threshold
  assert.equal(maskKey("1234567890123456"), "123…3456"); // exactly 16 crosses over
  assert.equal(maskKey("  spaced-key-1234567890  "), "spa…7890");
});

// --- providerSettingsReport ----------------------------------------------------

test("report: masked echo + in-use bots + entryPresent, and ZERO raw key material in the payload", () => {
  const r = root();
  try {
    writeFileSync(keysPath(r), JSON.stringify({
      providers: {
        deepseek: { apiKey: KEY, models: [{ id: "custom-relay-model", name: "Relay Special" }] },
        myrelay: { baseUrl: "https://relay.example.com/v1" },
      },
    }), "utf8");
    const review: BotModelRef = { provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "low" };
    const report = providerSettingsReport(
      loadKeys(keysPath(r)),
      [fakeBot("deepseek", "deepseek-v4-pro", "bot_a", "Worker A"), fakeBot("openai", "gpt-5.4", "bot_b", "Worker B")],
      review
    );
    // STRONG assertion: no raw key anywhere in the serialized surface.
    const blob = JSON.stringify(report);
    assert.ok(!blob.includes(KEY), "masked report must not contain the raw apiKey");
    assert.ok(!blob.includes(OTHER_KEY), "sanity: fixture keys absent");

    const ds = report.find((e) => e.id === "deepseek")!;
    assert.equal(ds.maskedKey, "sk-…6789");
    assert.equal(ds.keyPresent, true);
    assert.equal(ds.entryPresent, true);
    assert.equal(ds.configured, true);
    assert.equal(ds.baseUrl, PROVIDER_PRESETS.deepseek!.baseUrl); // preset effective, not entry
    assert.equal(ds.baseUrlCustom, false);
    assert.ok(ds.models.some((m) => m.id === "custom-relay-model"), "entry-declared models listed");
    assert.deepEqual(ds.inUse, [
      { kind: "bot", id: "bot_a", name: "Worker A", modelId: "deepseek-v4-pro" },
      { kind: "review", id: null, name: "", modelId: "deepseek-flash" },
    ]);

    const relay = report.find((e) => e.id === "myrelay")!;
    assert.equal(relay.maskedKey, null);
    assert.equal(relay.keyPresent, false);
    assert.equal(relay.baseUrlCustom, true);
    assert.equal(relay.configured, true, "keyless baseUrl relay is configured (discovery semantics)");

    const openai = report.find((e) => e.id === "openai")!;
    assert.equal(openai.entryPresent, false, "preset with no keys.json entry is not deletable");
    assert.equal(openai.maskedKey, null);
    assert.ok(openai.inUse.some((u) => u.kind === "bot" && u.name === "Worker B"));
    assert.ok(!JSON.stringify(report).includes(KEY));
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("report: non-string entry fields (hand-edited keys.json) read as unset, never crash", () => {
  const r = root();
  try {
    writeFileSync(keysPath(r), JSON.stringify({
      providers: { myrelay: { apiKey: 123456, baseUrl: 999, api: 7 } },
    }), "utf8");
    const report = providerSettingsReport(loadKeys(keysPath(r)), [], null);
    const relay = report.find((e) => e.id === "myrelay")!;
    assert.equal(relay.keyPresent, false, "numeric apiKey reads as unset");
    assert.equal(relay.maskedKey, null);
    assert.equal(relay.baseUrlCustom, false);
    assert.equal(relay.apiCustom, false);
    // The serialized surface must not carry the mangled values either.
    const blob = JSON.stringify(report);
    assert.ok(!blob.includes("123456"));
    assert.ok(!blob.includes("999"));
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

// --- upsertProvider ------------------------------------------------------------

test("upsert: preset provider + key only writes the key (preset defaults stay unwritten)", () => {
  const r = root();
  try {
    upsertProvider(keysPath(r), "deepseek", { apiKey: `  ${KEY}  ` }, auditPath(r));
    const doc = loadKeys(keysPath(r));
    assert.equal(doc.providers.deepseek?.apiKey, KEY, "key is trimmed");
    assert.equal(doc.providers.deepseek?.baseUrl, undefined, "no preset echo into the entry");
    assert.equal(doc.providers.deepseek?.api, undefined);
    // Effective view still resolves the preset (spawn parity).
    const report = providerSettingsReport(doc, [], null);
    const ds = report.find((e) => e.id === "deepseek")!;
    assert.equal(ds.baseUrl, PROVIDER_PRESETS.deepseek!.baseUrl);
    assert.equal(ds.maskedKey, "sk-…6789");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("upsert: merge isolation — sibling models survive, other providers untouched", () => {
  const r = root();
  try {
    writeFileSync(keysPath(r), JSON.stringify({
      providers: {
        deepseek: { apiKey: "sk-old-key-1234567890", models: [{ id: "relay-model" }] },
        myrelay: { apiKey: OTHER_KEY, baseUrl: "https://relay.example.com/v1" },
      },
    }), "utf8");
    upsertProvider(keysPath(r), "deepseek", { apiKey: KEY }, auditPath(r));
    const doc = loadKeys(keysPath(r));
    assert.deepEqual(doc.providers.deepseek?.models, [{ id: "relay-model" }], "entry.models preserved");
    assert.equal(doc.providers.deepseek?.apiKey, KEY);
    assert.equal(doc.providers.myrelay?.apiKey, OTHER_KEY, "sibling provider untouched");
    assert.equal(doc.providers.myrelay?.baseUrl, "https://relay.example.com/v1");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("upsert: null/'' clears fields; https enforced; api enum enforced; file lands 0600", () => {
  const r = root();
  try {
    const kp = keysPath(r);
    upsertProvider(kp, "myrelay", { apiKey: KEY, baseUrl: "https://relay.example.com/v1/", api: "anthropic-messages" }, auditPath(r));
    assert.equal(loadKeys(kp).providers.myrelay?.baseUrl, "https://relay.example.com/v1", "trailing slash stripped, path kept");
    assert.equal(loadKeys(kp).providers.myrelay?.api, "anthropic-messages");
    assert.equal(statSync(kp).mode & 0o777, 0o600, "0600 from the first write");

    assert.throws(() => upsertProvider(kp, "myrelay", { baseUrl: "http://relay.example.com" }, auditPath(r)), /https/);
    assert.throws(() => upsertProvider(kp, "myrelay", { baseUrl: "not a url" }, auditPath(r), ));
    assert.throws(() => upsertProvider(kp, "myrelay", { api: "grpc" }, auditPath(r)), /invalid api protocol/);
    assert.throws(() => upsertProvider(kp, "bad id!", { apiKey: KEY }, auditPath(r)), /invalid provider id/);
    assert.throws(() => upsertProvider(kp, "myrelay", { apiKey: "   " }, auditPath(r)), /non-empty/);
    assert.throws(() => upsertProvider(kp, "__proto__", { apiKey: KEY }, auditPath(r)), /invalid provider id/);

    // Explicit clears.
    upsertProvider(kp, "myrelay", { apiKey: null, baseUrl: "", api: null }, auditPath(r));
    const entry = loadKeys(kp).providers.myrelay!;
    assert.equal(entry.apiKey, undefined, "apiKey null clears");
    assert.equal(entry.baseUrl, undefined, "baseUrl '' normalizes to unset");
    assert.equal(entry.api, undefined, "api null clears back to preset default");

    // Audit: present, kinded, masked — never the raw key.
    const audit = readFileSync(auditPath(r), "utf8");
    assert.ok(audit.includes('"provider.key.set"'));
    assert.ok(audit.includes('"maskedKey":"sk-…6789"'));
    assert.ok(!audit.includes(KEY), "audit.jsonl must not contain the raw key");
    assert.ok(!audit.includes(OTHER_KEY));
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

// --- removeProvider ------------------------------------------------------------

test("remove: drops only the target entry, audits kinded, throws on absent/unsafe ids", () => {
  const r = root();
  try {
    const kp = keysPath(r);
    upsertProvider(kp, "deepseek", { apiKey: KEY }, auditPath(r));
    upsertProvider(kp, "myrelay", { apiKey: OTHER_KEY }, auditPath(r));
    removeProvider(kp, "deepseek", auditPath(r));
    const doc = loadKeys(kp);
    assert.equal(doc.providers.deepseek, undefined);
    assert.equal(doc.providers.myrelay?.apiKey, OTHER_KEY, "sibling untouched");
    assert.ok(readFileSync(auditPath(r), "utf8").includes('"provider.key.remove"'));
    assert.throws(() => removeProvider(kp, "deepseek", auditPath(r)), /no entry/);
    assert.throws(() => removeProvider(kp, "__proto__", auditPath(r)), /invalid provider id/);
    assert.ok(!readFileSync(auditPath(r), "utf8").includes(KEY));
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("PROVIDER_APIS is exactly the preset protocol set (single source, no drift)", () => {
  assert.deepEqual([...PROVIDER_APIS].sort(), ["anthropic-messages", "openai-completions", "openai-responses"]);
});

// --- testProvider (local mock upstream) ----------------------------------------

interface MockHit {
  status: number;
  body?: string;
  seen: { authorization: string | null; xApiKey: string | null; anthropicVersion: string | null };
}

// The mock answers on http://127.0.0.1:<port>; testProvider enforces https
// only at the upsert layer, so tests pass the http URL directly as baseUrl.
async function mockServer(handler: (hit: MockHit) => void): Promise<{ baseUrl: string; seen: MockHit["seen"]; close: () => Promise<void> }> {
  const seen: MockHit["seen"] = { authorization: null, xApiKey: null, anthropicVersion: null };
  const server: Server = createServer((req, res) => {
    seen.authorization = req.headers.authorization ?? null;
    seen.xApiKey = (req.headers["x-api-key"] as string | undefined) ?? null;
    seen.anthropicVersion = (req.headers["anthropic-version"] as string | undefined) ?? null;
    const hit: MockHit = { status: 200, seen };
    handler(hit);
    res.writeHead(hit.status, { "content-type": "application/json" });
    res.end(hit.body ?? "");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

test("testProvider: 200 {data:[ids]} → ok + ids; bearer header on completions protocol", async () => {
  const m = await mockServer((hit) => {
    hit.body = JSON.stringify({ data: [{ id: "glm-5.3" }, { id: "glm-5.3-flash" }, "bare-string-id"] });
  });
  try {
    const r = await testProvider({ api: "openai-completions", baseUrl: `${m.baseUrl}/v1`, apiKey: KEY });
    assert.deepEqual(r, { ok: true, models: ["glm-5.3", "glm-5.3-flash", "bare-string-id"] });
    assert.equal(m.seen.authorization, `Bearer ${KEY}`);
  } finally {
    await m.close();
  }
});

test("testProvider: anthropic protocol sends x-api-key + anthropic-version", async () => {
  const m = await mockServer((hit) => {
    hit.body = JSON.stringify({ data: [{ id: "MiniMax-M3" }] });
  });
  try {
    const r = await testProvider({ api: "anthropic-messages", baseUrl: m.baseUrl, apiKey: KEY });
    assert.ok(r.ok);
    assert.equal(m.seen.xApiKey, KEY);
    assert.ok(m.seen.anthropicVersion !== null);
    assert.equal(m.seen.authorization, null);
  } finally {
    await m.close();
  }
});

test("testProvider: classification — 401/403 auth, 404 not_found, other non-ok network", async () => {
  for (const [status, code] of [[401, "auth"], [403, "auth"], [404, "not_found"], [500, "network"], [302, "network"]] as const) {
    const m = await mockServer((hit) => { hit.status = status; hit.body = "nope"; });
    try {
      const r = await testProvider({ baseUrl: m.baseUrl, apiKey: KEY });
      assert.equal(r.ok, false, `HTTP ${status} must fail`);
      if (!r.ok) {
        assert.equal(r.error.code, code, `HTTP ${status} must classify as ${code}`);
        assert.ok(!JSON.stringify(r).includes(KEY), `${status} failure must not echo the key`);
      }
    } finally {
      await m.close();
    }
  }
});

test("testProvider: non-JSON 200 is honest ok-with-empty-list (endpoint + key proven)", async () => {
  const m = await mockServer((hit) => { hit.body = "<html>ok</html>"; });
  try {
    const r = await testProvider({ baseUrl: m.baseUrl });
    assert.deepEqual(r, { ok: true, models: [] });
  } finally {
    await m.close();
  }
});

test("testProvider: timeout and refused connection classify without leaking the key", async () => {
  // Timeout: a server that accepts but never answers, tiny injected timeout.
  const hanging = createServer(() => { /* never respond */ });
  await new Promise<void>((resolveListen) => hanging.listen(0, "127.0.0.1", resolveListen));
  const addr = hanging.address();
  const hport = typeof addr === "object" && addr !== null ? addr.port : 0;
  try {
    const r = await testProvider({ baseUrl: `http://127.0.0.1:${hport}`, apiKey: KEY, timeoutMs: 300 });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "timeout");
      assert.ok(!r.error.message.includes(KEY));
    }
  } finally {
    hanging.close();
  }
  // Refused: a closed port.
  const dead = createServer(() => {});
  await new Promise<void>((resolveListen) => dead.listen(0, "127.0.0.1", resolveListen));
  const daddr = dead.address();
  const dport = typeof daddr === "object" && daddr !== null ? daddr.port : 0;
  await new Promise<void>((done) => dead.close(() => done()));
  const r2 = await testProvider({ baseUrl: `http://127.0.0.1:${dport}`, timeoutMs: 2_000 });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.error.code, "network");

  // No baseUrl at all → network with a fixable message.
  const r3 = await testProvider({ apiKey: KEY });
  assert.deepEqual(r3, { ok: false, error: { code: "network", message: "no baseUrl configured — pick a preset or set one" } });
});

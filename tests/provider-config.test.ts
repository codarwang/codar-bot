/**
 * provider-config unit tests — the §3.3 unified chain (offline).
 *  v2: ONE mechanism (keys.json → models.json with $ENV keys); presets
 *  carry well-known defaults; the pi-built-in env-var path is gone.
 *  v3 (2026-11-16): curation-only registry — pi-known providers with a
 *  catalog hit OMIT the models field so pi's bundled entry serves with
 *  full fidelity (the old generated entry replaced it wholesale and
 *  degraded glm-5.3 to 128k/8192/non-reasoning); PI_CATALOG_IDS is the
 *  spawn decision table; providersReport is the discovery surface.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSpawnConfig,
  loadKeys,
  materializePiConf,
  PI_CATALOG_IDS,
  PROVIDER_PRESETS,
  providersReport,
  renderProviders,
  writeKeys,
  type KeysDoc,
  type ProviderReportEntry,
} from "../src/host/provider-config.js";
import type { BotRecord, BotModelRef } from "../src/host/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PI_DATA = resolve(HERE, "../node_modules/@earendil-works/pi-ai/dist/providers/data");

function root(): string {
  return mkdtempSync(join(tmpdir(), "codar-pconf-"));
}

function fakeBot(provider: string, modelId: string, id = "bot_x"): BotRecord {
  return {
    id, name: id, role: "", chief: false,
    model: { provider, modelId, thinkingLevel: "low" },
    workDir: "/tmp/w", sessionPath: null,
    sandbox: { mode: "host-not-isolated" }, budget: { maxTokens: 0, maxCostMicros: 0, maxTurns: 0, maxWallMs: 0 },
  };
}

test("unified chain: configured pi-known provider with catalog hit OMITS models (glm-5.3 degradation fix)", () => {
  const r = root();
  try {
    // Regression: this exact call used to emit a 128k/8192/non-reasoning
    // replacement entry that pi swapped in over the catalog's 1M/131k
    // reasoning entry — thinkingLevel silently never reached the model.
    const cfg = buildSpawnConfig(
      { providers: { "zai-coding-cn": { apiKey: "k-zai" } } }, r, "bot_1", "zai-coding-cn", "glm-5.3"
    );
    materializePiConf(cfg);
    assert.equal(cfg.env.CODAR_BOT_KEY, "k-zai");
    const doc = JSON.parse(readFileSync(join(cfg.piConfDir, "models.json"), "utf8")) as {
      providers: { "zai-coding-cn": { api: string; baseUrl: string; apiKey: string; models?: unknown } };
    };
    assert.equal(doc.providers["zai-coding-cn"].api, "openai-completions"); // preset applied
    assert.equal(doc.providers["zai-coding-cn"].baseUrl, "https://open.bigmodel.cn/api/coding/paas/v4");
    assert.equal(doc.providers["zai-coding-cn"].apiKey, "$CODAR_BOT_KEY");
    // THE fix: no models field at all — the catalog entry serves verbatim.
    // baseUrl+apiKey must both be present: pi's applyModelsJson throws on a
    // provider block carrying only {api} (provider-composer.js).
    assert.equal("models" in doc.providers["zai-coding-cn"], false, "catalog hit must not emit models");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("rule-2 covers EVERY catalog id, not just curated ones (R3 P2-1)", () => {
  const r = root();
  try {
    // gpt-5.4-pro is NOT in the curated preset (only gpt-5.4/5.4-mini are)
    // but IS in PI_CATALOG_IDS.openai — the catalog must still serve it.
    const cfg = buildSpawnConfig(
      { providers: { openai: { apiKey: "k" } } }, r, "bot_1b", "openai", "gpt-5.4-pro"
    );
    const doc = JSON.parse(cfg.modelsJson!) as { providers: Record<string, Record<string, unknown>> };
    assert.equal("models" in doc.providers.openai!, false, "non-curated catalog id also omits models");
    // non-catalog id on a pi-known provider keeps the minimal entry (rule-3)
    const custom = buildSpawnConfig(
      { providers: { openai: { apiKey: "k" } } }, r, "bot_1c", "openai", "gpt-7-future"
    );
    const customDoc = JSON.parse(custom.modelsJson!) as {
      providers: { openai: { models: Array<{ id: string; contextWindow: number; maxTokens: number }> } };
    };
    const entry = customDoc.providers.openai.models[0]!;
    assert.equal(entry.id, "gpt-7-future");
    assert.equal(entry.contextWindow, 128_000); // honest minimal defaults for an unknown id
    assert.equal(entry.maxTokens, 8_192);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("pi-unknown provider: minimax-anthropic curated entry carries full fields (cost 4-field shape)", () => {
  const r = root();
  try {
    const cfg = buildSpawnConfig(
      { providers: { "minimax-anthropic": { apiKey: "sk-cp-x" } } },
      r, "bot_2", "minimax-anthropic", "MiniMax-M3.1-Flash"
    );
    materializePiConf(cfg);
    const written = readFileSync(join(cfg.piConfDir, "models.json"), "utf8");
    assert.ok(!written.includes("sk-cp-x"), "secret never in models.json");
    const doc = JSON.parse(written) as {
      providers: { "minimax-anthropic": { api: string; baseUrl: string; apiKey: string; models: Array<Record<string, unknown>> } };
    };
    assert.equal(doc.providers["minimax-anthropic"].api, "anthropic-messages");
    assert.equal(doc.providers["minimax-anthropic"].baseUrl, "https://api.minimax.cn/anthropic");
    assert.equal(doc.providers["minimax-anthropic"].apiKey, "$CODAR_BOT_KEY");
    const m = doc.providers["minimax-anthropic"].models[0]!;
    assert.equal(m["id"], "MiniMax-M3.1-Flash");
    // Official CNY prices from the preset land in the generated entry,
    // full 4-field shape (pi's schema rejects partial cost objects).
    assert.deepEqual(m["cost"], { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 });
    assert.equal(m["reasoning"], true);
    assert.equal(m["contextWindow"], 1_000_000);
    assert.equal(m["maxTokens"], 524_288);
    assert.deepEqual(m["input"], ["text", "image"]);
    // entry baseUrl overrides the preset
    const over = buildSpawnConfig(
      { providers: { "minimax-anthropic": { apiKey: "k", baseUrl: "https://proxy.example" } } },
      r, "bot_2b", "minimax-anthropic", "m"
    );
    const overDoc = JSON.parse(over.modelsJson!) as { providers: Record<string, { baseUrl: string }> };
    assert.equal(overDoc.providers["minimax-anthropic"]!.baseUrl, "https://proxy.example");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("entry.models is verbatim (rule-1); empty array = zero upserts; non-array throws", () => {
  const r = root();
  try {
    const explicit = buildSpawnConfig(
      { providers: { myrelay: { apiKey: "k", models: [{ id: "m-1", name: "M One" }] } } },
      r, "bot_3", "myrelay", "m-1"
    );
    const doc = JSON.parse(explicit.modelsJson!) as { providers: { myrelay: { models: Array<{ id: string; name: string }> } } };
    assert.equal(doc.providers.myrelay.models[0]!.name, "M One"); // verbatim, not regenerated
    // [] is a legal declaration: catalog (if any) serves + apiKey injected.
    const empty = buildSpawnConfig(
      { providers: { openai: { apiKey: "k", models: [] } } }, r, "bot_3b", "openai", "gpt-5.4"
    );
    const emptyDoc = JSON.parse(empty.modelsJson!) as { providers: { openai: { models: unknown[]; apiKey: string } } };
    assert.deepEqual(emptyDoc.providers.openai.models, []);
    assert.equal(emptyDoc.providers.openai.apiKey, "$CODAR_BOT_KEY");
    // A non-array used to iterate per-character (string) or die inside pi's
    // upsert loop — reject with a fixable name instead.
    assert.throws(
      () => buildSpawnConfig({ providers: { myrelay: { apiKey: "k", models: "m-1" } } }, r, "bot_3c", "myrelay", "m-1"),
      /models must be an array/,
    );
    assert.throws(
      () => buildSpawnConfig({ providers: { myrelay: { apiKey: "k", models: { id: "x" } } } }, r, "bot_3d", "myrelay", "x"),
      /models must be an array/,
    );
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("materialization invalidates pi's stale catalog cache (models-store.json)", () => {
  const r = root();
  try {
    const cfg = buildSpawnConfig(
      { providers: { "minimax-anthropic": { apiKey: "k" } } },
      r, "bot_c", "minimax-anthropic", "MiniMax-M3.1-Flash"
    );
    mkdirSync(cfg.piConfDir, { recursive: true });
    // A stale store from the bot's previous provider era.
    writeFileSync(join(cfg.piConfDir, "models-store.json"), '{"zai-coding-cn":{}}');
    materializePiConf(cfg);
    assert.ok(!existsSync(join(cfg.piConfDir, "models-store.json")), "stale store must be dropped");
    assert.ok(existsSync(join(cfg.piConfDir, "models.json")));
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("unconfigured provider: bare spawn (no models.json written)", () => {
  const r = root();
  try {
    const cfg = buildSpawnConfig({ providers: {} }, r, "bot_4", "unknown", "m");
    assert.deepEqual(cfg.env, {});
    assert.equal(cfg.modelsJson, null);
    assert.ok(!existsSync(join(cfg.piConfDir, "models.json")));
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("keys.json: round-trip 0600, malformed providers shapes rejected (null/array/entry-null)", () => {
  const r = root();
  try {
    const p = join(r, "keys.json");
    writeKeys(p, { providers: { openai: { apiKey: "sk-1" } } });
    assert.deepEqual(loadKeys(p).providers.openai, { apiKey: "sk-1" });
    writeFileSync(p, "{broken");
    assert.throws(() => loadKeys(p), /not valid JSON/);
    writeFileSync(p, JSON.stringify({ providers: null }));
    assert.throws(() => loadKeys(p), /must be \{providers/);
    writeFileSync(p, JSON.stringify({ providers: [] }));
    assert.throws(() => loadKeys(p), /must be \{providers/);
    writeFileSync(p, JSON.stringify({ providers: { x: null } }));
    assert.throws(() => loadKeys(p), /providers\.x must be an object/);
    assert.deepEqual(loadKeys(join(r, "absent.json")), { providers: {} });
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("registry integrity: PI_CATALOG_IDS ⊆ pinned pi catalog (set diff), keys are baseUrl presets, ids pass SAFE_ID", () => {
  // The frozen table is hand-maintained against the PINNED pi version —
  // a ghost id (typo, stale from an older pi) would pass SAFE_ID checks but
  // rule-2 would omit its entry and spawn would fail "model not found".
  // Diff against the installed pi-ai catalog data (pin-resolved, offline).
  for (const [provider, ids] of Object.entries(PI_CATALOG_IDS)) {
    const preset = PROVIDER_PRESETS[provider];
    assert.ok(preset !== undefined, `${provider}: table key must be a preset (piKnown derived from table)`);
    assert.ok(preset.baseUrl !== undefined, `${provider}: pi-known preset needs a baseUrl (rule-2 provider block)`);
    const catalogFile = join(PI_DATA, `${provider}.json`);
    const catalog = JSON.parse(readFileSync(catalogFile, "utf8")) as Record<string, Record<string, { id: string }>>;
    const catalogIds = new Set<string>();
    for (const group of Object.values(catalog)) {
      for (const [key, m] of Object.entries(group)) {
        if (key.startsWith("chat:")) catalogIds.add(m.id);
      }
    }
    for (const id of ids) {
      assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, `${provider}/${id}: SAFE_ID`);
      assert.ok(catalogIds.has(id), `${provider}/${id}: in frozen table but NOT in pinned pi catalog`);
    }
    // And the safe-compliant catalog ids must ALL be in the table (groq's
    // slash ids are the only expected dropouts).
    const safeCatalog = [...catalogIds].filter((id) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id));
    assert.deepEqual(
      [...ids].sort(),
      safeCatalog.sort(),
      `${provider}: frozen table must equal the SAFE_ID catalog id set`,
    );
    // B3: rule-2 correctness also depends on endpoint parity — the provider
    // block's baseUrl OVERWRITES every catalog entry's (provider-composer),
    // so a preset baseUrl drift would silently repoint catalog-served models
    // while every id-based test stays green. Lock baseUrl AND api protocol.
    const catalogBaseUrls = new Set<string>();
    const catalogApis = new Set<string>();
    for (const [api, group] of Object.entries(catalog)) {
      catalogApis.add(api);
      for (const m of Object.values(group)) catalogBaseUrls.add((m as { baseUrl?: string }).baseUrl ?? "");
    }
    assert.ok(catalogBaseUrls.has(preset.baseUrl!), `${provider}: preset baseUrl matches the catalog endpoint`);
    assert.ok(catalogApis.has(preset.api), `${provider}: preset api is the catalog's protocol (${[...catalogApis].join(",")})`);
  }
  for (const name of ["anthropic", "openai", "minimax-anthropic", "zai-coding-cn", "minimax-cn", "groq", "openrouter", "deepseek"]) {
    assert.ok(Object.hasOwn(PROVIDER_PRESETS, name), `preset ${name}`);
    const preset = PROVIDER_PRESETS[name]!;
    assert.ok(typeof preset.label === "string" && preset.label !== "", `${name}: label`);
    for (const m of preset.models) {
      assert.ok(typeof m.id === "string" && m.id !== "" && typeof m.name === "string", `${name}/${m.id}: id+name`);
      if (m.cost !== undefined) {
        assert.deepEqual(Object.keys(m.cost).sort(), ["cacheRead", "cacheWrite", "input", "output"], `${name}/${m.id}: 4-field cost`);
      }
    }
    // curated picks on pi-known providers must be catalog ids (they are the
    // UI's advertised models; a non-catalog curated id would mislead).
    if (Object.hasOwn(PI_CATALOG_IDS, name)) {
      for (const m of preset.models) {
        assert.ok(PI_CATALOG_IDS[name]!.includes(m.id), `${name}/${m.id}: curated but not in catalog table`);
      }
    }
  }
  // openai protocol switch is deliberate (v3) — lock it.
  assert.equal(PROVIDER_PRESETS.openai!.api, "openai-responses");
  // minimax-cn/openrouter deliberately cannot ride the catalog.
  assert.equal(Object.hasOwn(PI_CATALOG_IDS, "minimax-cn"), false);
  assert.equal(Object.hasOwn(PI_CATALOG_IDS, "openrouter"), false);
});

test("providersReport: union of keys/presets/in-use, ordering, configured semantics, SAFE_ID filtering", () => {
  const keys: KeysDoc = {
    providers: {
      "zai-coding-cn": { apiKey: "k" },
      relay: { baseUrl: "https://relay.example" }, // keyless explicit relay = configured (deliberate)
      dirty: { apiKey: "" }, // entry with empty key → NOT configured, still listed
      // malformed models shapes must not crash or pollute:
      weird: { apiKey: "k", models: "not-an-array" },
    },
  };
  const bots = [fakeBot("zai-coding-cn", "glm-5.3"), fakeBot("ghost-prov", "ghost-model", "bot_g")];
  const reviewModel: BotModelRef = { provider: "review-only", modelId: "rm-1", thinkingLevel: "low" };
  const report = providersReport(keys, bots, reviewModel);
  const by = (id: string): ProviderReportEntry | undefined => report.find((p) => p.id === id);

  // union: presets ∪ keys ∪ bots ∪ reviewModel — bots-only and review-only
  // providers get entries so the edit UI can always represent current values.
  assert.ok(by("ghost-prov") !== undefined, "bots-only provider gets an entry");
  assert.ok(by("review-only") !== undefined, "reviewModel provider gets an entry");
  assert.ok(by("relay") !== undefined);
  // configured semantics
  assert.equal(by("zai-coding-cn")!.configured, true);
  assert.equal(by("relay")!.configured, true, "keyless relay with explicit baseUrl is configured");
  assert.equal(by("dirty")!.configured, false);
  assert.equal(by("openai")!.configured, false, "preset without key");
  // models merge: curated preset picks + entry.models ids + in-use ids
  const zai = by("zai-coding-cn")!;
  assert.deepEqual(zai.models.map((m) => m.id), ["glm-5.3", "glm-5.3-flash"]); // curated, in-use glm-5.3 deduped
  const ghost = by("ghost-prov")!;
  assert.deepEqual(ghost.models.map((m) => m.id), ["ghost-model"]);
  assert.deepEqual(by("review-only")!.models.map((m) => m.id), ["rm-1"]);
  // weird's non-array models contributes nothing; entry-array string ids work
  assert.deepEqual(by("weird")!.models, []);
  // ordering: configured first, stable alphabetical within groups
  const configuredFlags = report.map((p) => p.configured);
  const firstUnconfigured = configuredFlags.indexOf(false);
  assert.ok(firstUnconfigured === -1 || configuredFlags.slice(firstUnconfigured).every((f) => f === false), "configured entries sort first");
  // SAFE_ID: a slash in-use model id is filtered (POST/PATCH reject it anyway)
  const slashy = providersReport({ providers: {} }, [fakeBot("groq", "openai/gpt-oss-120b", "bot_s")], null);
  assert.deepEqual(slashy.find((p) => p.id === "groq")!.models.map((m) => m.id), []);
  // renderProviders smoke — strict: the ✓/× markers must actually render
  // for a configured and an unconfigured entry respectively.
  const text = renderProviders(report);
  assert.match(text, /✓ zai-coding-cn/);
  assert.match(text, /×\s+openai/);
  assert.ok(renderProviders([]).includes("no providers configured"));
});

test("catalog-name collision is locked behavior (minimax-cn: generated entry deliberately replaces the catalog's, B5)", () => {
  const r = root();
  try {
    // minimax-cn deliberately rides the generated-entry path (its catalog
    // lives on a different API face — see PI_CATALOG_IDS note). Pin the
    // semantics: MiniMax-M3 IS a catalog id there, and we still emit an
    // entry — openai-completions on the /v1 endpoint, self-consistent.
    const cfg = buildSpawnConfig(
      { providers: { "minimax-cn": { apiKey: "k" } } }, r, "bot_mm", "minimax-cn", "MiniMax-M3"
    );
    const doc = JSON.parse(cfg.modelsJson!) as {
      providers: { "minimax-cn": { api: string; baseUrl: string; models: Array<{ id: string }> } };
    };
    assert.equal(doc.providers["minimax-cn"].api, "openai-completions");
    assert.equal(doc.providers["minimax-cn"].baseUrl, "https://api.minimaxi.com/v1");
    assert.equal(doc.providers["minimax-cn"].models[0]!.id, "MiniMax-M3");
    // And a user-named provider colliding with a NON-preset catalog provider
    // (e.g. "google") takes the same generated path — documented residue.
    const custom = buildSpawnConfig(
      { providers: { google: { apiKey: "k", api: "google-generative-ai", baseUrl: "https://example.invalid/v1" } } },
      r, "bot_gg", "google", "gemini-x"
    );
    const customDoc = JSON.parse(custom.modelsJson!) as { providers: { google: { models: Array<{ id: string }> } } };
    assert.equal(customDoc.providers.google.models[0]!.id, "gemini-x");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("registry models stay out of keys.json round-trips (no modelPrices resurrection)", () => {
  const r = root();
  try {
    const p = join(r, "keys.json");
    writeKeys(p, { providers: { openai: { apiKey: "sk-1", api: "anthropic-messages" } } });
    // Whatever lands in keys.json is credential/config only — the registry
    // (presets, catalog table) never persists into it.
    const doc = JSON.parse(readFileSync(p, "utf8")) as KeysDoc;
    assert.deepEqual(doc.providers.openai, { apiKey: "sk-1", api: "anthropic-messages" });
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

/**
 * provider-config unit tests — the §3.3 unified chain (offline).
 *  v2: ONE mechanism (keys.json → models.json with $ENV keys); presets
 *  carry well-known defaults; the pi-built-in env-var path is gone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSpawnConfig,
  loadKeys,
  materializePiConf,
  PROVIDER_PRESETS,
  writeKeys,
  type PresetModelPrice,
} from "../src/host/provider-config.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "codar-pconf-"));
}

test("unified chain: EVERY configured provider gets a models.json with the $ENV key ref", () => {
  const r = root();
  try {
    // A pi-known provider name — used to take the env-var path, now rides
    // the same models.json chain as everything else.
    const cfg = buildSpawnConfig(
      { providers: { anthropic: { apiKey: "sk-ant-1" } } }, r, "bot_1", "anthropic", "claude-sonnet-4-5"
    );
    materializePiConf(cfg);
    assert.equal(cfg.env.CODAR_BOT_KEY, "sk-ant-1");
    const doc = JSON.parse(readFileSync(join(cfg.piConfDir, "models.json"), "utf8")) as {
      providers: { anthropic: { api: string; baseUrl: string; apiKey: string; models: unknown[] } };
    };
    assert.equal(doc.providers.anthropic.api, "anthropic-messages"); // preset applied
    assert.equal(doc.providers.anthropic.baseUrl, "https://api.anthropic.com");
    assert.equal(doc.providers.anthropic.apiKey, "$CODAR_BOT_KEY");
    assert.equal(doc.providers.anthropic.models.length, 1);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("custom anthropic-protocol endpoint: minimax-anthropic preset + entry overrides", () => {
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
      providers: { "minimax-anthropic": { api: string; baseUrl: string; apiKey: string; models: Array<{ id: string }> } };
    };
    assert.equal(doc.providers["minimax-anthropic"].api, "anthropic-messages");
    assert.equal(doc.providers["minimax-anthropic"].baseUrl, "https://api.minimax.cn/anthropic");
    assert.equal(doc.providers["minimax-anthropic"].apiKey, "$CODAR_BOT_KEY");
    assert.equal(doc.providers["minimax-anthropic"].models[0]!.id, "MiniMax-M3.1-Flash");
    // Official CNY prices from the preset land in the generated entry.
    assert.deepEqual(
      (doc.providers["minimax-anthropic"].models[0] as unknown as { cost?: PresetModelPrice }).cost,
      { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 },
    );
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

test("explicit entry fields beat presets (api/baseUrl); unknown providers default openai-completions", () => {
  const r = root();
  try {
    const cfg = buildSpawnConfig(
      { providers: { myrelay: { apiKey: "k", api: "anthropic-messages" } } },
      r, "bot_3", "myrelay", "m-1"
    );
    const doc = JSON.parse(cfg.modelsJson!) as { providers: { myrelay: { api: string; models: Array<{ id: string }> } } };
    assert.equal(doc.providers.myrelay.api, "anthropic-messages");
    assert.equal(doc.providers.myrelay.models[0]!.id, "m-1"); // generated entry
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

test("keys.json round-trip 0600 + malformed rejection; presets cover the well-known set", () => {
  const r = root();
  try {
    const p = join(r, "keys.json");
    writeKeys(p, { providers: { openai: { apiKey: "sk-1" } } });
    assert.deepEqual(loadKeys(p).providers.openai, { apiKey: "sk-1" });
    writeFileSync(p, "{broken");
    assert.throws(() => loadKeys(p), /not valid JSON/);
    assert.deepEqual(loadKeys(join(r, "absent.json")), { providers: {} });
    for (const name of ["anthropic", "openai", "minimax-anthropic", "zai-coding-cn"]) {
      assert.ok(Object.hasOwn(PROVIDER_PRESETS, name), `preset ${name}`);
    }
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

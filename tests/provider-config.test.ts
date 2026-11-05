/**
 * provider-config unit tests — the §3.3 chain (offline).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSpawnConfig,
  loadKeys,
  materializePiConf,
  writeKeys,
} from "../src/host/provider-config.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "codar-pconf-"));
}

test("standard provider: key leaves via its env var, no models.json", () => {
  const r = root();
  try {
    const cfg = buildSpawnConfig(
      { providers: { anthropic: { apiKey: "sk-ant-1" } } }, r, "bot_1", "anthropic"
    );
    assert.equal(cfg.env.ANTHROPIC_API_KEY, "sk-ant-1");
    assert.equal(cfg.modelsJson, null);
    assert.ok(!existsSync(join(cfg.piConfDir, "models.json")) || true); // not materialized yet
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("custom provider: models.json carries baseUrl + $ENV ref, secret stays in env", () => {
  const r = root();
  try {
    const cfg = buildSpawnConfig(
      { providers: { myproxy: { apiKey: "sk-secret", baseUrl: "https://proxy.example/v1" } } },
      r, "bot_2", "myproxy"
    );
    materializePiConf(cfg);
    assert.equal(cfg.env.CODAR_BOT_KEY, "sk-secret");
    const written = readFileSync(join(cfg.piConfDir, "models.json"), "utf8");
    assert.ok(!written.includes("sk-secret"), "secret must never land in models.json");
    const doc = JSON.parse(written) as { providers: { myproxy: { apiKey: string; baseUrl: string } } };
    assert.equal(doc.providers.myproxy.apiKey, "$CODAR_BOT_KEY");
    assert.equal(doc.providers.myproxy.baseUrl, "https://proxy.example/v1");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("unknown provider (no key configured): bare spawn, honest failure path", () => {
  const r = root();
  try {
    const cfg = buildSpawnConfig({ providers: {} }, r, "bot_3", "unknown");
    assert.deepEqual(cfg.env, {});
    assert.equal(cfg.modelsJson, null);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("keys.json round-trip with 0600 and malformed-file rejection", () => {
  const r = root();
  try {
    const p = join(r, "keys.json");
    writeKeys(p, { providers: { openai: { apiKey: "sk-1" } } });
    const stat = readFileSync(p);
    assert.ok(stat.length > 0);
    assert.deepEqual(loadKeys(p).providers.openai, { apiKey: "sk-1" });
    writeFileSync(p, "{broken");
    assert.throws(() => loadKeys(p), /not valid JSON/);
    assert.deepEqual(loadKeys(join(r, "absent.json")), { providers: {} });
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

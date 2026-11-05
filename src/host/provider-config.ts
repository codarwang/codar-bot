/**
 * provider-config — the §3.3 key/config chain (v2, unified).
 *
 * ONE mechanism: codar-bot's own provider registry (keys.json, 0600, atomic
 * tmp+rename) → per-bot pi-conf/models.json with `$ENV` interpolated keys
 * (the pi public config surface; M0-S3/S4-proven). There is deliberately NO
 * "ride pi's built-in provider" path anymore: pi is version-pinned (A7), so
 * its bundled catalog never auto-updates — the branch only added confusion
 * between two credential sources (design decision, Felix 2026-11-05).
 *
 * PRESETS carry well-known provider defaults (api protocol + baseUrl); a
 * keys.json entry overrides any preset field. Providers pi natively knows
 * (e.g. zai-coding-cn) still merge pi's own catalog beneath our overrides —
 * unknown providers MUST ship a models array, which the host generates from
 * the bot's requested modelId (minimal honest entry: no invented prices —
 * cost stays 0 and the budget layer degrades to token-budget, §4).
 */
import { readFileSync, openSync, closeSync, writeSync, renameSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { botPiConfDir } from "./paths.js";

export interface ProviderEntry {
  apiKey?: string;
  baseUrl?: string;
  /** pi KnownApi protocol; defaults to the preset's, else openai-completions. */
  api?: string;
  models?: unknown;
}

export interface KeysDoc {
  providers: Record<string, ProviderEntry>;
}

/** Per-model catalog prices for providers pi does NOT know natively.
 *  CURRENCY NOTE: pi cost = whatever currency the catalog author uses —
 *  these are the provider's OWN list prices (CNY per 1M tokens for the
 *  CN providers below). The ledger records catalog-currency micros; the
 *  UI must stay currency-neutral (multi-currency budgets are M2 backlog).
 *  Sources are the providers' pricing pages; verify before relying on
 *  them for hard budget stops. */
export interface PresetModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Well-known provider presets — the only "built-ins" codar has, and they
 *  live in OUR config layer, not pi's. Entry fields always win. */
export const PROVIDER_PRESETS: Record<
  string,
  { api: string; baseUrl?: string; modelPrices?: Record<string, PresetModelPrice> }
> = {
  anthropic: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
  openai: { api: "openai-completions", baseUrl: "https://api.openai.com/v1" },
  "openrouter": { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
  deepseek: { api: "openai-completions", baseUrl: "https://api.deepseek.com" },
  "zai-coding-cn": { api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
  "minimax-anthropic": {
    api: "anthropic-messages",
    baseUrl: "https://api.minimax.cn/anthropic",
    // Official pricing page (platform.minimax.cn/docs/pricing/overview),
    // CNY per 1M tokens, fetched 2026-11-05.
    modelPrices: { "MiniMax-M3.1-Flash": { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 } },
  },
  "minimax-cn": { api: "openai-completions", baseUrl: "https://api.minimaxi.com/v1" },
  "groq": { api: "openai-completions", baseUrl: "https://api.groq.com/openai/v1" },
};

function ownEntry(doc: KeysDoc, provider: string): ProviderEntry | undefined {
  // Prototype-chain safe: "constructor"/"__proto__" as provider names must
  // not resolve to inherited properties.
  return Object.hasOwn(doc.providers, provider) ? doc.providers[provider] : undefined;
}

export function loadKeys(keysPath: string): KeysDoc {
  if (!existsSync(keysPath)) return { providers: {} };
  let doc: KeysDoc;
  try {
    doc = JSON.parse(readFileSync(keysPath, "utf8")) as KeysDoc;
  } catch (error) {
    throw new Error(`server config error: keys.json at ${keysPath} is not valid JSON (${String(error).slice(0, 120)})`);
  }
  if (typeof doc !== "object" || doc === null || typeof doc.providers !== "object") {
    throw new Error("server config error: keys.json must be {providers: {...}}");
  }
  return doc;
}

/** Atomic persistence with 0600 from the first byte (tmp → write → rename). */
export function writeKeys(keysPath: string, doc: KeysDoc): void {
  const tmp = `${keysPath}.tmp-${randomUUID().slice(0, 6)}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(doc, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, keysPath);
}

export interface BotSpawnConfig {
  /** env additions for the child (the provider key). */
  env: Record<string, string>;
  /** models.json content for the bot's pi-conf dir (null only when the
   *  provider has NO entry in keys.json — an honest bare spawn). */
  modelsJson: string | null;
  piConfDir: string;
}

/** Resolve a bot's provider spawn config from keys.json (§3.3 unified). */
export function buildSpawnConfig(
  keys: KeysDoc,
  dataRoot: string,
  botId: string,
  provider: string,
  modelId: string
): BotSpawnConfig {
  const piConfDir = botPiConfDir(dataRoot, botId);
  const entry = ownEntry(keys, provider);
  const env: Record<string, string> = {};
  if (entry === undefined) {
    // No credentials configured — spawn bare; auth fails inside the child
    // and surfaces through bot_failed (honest failure, no silent fallback
    // to some other credential source).
    return { env, modelsJson: null, piConfDir };
  }
  const preset = Object.hasOwn(PROVIDER_PRESETS, provider) ? PROVIDER_PRESETS[provider] : undefined;
  const api = entry.api ?? preset?.api ?? "openai-completions";
  const baseUrl = entry.baseUrl ?? preset?.baseUrl;
  const keyPresent = typeof entry.apiKey === "string" && entry.apiKey !== "";
  if (keyPresent) env.CODAR_BOT_KEY = entry.apiKey!;
  const modelsDoc = {
    providers: {
      [provider]: {
        api,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(keyPresent ? { apiKey: "$CODAR_BOT_KEY" } : {}),
        // Explicit models for providers pi does not natively know; for
        // pi-known providers the entry merges over pi's own catalog.
        ...(entry.models !== undefined
          ? { models: entry.models }
          : { models: [{
              id: modelId,
              name: modelId,
              input: ["text"],
              contextWindow: 128_000,
              maxTokens: 8_192,
              type: "chat",
              // Preset price when we have one (provider's own list prices);
              // otherwise NO cost is invented: unpriced models report cost 0
              // and the budget layer degrades to token-budget (§4).
              ...(preset?.modelPrices !== undefined && Object.hasOwn(preset.modelPrices, modelId)
                ? { cost: preset.modelPrices[modelId] } // FULL 4-field shape: pi's schema rejects partial cost objects
                : {}),
            }] }),
      },
    },
  };
  return { env, modelsJson: JSON.stringify(modelsDoc, null, 2), piConfDir };
}

/** Materialize a bot's pi-conf dir for spawn (idempotent; atomic writes). */
export function materializePiConf(cfg: BotSpawnConfig): void {
  mkdirSync(cfg.piConfDir, { recursive: true });
  if (cfg.modelsJson !== null) {
    const target = join(cfg.piConfDir, "models.json");
    const tmp = `${target}.tmp-${randomUUID().slice(0, 6)}`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, `${cfg.modelsJson}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } else {
    // A bare spawn (provider has no keys.json entry) must not inherit the
    // PREVIOUS provider's conf from this dir — stale files fail confusingly
    // instead of honestly (M2-D R2 P3-4).
    try {
      unlinkSync(join(cfg.piConfDir, "models.json"));
    } catch {
      /* absent */
    }
  }
  // pi caches fetched catalogs in models-store.json INSIDE the agent dir; a
  // stale store (e.g. from an earlier provider on this bot) shadows the
  // regenerated models.json — "model not found" on the new provider. Our
  // models.json is the per-spawn source of truth: drop the cache and let pi
  // rebuild it (found in real dual-provider use, 2026-11-05).
  try {
    unlinkSync(join(cfg.piConfDir, "models-store.json"));
  } catch {
    /* absent — nothing to invalidate */
  }
}

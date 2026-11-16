/**
 * provider-config — the §3.3 key/config chain (v2, unified; v3 curation).
 *
 * ONE mechanism: codar-bot's own provider registry (keys.json, 0600, atomic
 * tmp+rename) → per-bot pi-conf/models.json with `$ENV` interpolated keys
 * (the pi public config surface; M0-S3/S4-proven). There is deliberately NO
 * "ride pi's built-in provider" path anymore: pi is version-pinned (A7), so
 * its bundled catalog never auto-updates — the branch only added confusion
 * between two credential sources (design decision, Felix 2026-11-05).
 *
 * v3 (2026-11-16, devin-audited plan v5): the registry is CURATION-ONLY for
 * pi-known providers — we maintain "which model ids to recommend" (and the
 * PI_CATALOG_IDS spawn-decision table below), never a copy of catalog data.
 * pi merges models.json same-id entries by FULL REPLACEMENT
 * (provider-composer.js: `models[existingIndex] = model`, defaults
 * `reasoning:false` / `contextWindow:128000`), so any generated entry we
 * emit for a catalog model silently degrades it — glm-5.3 shipped degraded
 * (128k/8192/non-reasoning) until this table stopped emitting entries for
 * catalog hits. Unknown providers MUST ship a models array, which the host
 * generates from the bot's requested modelId (minimal honest entry: no
 * invented prices — cost stays 0 and the budget layer degrades to
 * token-budget, §4).
 */
import { readFileSync, openSync, closeSync, writeSync, renameSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { botPiConfDir } from "./paths.js";
import type { BotRecord, BotModelRef } from "./store.js";

/** Shared id charset — one definition for keys.json provider ids, preset
 *  model ids, and the HTTP validateModel checks (init used to carry a
 *  drifted literal copy; a third copy was one refactor away). */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** pi ThinkingLevel (pi-agent-core types.d.ts) — init validates against
 *  this so a bad flag fails at entry, not at spawn. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

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

/** A curated (recommended) model in a preset. For pi-known providers this
 *  is UI-only metadata (id/name/badge) — the spawn path never copies catalog
 *  data (PI_CATALOG_IDS decides that). The extended fields are consumed
 *  ONLY when generating models.json entries for pi-UNKNOWN providers
 *  (minimax-anthropic, custom relays) where the entry is the model's sole
 *  source of truth. */
export interface PresetModel {
  id: string;
  name: string;
  /** UI hint: "flagship" | "fast" | "budget" */
  badge?: string;
  // --- entry-generation fields (pi-unknown providers only) ---
  contextWindow?: number;
  maxTokens?: number;
  cost?: PresetModelPrice;
  reasoning?: boolean;
  input?: string[];
}

/** Spawn decision table: chat model ids per provider that pi 1.5.0's BUNDLED
 *  catalog serves. Generated from
 *  @earendil-works/pi-ai/dist/providers/data/<provider>.json (chat: entries,
 *  SAFE_ID-filtered) on 2026-11-16 — REGENERATE on every pi version bump
 *  (A7 regression gate). Zero runtime dependency on pi files: this frozen
 *  copy is the source. A provider key here means our preset baseUrl matches
 *  the catalog's, so rule-2 (no generated entry) lets the catalog entry
 *  serve with full fidelity (reasoning/thinkingLevelMap/tiers/compat).
 *  minimax-cn is deliberately absent: its catalog lives at
 *  api.minimaxi.com/anthropic (anthropic-messages) while our preset points
 *  at /v1 (openai-completions) — provider-block baseUrl overwrites catalog
 *  baseUrl, so the two cannot coexist; it keeps the generated-entry path.
 *  openrouter is absent (aggregator; nearly all catalog ids fail SAFE_ID).
 *  INVARIANT: every key is a PROVIDER_PRESETS key with a baseUrl. */
export const PI_CATALOG_IDS: Record<string, readonly string[]> = {
  anthropic: [
    "claude-fable-5", "claude-fable-5-1", "claude-haiku-4-5", "claude-haiku-4-5-20251001",
    "claude-haiku-5-5", "claude-opus-4-5", "claude-opus-4-5-20251101", "claude-opus-4-6",
    "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5",
    "claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-sonnet-4-6", "claude-sonnet-5",
    "claude-sonnet-5-5",
  ],
  openai: [
    "chat-latest", "gpt-4", "gpt-4-turbo", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
    "gpt-4o", "gpt-4o-2024-05-13", "gpt-4o-2024-08-06", "gpt-4o-2024-11-20", "gpt-4o-mini",
    "gpt-5", "gpt-5-chat-latest", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "gpt-5.1",
    "gpt-5.2", "gpt-5.2-pro", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.4",
    "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro",
    "gpt-5.6-cyber", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra",
    "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra",
    "gpt-daybreak-blue-latest", "gpt-daybreak-red-latest",
    "o1", "o1-pro", "o3", "o3-mini", "o3-pro", "o4-mini",
  ],
  deepseek: ["deepseek-flash", "deepseek-v4-pro"],
  "zai-coding-cn": ["glm-4.6v", "glm-5.3", "glm-5.3-flash", "glm-5.3-highspeed"],
  groq: ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"],
};

/** "pi-known" in the spawn sense = our table has a frozen id list for it
 *  (derived, never stored separately — a preset flag could drift from the
 *  table and rule-2 would 500 on `undefined.includes`). */
function piKnown(provider: string): boolean {
  return Object.hasOwn(PI_CATALOG_IDS, provider);
}

/** Well-known provider presets — the only "built-ins" codar has, and they
 *  live in OUR config layer, not pi's. Entry fields always win.
 *
 *  openai uses openai-responses (v3): pi 1.5.0's catalog serves ALL 44 openai
 *  chat models under openai-responses, OpenAI's docs make Responses the
 *  recommended path for reasoning models (Chat Completions still works but
 *  GPT-6 Astra/6.1 Sol drop function-calling support there), and codar-bot
 *  is tool-call-heavy. This api only shapes GENERATED entries (rule-3/4);
 *  catalog-served models carry their own. To pin an older completions-only
 *  model, set entry.api in keys.json; to override a catalog-served model's
 *  protocol, declare it in entry.models with its api. */
export const PROVIDER_PRESETS: Record<
  string,
  { api: string; baseUrl?: string; label: string; models: PresetModel[] }
> = {
  anthropic: {
    api: "anthropic-messages", baseUrl: "https://api.anthropic.com", label: "Anthropic",
    models: [
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", badge: "flagship" },
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", badge: "balanced" },
      { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", badge: "fast" },
    ],
  },
  openai: {
    api: "openai-responses", baseUrl: "https://api.openai.com/v1", label: "OpenAI",
    models: [
      { id: "gpt-5.4", name: "GPT-5.4", badge: "flagship" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 mini", badge: "fast" },
    ],
  },
  openrouter: {
    api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", label: "OpenRouter",
    models: [], // aggregator: curated picks are meaningless, catalog ids fail SAFE_ID
  },
  deepseek: {
    api: "openai-completions", baseUrl: "https://api.deepseek.com", label: "DeepSeek",
    models: [
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", badge: "flagship" },
      { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", badge: "fast" },
    ],
  },
  "zai-coding-cn": {
    api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", label: "Zhipu zai Coding",
    models: [
      { id: "glm-5.3", name: "GLM-5.3", badge: "flagship" },
      { id: "glm-5.3-flash", name: "GLM-5.3 Flash", badge: "fast" },
    ],
  },
  "minimax-anthropic": {
    // pi-UNKNOWN (no catalog file for this id): models below are the model's
    // only source of truth, so they carry full entry fields.
    api: "anthropic-messages", baseUrl: "https://api.minimax.cn/anthropic", label: "MiniMax (Anthropic API)",
    models: [
      {
        id: "MiniMax-M3", name: "MiniMax M3", badge: "flagship",
        contextWindow: 1_000_000, maxTokens: 524_288, reasoning: true, input: ["text", "image"],
        // Official CN pricing page (platform.minimax.cn/docs/pricing/overview),
        // CNY per 1M tokens, standard tier (≤512k input; the page doubles
        // prices above 512k — tier pricing is not representable in our 4-field
        // cost, the ledger books the base tier), fetched 2026-11-16.
        cost: { input: 2.1, output: 8.4, cacheRead: 0.42, cacheWrite: 0 },
      },
      {
        id: "MiniMax-M3.1-Flash", name: "MiniMax M3.1 Flash", badge: "fast",
        contextWindow: 1_000_000, maxTokens: 524_288, reasoning: true, input: ["text", "image"],
        // Same page, fetched 2026-11-05 (re-verified 2026-11-16).
        cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 },
      },
    ],
  },
  "minimax-cn": {
    // pi-known catalog exists BUT lives at api.minimaxi.com/anthropic while
    // this preset is the /v1 OpenAI-compatible face — protocol worlds cannot
    // coexist (see PI_CATALOG_IDS note). Generated entries only. For the
    // /anthropic endpoint with full catalog fidelity, set entry.baseUrl +
    // entry.api=anthropic-messages and entry.models=[] (empty = zero upserts,
    // catalog serves everything).
    api: "openai-completions", baseUrl: "https://api.minimaxi.com/v1", label: "MiniMax (OpenAI API)",
    models: [],
  },
  groq: {
    api: "openai-completions", baseUrl: "https://api.groq.com/openai/v1", label: "Groq",
    models: [], // fast-moving catalog; catalog ids that pass SAFE_ID still serve via PI_CATALOG_IDS
  },
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
  if (typeof doc !== "object" || doc === null || typeof doc.providers !== "object" ||
      doc.providers === null || Array.isArray(doc.providers)) {
    throw new Error("server config error: keys.json must be {providers: {...}}");
  }
  // Per-entry shape: a null entry used to pass the outer typeof check and
  // blow up later (ownEntry consumers) or silently misbehave — reject here
  // so boot fail-fast (host.ts) catches it.
  for (const [name, entry] of Object.entries(doc.providers)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`server config error: keys.json providers.${name} must be an object`);
    }
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

/** One line of the provider discovery surface (GET /api/providers,
 *  `codar providers`). models carry UI metadata only — never catalog data. */
export interface ProviderReportEntry {
  id: string;
  label: string;
  configured: boolean;
  api?: string;
  baseUrl?: string;
  models: Array<{ id: string; name?: string; badge?: string }>;
}

/** ids out of an entry.models value of unknown shape: own-key traversal is
 *  not needed here (callers pass the already-own entry value), but every
 *  element is shape-checked — malformed data (strings, {id:42}, __proto__
 *  keys) yields nothing instead of crashing or polluting. */
function extractEntryModelIds(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  const ids: string[] = [];
  for (const m of models) {
    if (typeof m === "string") ids.push(m);
    else if (typeof m === "object" && m !== null) {
      const id = (m as Record<string, unknown>)["id"];
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

/** The provider discovery surface (pure, offline): keys.json entries ∪
 *  presets ∪ every provider actually in use (bots + the memory review
 *  model — reviewModel's provider appears nowhere else). A bots-only
 *  provider (e.g. a relay configured via PATCH) gets an entry so the edit
 *  UI can always represent the current value. */
export function providersReport(
  keys: KeysDoc,
  bots: BotRecord[],
  reviewModel: BotModelRef | null
): ProviderReportEntry[] {
  const inUse = new Map<string, Set<string>>();
  const addUse = (provider: string, modelId: string): void => {
    const set = inUse.get(provider) ?? new Set<string>();
    set.add(modelId);
    inUse.set(provider, set);
  };
  for (const b of bots) addUse(b.model.provider, b.model.modelId);
  if (reviewModel !== null) addUse(reviewModel.provider, reviewModel.modelId);

  const ids = new Set<string>([...Object.keys(PROVIDER_PRESETS), ...Object.keys(keys.providers), ...inUse.keys()]);
  const entries: ProviderReportEntry[] = [];
  for (const id of ids) {
    // ids come from own-key sources (JSON.parse / object literals), so no
    // prototype pollution path exists; computed-key writes below are safe.
    if (!SAFE_ID.test(id)) continue; // e.g. a "__proto__" key hand-written into keys.json
    const entry = ownEntry(keys, id);
    const preset = Object.hasOwn(PROVIDER_PRESETS, id) ? PROVIDER_PRESETS[id] : undefined;
    const configured =
      (entry !== undefined && typeof entry.apiKey === "string" && entry.apiKey !== "") ||
      (entry !== undefined && entry.baseUrl !== undefined); // keyless relay with explicit baseUrl is deliberate
    const models: ProviderReportEntry["models"] = [];
    const seen = new Set<string>();
    const push = (modelId: string, name?: string, badge?: string): void => {
      if (!SAFE_ID.test(modelId) || seen.has(modelId)) return;
      seen.add(modelId);
      models.push(name !== undefined || badge !== undefined ? { id: modelId, ...(name !== undefined ? { name } : {}), ...(badge !== undefined ? { badge } : {}) } : { id: modelId });
    };
    for (const m of preset?.models ?? []) push(m.id, m.name, m.badge);
    for (const modelId of extractEntryModelIds(entry?.models)) push(modelId);
    for (const modelId of inUse.get(id) ?? []) push(modelId);
    entries.push({
      id,
      label: preset?.label ?? id,
      configured,
      ...(entry?.api !== undefined || preset !== undefined ? { api: entry?.api ?? preset!.api } : {}),
      ...(entry?.baseUrl !== undefined || preset?.baseUrl !== undefined ? { baseUrl: entry?.baseUrl ?? preset!.baseUrl } : {}),
      models,
    });
  }
  // configured first, stable alphabetical within groups.
  return entries.sort((a, b) => Number(b.configured) - Number(a.configured) || a.id.localeCompare(b.id));
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
  if (entry.models !== undefined && !Array.isArray(entry.models)) {
    // A non-array would iterate per-character (string) or die inside pi's
    // upsert loop with an opaque TypeError — fail here with a fixable name.
    throw new Error(`keys.json providers.${provider}.models must be an array`);
  }
  const preset = Object.hasOwn(PROVIDER_PRESETS, provider) ? PROVIDER_PRESETS[provider] : undefined;
  const api = entry.api ?? preset?.api ?? "openai-completions";
  const baseUrl = entry.baseUrl ?? preset?.baseUrl;
  const keyPresent = typeof entry.apiKey === "string" && entry.apiKey !== "";
  if (keyPresent) env.CODAR_BOT_KEY = entry.apiKey!;
  // models field decision (v3 rules):
  //   rule-1  entry.models declared (including []) → use verbatim. [] means
  //           zero upserts: the whole catalog serves with apiKey injected.
  //   rule-2  pi-known + catalog id → OMIT models: the bundled catalog entry
  //           serves with full fidelity (reasoning/thinkingLevelMap/tiers).
  //           Emitting a generated entry here is the historical bug that
  //           degraded glm-5.3 to 128k/8192/non-reasoning.
  //   rule-3  pi-known + unknown id → minimal entry (the user's explicit id
  //           is the only source; honest defaults, no invented prices).
  //   rule-4  pi-unknown provider → curated hit uses the preset's full
  //           fields; otherwise a minimal entry.
  let modelsField: unknown;
  if (entry.models !== undefined) {
    modelsField = entry.models;
  } else if (piKnown(provider) && PI_CATALOG_IDS[provider]!.includes(modelId)) {
    modelsField = null; // omit
  } else {
    const curated = !piKnown(provider) ? preset?.models.find((m) => m.id === modelId) : undefined;
    modelsField = [{
      id: modelId,
      name: curated?.name ?? modelId,
      input: curated?.input ?? ["text"],
      contextWindow: curated?.contextWindow ?? 128_000,
      maxTokens: curated?.maxTokens ?? 8_192,
      type: "chat",
      ...(curated?.reasoning !== undefined ? { reasoning: curated.reasoning } : {}),
      // FULL 4-field cost shape: pi's schema rejects partial cost objects.
      // No price is ever invented: unpriced models report cost 0 and the
      // budget layer degrades to token-budget (§4).
      ...(curated?.cost !== undefined ? { cost: curated.cost } : {}),
    }];
  }
  const modelsDoc = {
    providers: {
      [provider]: {
        api,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(keyPresent ? { apiKey: "$CODAR_BOT_KEY" } : {}),
        ...(modelsField !== null ? { models: modelsField } : {}),
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

/** CLI rendering of the discovery surface (pure — `codar providers`).
 *  Lives here, not in cli.ts, so the smoke test can import it without
 *  triggering cli's top-level main(). */
export function renderProviders(report: ProviderReportEntry[]): string {
  if (report.length === 0) {
    return "no providers configured (run: codar init --provider <name> --model <modelId>)";
  }
  const lines: string[] = ["providers (✓ = key configured):", ""];
  for (const p of report) {
    lines.push(`  ${p.configured ? "✓" : "×"} ${p.id}${p.label !== p.id ? `  — ${p.label}` : ""}`);
    if (p.baseUrl !== undefined) lines.push(`      ${p.baseUrl}`);
    if (p.models.length > 0) lines.push(`      models: ${p.models.map((m) => m.id).join(", ")}`);
  }
  return lines.join("\n");
}

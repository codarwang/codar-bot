/**
 * provider-settings — the §3.3 key ENTRY surface (v0.14, PRD 3.7).
 *
 * WRITE half of §3.3; the v3 discovery surface (GET /api/providers,
 * providersReport) stays read-only and separate. The UI contract, in the
 * order a non-IT user meets it:
 *
 *  - GET  never carries key material: a configured key shows as a masked
 *    prefix ("sk-…abcd"), never the value (architecture §3.3 "永不回显完整
 *    值" — masked at most).
 *  - PUT  upserts {apiKey?, baseUrl?, api?} via load → merge → writeKeys
 *    (atomic tmp+rename, 0600 from the first byte). Absent field = unchanged;
 *    explicit null = clear. Effective values still come from the preset at
 *    spawn time — the entry only carries overrides, so a preset provider can
 *    be registered with nothing but the key. Saves take effect on the NEXT
 *    bot start (bot-manager re-reads keys.json per start — no restart).
 *  - DELETE removes the entry. The in-use guard lives in the route (it needs
 *    the store): a provider a bot or the review model still points at is a
 *    409 with the bot list — switch them first, never strand a config.
 *  - TEST  fires ONE GET {baseUrl}/models (Linger's "nothing is probed"):
 *    no retries, no background refresh, failure does not block saving. The
 *    discovered ids are a UI convenience cache — the spawn rules (§3.3 v3,
 *    PI_CATALOG_IDS) never read them, so curation and catalog protection
 *    are untouched.
 *
 * Every write appends one audit.jsonl line (provider.key.set/remove) with a
 * masked key at most — same append-only JSONL as budget.ts / memory.ts.
 */
import { appendFileSync } from "node:fs";
import {
  loadKeys,
  writeKeys,
  SAFE_ID,
  PROVIDER_PRESETS,
  providersReport,
  type KeysDoc,
  type ProviderEntry,
  type ProviderReportEntry,
} from "./provider-config.js";
import type { BotRecord, BotModelRef } from "./store.js";

/** The protocol set the UI may write — derived from the presets (single
 *  source; the preset table IS the curation). init/CLI accept anything for
 *  the power path; the entry surface stays curated. */
export const PROVIDER_APIS: readonly string[] = [
  ...new Set(Object.values(PROVIDER_PRESETS).map((p) => p.api)),
];

/** "sk-…abcd" style echo (architecture §3.3). Short keys would be mostly
 *  visible under prefix+suffix masking (a 10-char key would show 7 of its
 *  10 chars) — the threshold keeps the exposed fraction low; everything
 *  under it shows as all dots. */
export function maskKey(key: string): string {
  const k = key.trim();
  return k.length >= 16 ? `${k.slice(0, 3)}…${k.slice(-4)}` : "••••";
}

/** Validation failures (bad id / bad protocol / bad URL / no such entry) —
 *  the route maps these to 4xx; anything else (fs/IO) stays a 500. Carrying
 *  the status on the error keeps that mapping out of string matching. */
export class ProviderInputError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
  }
}

function ownEntry(keys: KeysDoc, provider: string): ProviderEntry | undefined {
  // Same prototype-chain discipline as providersReport: "constructor" as a
  // provider name must not resolve to inherited properties.
  return Object.hasOwn(keys.providers, provider) ? keys.providers[provider] : undefined;
}

// --- read (masked echo) ------------------------------------------------------

export interface ProviderSettingsUse {
  kind: "bot" | "review";
  /** Bot id; null for the review model (it is a setting, not a bot). */
  id: string | null;
  name: string;
  modelId: string;
}

export interface ProviderSettingsEntry {
  id: string;
  label: string;
  preset: boolean;
  /** Effective values (entry override ?? preset default ?? undefined) — the
   *  same resolution the spawn path uses, so the UI never shows a value the
   *  spawn would not use. */
  api?: string;
  baseUrl?: string;
  /** True when the ENTRY (not the preset) supplies the baseUrl — the UI's
   *  "this card has something deletable / a custom override" signal. */
  baseUrlCustom: boolean;
  /** Same for the api protocol override ("set back to preset" affordance). */
  apiCustom: boolean;
  configured: boolean;
  keyPresent: boolean;
  maskedKey: string | null;
  /** An entry exists in keys.json for this id (even a keyless baseUrl-only
   *  relay) — DELETE targets it, presets without entries cannot be deleted. */
  entryPresent: boolean;
  models: ProviderReportEntry["models"];
  inUse: ProviderSettingsUse[];
}

/** The entry surface (pure, offline): the discovery report + masked key +
 *  per-bot in-use lists. Discovery stays the shared base so the two surfaces
 *  cannot disagree about labels/effective values/models. */
export function providerSettingsReport(
  keys: KeysDoc,
  bots: BotRecord[],
  reviewModel: BotModelRef | null
): ProviderSettingsEntry[] {
  const base = providersReport(keys, bots, reviewModel);
  const inUseBy = new Map<string, ProviderSettingsUse[]>();
  const push = (provider: string, use: ProviderSettingsUse): void => {
    const list = inUseBy.get(provider) ?? [];
    list.push(use);
    inUseBy.set(provider, list);
  };
  for (const b of bots) push(b.model.provider, { kind: "bot", id: b.id, name: b.name, modelId: b.model.modelId });
  if (reviewModel !== null) {
    push(reviewModel.provider, { kind: "review", id: null, name: "", modelId: reviewModel.modelId });
  }
  const out: ProviderSettingsEntry[] = [];
  for (const b of base) {
    const entry = ownEntry(keys, b.id);
    // typeof guards mirror providersReport's `configured` logic: a
    // hand-edited keys.json with a non-string field ("apiKey": 123456 — a
    // digit-only key pasted as a JSON number) must degrade to "unset" here,
    // never crash the whole settings page (R1 P2-1; the spawn path already
    // does this in buildSpawnConfig).
    const keyPresent = typeof entry?.apiKey === "string" && entry.apiKey !== "";
    const baseUrlCustom = typeof entry?.baseUrl === "string" && entry.baseUrl !== "";
    const apiCustom = typeof entry?.api === "string" && entry.api !== "";
    out.push({
      id: b.id,
      label: b.label,
      preset: b.preset,
      ...(b.api !== undefined ? { api: b.api } : {}),
      ...(b.baseUrl !== undefined ? { baseUrl: b.baseUrl } : {}),
      baseUrlCustom,
      apiCustom,
      configured: b.configured,
      keyPresent,
      maskedKey: keyPresent ? maskKey(entry!.apiKey!) : null,
      entryPresent: entry !== undefined,
      models: b.models,
      inUse: inUseBy.get(b.id) ?? [],
    });
  }
  // in-use-only ids are already in `base` (discovery unions them), so every
  // id in inUseBy is covered; keep discovery's ordering (configured first).
  return out;
}

// --- write (merge → atomic persist → audit) ----------------------------------

export interface ProviderUpsert {
  /** New key value; null clears it. Absent = unchanged. */
  apiKey?: string | null;
  /** Override for the preset's endpoint; null/"" clears the override. */
  baseUrl?: string | null;
  /** Protocol override; null clears it back to the preset default. */
  api?: string | null;
}

function appendAuditLine(auditPath: string, entry: Record<string, unknown>): void {
  // budget.ts / memory.ts write the same {ts, ...} lines; keys are masked
  // upstream — a raw key must never reach this function's callers.
  appendFileSync(auditPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf8");
}

export function upsertProvider(keysPath: string, id: string, patch: ProviderUpsert, auditPath: string): void {
  if (!SAFE_ID.test(id)) {
    throw new ProviderInputError(`invalid provider id "${id}" (use [A-Za-z0-9._-])`);
  }
  if (patch.api !== undefined && patch.api !== null && !PROVIDER_APIS.includes(patch.api)) {
    throw new ProviderInputError(`invalid api protocol "${patch.api}" (use ${PROVIDER_APIS.join("|")})`);
  }
  const keys = loadKeys(keysPath);
  const next: ProviderEntry = { ...ownEntry(keys, id) };
  if (Object.hasOwn(patch, "apiKey")) {
    if (patch.apiKey === null) {
      delete next.apiKey;
    } else {
      const k = (patch.apiKey ?? "").trim();
      if (k === "") throw new ProviderInputError("apiKey must be non-empty (null clears it)");
      next.apiKey = k;
    }
  }
  if (Object.hasOwn(patch, "baseUrl")) {
    const rawBase = patch.baseUrl;
    if (rawBase === null || rawBase === undefined || rawBase.trim() === "") {
      delete next.baseUrl; // "" normalizes to unset — preset default wins (loadKeys semantics)
    } else {
      const u = rawBase.trim();
      let parsed: URL;
      try {
        parsed = new URL(u);
      } catch {
        throw new ProviderInputError(`baseUrl "${u.slice(0, 120)}" is not a valid URL`);
      }
      if (parsed.protocol !== "https:") {
        // Also the reason the test endpoint can never send a key to a
        // plaintext endpoint: stored/preset baseUrls are https-only.
        throw new ProviderInputError("baseUrl must be https:// (the API key travels to this host)");
      }
      // One normalized form (no trailing slash) so {base}/models joins keep
      // working; path prefixes the user typed ("…/v1") are preserved.
      next.baseUrl = u.replace(/\/+$/, "");
    }
  }
  if (Object.hasOwn(patch, "api")) {
    if (patch.api === null) delete next.api;
    else next.api = patch.api!; // "" was rejected by the PROVIDER_APIS check above
  }
  keys.providers[id] = next;
  writeKeys(keysPath, keys);
  appendAuditLine(auditPath, {
    kind: "provider.key.set",
    provider: id,
    // A hand-mangled numeric apiKey preserved by an unrelated PUT must not
    // crash the audit line (maskKey trims) — it reads as "no usable key"
    // here, same as everywhere else (R2-F1).
    maskedKey: typeof next.apiKey === "string" && next.apiKey !== "" ? maskKey(next.apiKey) : null,
  });
}

export function removeProvider(keysPath: string, id: string, auditPath: string): void {
  if (!SAFE_ID.test(id)) {
    throw new ProviderInputError(`invalid provider id "${id}" (use [A-Za-z0-9._-])`);
  }
  const keys = loadKeys(keysPath);
  if (!Object.hasOwn(keys.providers, id)) {
    throw new ProviderInputError(`no entry for provider "${id}" (presets without a saved entry have nothing to remove)`, 404);
  }
  delete keys.providers[id]; // own-key id (ownEntry guarantee above)
  writeKeys(keysPath, keys);
  appendAuditLine(auditPath, { kind: "provider.key.remove", provider: id });
}

// --- test (one real request, nothing probed) ---------------------------------

export interface ProviderTestOk {
  ok: true;
  /** Model ids the provider lists (capped) — UI convenience only; the spawn
   *  path never reads this. Empty on a 200 the shape-parser can't read. */
  models: string[];
}
export interface ProviderTestFailure {
  ok: false;
  error: { code: "auth" | "not_found" | "timeout" | "network"; message: string };
}
export type ProviderTestResult = ProviderTestOk | ProviderTestFailure;

const TEST_TIMEOUT_MS = 10_000;
const TEST_MODEL_CAP = 200;

export async function testProvider(opts: {
  api?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Injectable for deterministic tests; the route path uses the default. */
  timeoutMs?: number;
}): Promise<ProviderTestResult> {
  const timeoutMs = opts.timeoutMs ?? TEST_TIMEOUT_MS;
  const base = (opts.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (base === "") {
    return { ok: false, error: { code: "network", message: "no baseUrl configured — pick a preset or set one" } };
  }
  const url = `${base}/models`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.api === "anthropic-messages") {
    if (opts.apiKey !== undefined && opts.apiKey !== "") headers["x-api-key"] = opts.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (opts.apiKey !== undefined && opts.apiKey !== "") {
    headers["authorization"] = `Bearer ${opts.apiKey}`;
  }
  // Linger discipline: explicit user action, one shot. redirect:"manual" so
  // a wrong baseUrl pointing at an HTML page can't silently "succeed".
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers, signal: ac.signal, redirect: "manual" });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof Error && e.name === "AbortError") {
      return { ok: false, error: { code: "timeout", message: `no answer in ${Math.round(timeoutMs / 1000)}s — check the address and your network` } };
    }
    return { ok: false, error: { code: "network", message: String((e as Error | undefined)?.message ?? e).slice(0, 200) } };
  }
  clearTimeout(timer);
  // Human-readable outcomes (the UI translates nothing): 401/403 = key, 404 =
  // address (the key may still be fine), anything else = provider/network.
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: { code: "auth", message: `key rejected (HTTP ${res.status}) — check the API key` } };
  }
  if (res.status === 404) {
    return { ok: false, error: { code: "not_found", message: `no model list at ${url} (HTTP 404) — the base URL is likely wrong; the key itself may be fine` } };
  }
  if (!res.ok) {
    return { ok: false, error: { code: "network", message: `provider answered HTTP ${res.status}` } };
  }
  // OpenAI and Anthropic both shape the list as {data:[{id}...]}; a relay may
  // answer anything. A 200 proves key+address work even when no ids parse —
  // honest ok-with-empty-list, never a fake failure.
  const models: string[] = [];
  try {
    const body = JSON.parse(await res.text()) as { data?: unknown };
    if (Array.isArray(body.data)) {
      for (const m of body.data) {
        if (typeof m === "string") models.push(m);
        else if (typeof m === "object" && m !== null && typeof ((m as Record<string, unknown>)["id"]) === "string") {
          models.push((m as Record<string, unknown>)["id"] as string);
        }
      }
    }
  } catch {
    /* non-JSON 200 → ok with an empty list */
  }
  return { ok: true, models: models.slice(0, TEST_MODEL_CAP) };
}

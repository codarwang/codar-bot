/**
 * provider-config — the §3.3 key/config chain.
 *
 * keys.json (0600, atomic tmp+rename, independent of state.json) holds
 * provider credentials; the host materializes per-bot pi-conf/models.json
 * with `$ENV` interpolated key references (the S3/S4-proven mechanism: the
 * key never lands in a config file; the child gets it via env).
 *
 * Branch policy (R1 review):
 *  - standard provider, key only        → inject pi's env var (e.g.
 *    ANTHROPIC_API_KEY); nothing on disk. NOTE: an empty/absent apiKey
 *    injects NOTHING (never shadow a valid host env with an empty string).
 *  - custom provider (baseUrl and/or a models override) → models.json with
 *    apiKey "$CODAR_BOT_KEY" + the key in env. Standard names with overrides
 *    take this branch too — silently DROPPING a models override would be a
 *    dishonest success.
 */
import { readFileSync, openSync, closeSync, writeSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { botPiConfDir } from "./paths.js";

export interface ProviderEntry {
  apiKey?: string;
  baseUrl?: string;
  models?: unknown;
}

export interface KeysDoc {
  providers: Record<string, ProviderEntry>;
}

/** pi's env var names for its built-in providers. */
const STANDARD_PROVIDER_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
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
  /** env additions for the child (provider keys). */
  env: Record<string, string>;
  /** models.json content for the bot's pi-conf dir, or null when pi's
   *  defaults suffice (standard provider without overrides). */
  modelsJson: string | null;
  piConfDir: string;
}

/** Resolve a bot's provider spawn config from keys.json (§3.3). */
export function buildSpawnConfig(
  keys: KeysDoc,
  dataRoot: string,
  botId: string,
  provider: string
): BotSpawnConfig {
  const piConfDir = botPiConfDir(dataRoot, botId);
  const entry = ownEntry(keys, provider);
  const env: Record<string, string> = {};
  if (entry === undefined) {
    // No credentials configured for this provider — spawn bare; auth then
    // fails inside the child and surfaces through bot_failed (honest). A
    // same-name key in the HOST's own env may still authenticate the child
    // (children inherit process.env) — keys.json is the tracked source, not
    // an exclusive gate.
    return { env, modelsJson: null, piConfDir };
  }
  const hasOverride = entry.baseUrl !== undefined || entry.models !== undefined;
  const standardEnv = STANDARD_PROVIDER_ENV[provider];
  const keyPresent = typeof entry.apiKey === "string" && entry.apiKey !== "";
  if (!hasOverride && standardEnv !== undefined) {
    if (keyPresent) env[standardEnv] = entry.apiKey!;
    return { env, modelsJson: null, piConfDir };
  }
  // Custom provider (or standard name WITH overrides): models.json with
  // $ENV interpolation — the S3-proven chain; the file never holds secrets.
  if (keyPresent) env.CODAR_BOT_KEY = entry.apiKey!;
  const modelsDoc = {
    providers: {
      [provider]: {
        ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
        ...(keyPresent ? { apiKey: "$CODAR_BOT_KEY" } : {}),
        ...(entry.models !== undefined ? { models: entry.models } : {}),
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
  }
}

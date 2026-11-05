/**
 * provider-config — the §3.3 key/config chain.
 *
 * keys.json (0600, independent of state.json) holds provider credentials;
 * the host materializes per-bot pi-conf/models.json with `$ENV` interpolated
 * key references (the S3/S4-proven mechanism: the key never lands in a
 * config file; the child gets it via env). Standard providers are injected
 * as plain env vars; custom providers (baseUrl) live in models.json.
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
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
  "openrouter": "OPENROUTER_API_KEY",
  "groq": "GROQ_API_KEY",
};

export function loadKeys(keysPath: string): KeysDoc {
  if (!existsSync(keysPath)) return { providers: {} };
  let doc: KeysDoc;
  try {
    doc = JSON.parse(readFileSync(keysPath, "utf8")) as KeysDoc;
  } catch (error) {
    throw new Error(`keys at ${keysPath} is not valid JSON (${String(error).slice(0, 120)})`);
  }
  if (typeof doc !== "object" || doc === null || typeof doc.providers !== "object") {
    throw new Error("keys.json must be {providers: {...}}");
  }
  return doc;
}

export function writeKeys(keysPath: string, doc: KeysDoc): void {
  writeFileSync(keysPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  chmodSync(keysPath, 0o600);
}

export interface BotSpawnConfig {
  /** env additions for the child (standard-provider keys + CODAR_BOT_KEY). */
  env: Record<string, string>;
  /** models.json to write into the bot's pi-conf dir, or null when the bot
   *  needs no custom provider (empty file keeps pi's defaults). */
  modelsJson: string | null;
  piConfDir: string;
}

/** Resolve a bot's provider spawn config from keys.json (§3.3).
 *  - standard provider (pi built-in): key goes out via its env var
 *  - custom provider (baseUrl): models.json with apiKey "$CODAR_BOT_KEY"
 *    and the key in env — the file never contains the secret.
 */
export function buildSpawnConfig(
  keys: KeysDoc,
  dataRoot: string,
  botId: string,
  provider: string
): BotSpawnConfig {
  const piConfDir = botPiConfDir(dataRoot, botId);
  const entry = keys.providers[provider];
  const env: Record<string, string> = {};
  if (entry === undefined) {
    // No credentials configured for this provider — spawn bare; pi will
    // report auth errors through the bot_failed path (honest failure).
    return { env, modelsJson: null, piConfDir };
  }
  const standardEnv = STANDARD_PROVIDER_ENV[provider];
  if (entry.baseUrl === undefined && standardEnv !== undefined) {
    env[standardEnv] = entry.apiKey ?? "";
    return { env, modelsJson: null, piConfDir };
  }
  // Custom provider (or a standard one forced through a custom baseUrl):
  // models.json with $ENV interpolation — the S3-proven chain.
  if (entry.apiKey !== undefined && entry.apiKey !== "") {
    env.CODAR_BOT_KEY = entry.apiKey;
  }
  const modelsDoc = {
    providers: {
      [provider]: {
        ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
        ...(entry.apiKey !== undefined && entry.apiKey !== "" ? { apiKey: "$CODAR_BOT_KEY" } : {}),
        ...(entry.models !== undefined ? { models: entry.models } : {}),
      },
    },
  };
  return { env, modelsJson: JSON.stringify(modelsDoc, null, 2), piConfDir };
}

/** Materialize a bot's pi-conf dir for spawn (idempotent). */
export function materializePiConf(cfg: BotSpawnConfig): void {
  mkdirSync(cfg.piConfDir, { recursive: true });
  if (cfg.modelsJson !== null) {
    writeFileSync(join(cfg.piConfDir, "models.json"), `${cfg.modelsJson}\n`, "utf8");
  }
}

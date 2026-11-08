/**
 * rules-manager — host-side approval rules engine (M3.1b, architecture
 * docs/m3-architecture.md §1.3/§1.5).
 *
 * Owns the rule lifecycle: global rules.json + per-bot overrides → tier-
 * sorted merge → per-bot rules.d/rules.json (the gate reads this file via
 * CODAR_GATE_RULES; mtime hot reload makes PUTs take effect on the next
 * tool_call without stop/start).
 *
 * Tier ordering (§1.3): deny > allow > gate. Within a tier, more-specific
 * matches first. A per-bot "allow bash *" can NEVER override a global
 * "deny rm -rf" — cross-file tier re-sorting guarantees it.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, openSync, closeSync, writeSync } from "node:fs";

import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";

interface GateRuleJson {
  id: string;
  toolName: string;
  match: "tool" | "bash_prefix" | "bash_keyword" | "path_prefix";
  pattern?: string;
  action: "allow" | "deny" | "gate";
  description?: string;
}

interface RulesDoc {
  version: number;
  rules: GateRuleJson[];
}

const TIER: Record<GateRuleJson["action"], number> = { deny: 0, allow: 1, gate: 2 };
const SPECIFICITY: Record<GateRuleJson["match"], number> = {
  path_prefix: 3,
  tool: 2,
  bash_keyword: 1,
  bash_prefix: 0,
};

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID().slice(0, 6)}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function readDoc(path: string): RulesDoc {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<RulesDoc>;
    return {
      version: typeof parsed.version === "number" ? parsed.version : 0,
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
    };
  } catch {
    return { version: 0, rules: [] };
  }
}

function writeDoc(path: string, doc: RulesDoc): void {
  atomicWrite(path, `${JSON.stringify(doc, null, 2)}\n`);
}

export class RulesManager {
  private readonly globalPath: string;
  private readonly perBotDir: string;
  private readonly piConfRoot: string;

  constructor(dataRoot: string, private readonly store: Store) {
    this.globalPath = join(dataRoot, "rules.json");
    this.perBotDir = join(dataRoot, "rules");
    this.piConfRoot = join(dataRoot, "pi-conf");
    mkdirSync(this.perBotDir, { recursive: true });
  }

  /** Global rules + version. */
  global(): RulesDoc {
    return readDoc(this.globalPath);
  }

  /** Per-bot override rules (source, not merged). */
  botOverrides(botId: string): RulesDoc {
    return readDoc(join(this.perBotDir, `${botId}.json`));
  }

  /** Full-replace global rules (optimistic lock on version). */
  putGlobal(rules: GateRuleJson[], expectedVersion: number): RulesDoc {
    validateRulesOrThrow(rules);
    const cur = this.global();
    if (cur.version !== expectedVersion) {
      throw new RulesVersionConflict(cur.version, expectedVersion);
    }
    const doc: RulesDoc = { version: cur.version + 1, rules };
    writeDoc(this.globalPath, doc);
    this.refreshAllBots();
    return doc;
  }

  /** Full-replace per-bot override rules. */
  putBotOverrides(botId: string, rules: GateRuleJson[]): RulesDoc {
    validateRulesOrThrow(rules);
    const path = join(this.perBotDir, `${botId}.json`);
    const cur = readDoc(path);
    const doc: RulesDoc = { version: cur.version + 1, rules };
    writeDoc(path, doc);
    this.refreshBot(botId);
    return doc;
  }

  /** Merged view for one bot (global + per-bot, tier-sorted) — the exact
   *  rule list the gate will evaluate. Includes origin annotations. */
  merged(botId: string): Array<GateRuleJson & { origin: "global" | "bot" }> {
    const globalRules = this.global().rules.map((r) => ({ ...r, origin: "global" as const }));
    const botRules = this.botOverrides(botId).rules.map((r) => ({ ...r, origin: "bot" as const }));
    return this.sort([...globalRules, ...botRules]);
  }

  /** Write the merged rules.d/rules.json for one bot (the gate reads this).
   *  Called at spawn time and on every PUT. */
  refreshBot(botId: string): void {
    const merged = this.merged(botId);
    const dir = join(this.piConfRoot, botId, "rules.d");
    const stripped = merged.map(({ origin, ...rule }) => { void origin; return rule; });
    writeDoc(join(dir, "rules.json"), { version: 0, rules: stripped });
  }

  /** Refresh all known bots (a global PUT affects everyone). */
  refreshAllBots(): void {
    for (const bot of this.store.state.bots) {
      this.refreshBot(bot.id);
    }
  }

  /** CODAR_GATE_RULES env value for a bot (bare and docker differ). */
  gateRulesPath(botId: string, sandboxMode: string): string {
    if (sandboxMode === "docker") {
      // The mount maps pi-conf/<botId>/ → /state/pi-conf/ — the container
      // path has NO botId segment (the mount root already scopes it).
      return "/state/pi-conf/rules.d/rules.json";
    }
    return join(this.piConfRoot, botId, "rules.d", "rules.json");
  }

  /** Create a rule from a keyboard shortcut (approval card [1]/[2]/[3]). */
  createShortcutRule(
    scope: "global" | "bot",
    botId: string | null,
    rule: Omit<GateRuleJson, "id">,
  ): GateRuleJson {
    // P2-4: same validation as the CRUD paths — the keyboard shortcut is
    // client-supplied JSON on a public local API.
    if (rule.action !== "allow") {
      throw new RulesValidationError(`shortcut rules must be action "allow" (got "${rule.action}")`);
    }
    const full: GateRuleJson = { ...rule, id: `rule_${randomUUID().slice(0, 8)}` };
    validateRulesOrThrow([full]);
    if (scope === "global") {
      const cur = this.global();
      writeDoc(this.globalPath, { version: cur.version + 1, rules: [...cur.rules, full] });
      this.refreshAllBots();
    } else if (botId !== null) {
      const path = join(this.perBotDir, `${botId}.json`);
      const cur = readDoc(path);
      writeDoc(path, { version: cur.version + 1, rules: [...cur.rules, full] });
      this.refreshBot(botId);
    }
    return full;
  }

  private sort(rules: Array<GateRuleJson & { origin: "global" | "bot" }>): Array<GateRuleJson & { origin: "global" | "bot" }> {
    return rules.sort((a, b) => {
      const tierDiff = TIER[a.action] - TIER[b.action];
      if (tierDiff !== 0) return tierDiff;
      return SPECIFICITY[b.match] - SPECIFICITY[a.match];
    });
  }
}

/** Validate rules with the same shape checks the gate's parser enforces —
 *  a malformed rule rejected HERE (clear error to the caller) instead of in
 *  the GATE (deny-all on next spawn, M3 review P2-4). Inlined rather than
 *  imported from extensions/ (rootDir:src excludes that path in tsconfig.build). */
function validateRulesOrThrow(rules: GateRuleJson[]): void {
  if (rules.length > 256) throw new RulesValidationError(`rules exceed 256`);
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]!;
    if (typeof r.id !== "string" || r.id.length === 0 || r.id.length > 64)
      throw new RulesValidationError(`rules[${i}].id must be 1-64 chars`);
    if (r.toolName !== "*" && (typeof r.toolName !== "string" || r.toolName.length === 0 || r.toolName.length > 64))
      throw new RulesValidationError(`rules[${i}].toolName must be 1-64 chars or "*")`);
    const matches = ["tool", "bash_prefix", "bash_keyword", "path_prefix"];
    if (!matches.includes(r.match))
      throw new RulesValidationError(`rules[${i}].match must be ${matches.join("|")}`);
    if (r.match !== "tool" && (typeof r.pattern !== "string" || r.pattern.length === 0 || r.pattern.length > 256))
      throw new RulesValidationError(`rules[${i}].pattern required for ${r.match} (1-256 chars)`);
    if (r.match === "bash_keyword") {
      try { void new RegExp(r.pattern ?? ""); } catch (e) {
        throw new RulesValidationError(`rules[${i}].pattern is not a valid regex: ${String(e).slice(0, 100)}`);
      }
    }
    const actions = ["allow", "deny", "gate"];
    if (!actions.includes(r.action))
      throw new RulesValidationError(`rules[${i}].action must be ${actions.join("|")}`);
    if (r.description !== undefined && typeof r.description !== "string")
      throw new RulesValidationError(`rules[${i}].description must be a string`);
  }
}

export class RulesValidationError extends Error {}

export class RulesVersionConflict extends Error {
  constructor(public readonly currentVersion: number, public readonly expectedVersion: number) {
    super(`rules version conflict: expected ${expectedVersion}, current is ${currentVersion}`);
  }
}

export type { GateRuleJson, RulesDoc };

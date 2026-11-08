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
  bash_keyword: 2,
  tool: 1,
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
    const rel = join(botId, "rules.d", "rules.json");
    if (sandboxMode === "docker") {
      return `/state/pi-conf/${rel}`;
    }
    return join(this.piConfRoot, rel);
  }

  /** Create a rule from a keyboard shortcut (approval card [1]/[2]/[3]). */
  createShortcutRule(
    scope: "global" | "bot",
    botId: string | null,
    rule: Omit<GateRuleJson, "id">,
  ): GateRuleJson {
    const full: GateRuleJson = { ...rule, id: `rule_${randomUUID().slice(0, 8)}` };
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

export class RulesVersionConflict extends Error {
  constructor(public readonly currentVersion: number, public readonly expectedVersion: number) {
    super(`rules version conflict: expected ${expectedVersion}, current is ${currentVersion}`);
  }
}

export type { GateRuleJson, RulesDoc };

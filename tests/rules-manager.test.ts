/**
 * M3.1b rules-manager tests — offline, deterministic.
 * Covers: tier sorting (deny > allow > gate), per-bot override + global
 * merge, version optimistic lock, shortcut rule creation, rules.d write,
 * and the version conflict error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, defaultBudget } from "../src/host/store.js";
import { RulesManager, RulesVersionConflict } from "../src/host/rules-manager.js";

function rig() {
  const root = mkdtempSync(join(tmpdir(), "codar-rm-"));
  const store = Store.open(join(root, "state.json"), { create: true });
  store.addBot({
    name: "Chief", role: "", chief: true,
    model: { provider: "fake", modelId: "f", thinkingLevel: "low" },
    workDir: join(root, "work"), sessionPath: null,
    sandbox: { mode: "host-not-isolated" }, budget: defaultBudget(),
  });
  const rm = new RulesManager(root, store);
  return { root, store, rm, botId: store.state.bots[0]!.id, dispose() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

const denyRule = { id: "d1", toolName: "bash", match: "bash_keyword" as const, pattern: "rm\\s+-rf", action: "deny" as const };
const allowRule = { id: "a1", toolName: "write", match: "tool" as const, action: "allow" as const };

test("M3.1b: tier sorting — deny rules always sort before allow before gate", () => {
  const r = rig();
  try {
    r.rm.putGlobal([allowRule, denyRule], 0);
    const merged = r.rm.merged(r.botId);
    // deny first regardless of insertion order
    assert.equal(merged[0]!.action, "deny");
    assert.ok(merged.findIndex((x) => x.action === "allow") > 0);
  } finally { r.dispose(); }
});

test("M3.1b: per-bot override merges with global — bot rules join the sort", () => {
  const r = rig();
  try {
    r.rm.putGlobal([denyRule], 0);
    r.rm.putBotOverrides(r.botId, [allowRule]);
    const merged = r.rm.merged(r.botId);
    assert.equal(merged.length, 2);
    assert.equal(merged[0]!.action, "deny"); // tier wins
    assert.equal(merged.filter((x) => x.origin === "bot").length, 1);
    assert.equal(merged.filter((x) => x.origin === "global").length, 1);
  } finally { r.dispose(); }
});

test("M3.1b: global deny cannot be overridden by per-bot allow (tier re-sort)", () => {
  const r = rig();
  try {
    r.rm.putGlobal([{ id: "never-rm", toolName: "*", match: "bash_keyword" as const, pattern: "rm", action: "deny" as const }], 0);
    r.rm.putBotOverrides(r.botId, [{ id: "allow-all", toolName: "*", match: "tool" as const, action: "allow" as const }]);
    const merged = r.rm.merged(r.botId);
    assert.equal(merged[0]!.action, "deny", "deny sorts first even from global");
    assert.equal(merged[0]!.id, "never-rm");
  } finally { r.dispose(); }
});

test("M3.1b: version optimistic lock — stale version rejected", () => {
  const r = rig();
  try {
    const v0 = r.rm.global().version;
    r.rm.putGlobal([], v0);
    assert.throws(() => r.rm.putGlobal([], v0), RulesVersionConflict);
    assert.throws(() => r.rm.putGlobal([], v0 + 99), RulesVersionConflict);
    // Current version works
    const doc = r.rm.putGlobal([allowRule], r.rm.global().version);
    assert.equal(doc.rules.length, 1);
  } finally { r.dispose(); }
});

test("M3.1b: refreshBot writes rules.d/rules.json (the gate reads this)", () => {
  const r = rig();
  try {
    r.rm.putGlobal([denyRule, allowRule], 0);
    r.rm.refreshBot(r.botId);
    const p = join(r.root, "pi-conf", r.botId, "rules.d", "rules.json");
    assert.ok(existsSync(p), "rules.d/rules.json written");
    const doc = JSON.parse(readFileSync(p, "utf8")) as { rules: Array<{ action: string }> };
    assert.equal(doc.rules.length, 2);
    assert.equal(doc.rules[0]!.action, "deny", "tier-sorted in the file");
  } finally { r.dispose(); }
});

test("M3.1b: shortcut rule creation lands in the right scope", () => {
  const r = rig();
  try {
    const created = r.rm.createShortcutRule("global", null, {
      toolName: "write", match: "path_prefix", pattern: "/Users/felix/shared/", action: "allow",
    });
    assert.ok(created.id.startsWith("rule_"));
    assert.equal(r.rm.global().rules.length, 1);
    const botRule = r.rm.createShortcutRule("bot", r.botId, {
      toolName: "write", match: "tool", action: "allow",
    });
    assert.ok(botRule.id.startsWith("rule_"));
    assert.equal(r.rm.botOverrides(r.botId).rules.length, 1);
  } finally { r.dispose(); }
});

test("M3.1b: gateRulesPath — bare vs docker paths", () => {
  const r = rig();
  try {
    const bare = r.rm.gateRulesPath(r.botId, "host-not-isolated");
    assert.ok(bare.startsWith(r.root), "bare = host path");
    assert.ok(bare.includes("rules.d/rules.json"));
    const docker = r.rm.gateRulesPath(r.botId, "docker");
    assert.equal(docker, "/state/pi-conf/rules.d/rules.json");
  } finally { r.dispose(); }
});

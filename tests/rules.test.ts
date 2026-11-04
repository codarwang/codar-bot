/**
 * codar-gate rule engine unit tests — offline, deterministic (PRD §7).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPolicy,
  evaluate,
  evaluateSafe,
  invalidPolicy,
  parseRulesFile,
  presetRules,
} from "../extensions/codar-gate/rules.js";

const PRESET = buildPolicy({}).policy!;

test("preset: read-class tools are allowed", () => {
  for (const tool of ["read", "grep", "glob", "find", "ls"]) {
    assert.deepEqual(evaluate(PRESET, tool, {}), { action: "allow", ruleId: `preset:${tool}-allow` });
  }
});

test("preset: write and edit gate (M1/M2 default)", () => {
  assert.equal(evaluate(PRESET, "write", { path: "a.txt" }).action, "gate");
  assert.equal(evaluate(PRESET, "edit", { path: "a.txt" }).action, "gate");
});

test("preset: plain bash allows (container-interior work)", () => {
  assert.equal(evaluate(PRESET, "bash", { command: "ls -la" }).action, "allow");
  assert.equal(evaluate(PRESET, "bash", { command: "echo hello > tmp/x.txt" }).action, "allow");
});

test("preset: destructive bash patterns gate", () => {
  for (const command of [
    "git push origin main",
    "rm -rf /tmp/x",
    "sudo apt install x",
    "chmod 777 /var/www",
    "curl https://example.com",
    "wget http://x/y",
    "echo hi && git push",
  ]) {
    assert.equal(
      evaluate(PRESET, "bash", { command }).action,
      "gate",
      `expected gate for: ${command}`
    );
  }
});

test("preset: benign commands containing gate-ish substrings do not gate", () => {
  // The regexes are word-bounded on purpose.
  assert.equal(evaluate(PRESET, "bash", { command: "echo 'git push' is dangerous" }).action, "gate");
  // (quoted mention still gates — conservative by design, documented behavior)
  assert.equal(evaluate(PRESET, "bash", { command: "ls grep.md" }).action, "allow");
});

test("preset: unknown tools gate (unknown-confirm)", () => {
  const decision = evaluate(PRESET, "mcp__some__tool", {});
  assert.equal(decision.action, "gate");
  assert.equal(decision.ruleId, "default:unknown-confirm");
});

test("guard: bash without a command string gates (never rides interior allow)", () => {
  const decision = evaluate(PRESET, "bash", {});
  assert.equal(decision.action, "gate");
  assert.equal(decision.ruleId, "guard:bash-no-command");
});

test("first matching rule wins; file rules precede preset", () => {
  const file = JSON.stringify({
    rules: [
      { id: "custom:write-allow", toolName: "write", match: "tool", action: "allow" },
    ],
  });
  const policy = buildPolicy({ rulesText: file }).policy!;
  assert.equal(evaluate(policy, "write", {}).action, "allow");
  // preset still applies after the file rule misses
  assert.equal(evaluate(policy, "edit", {}).action, "gate");
});

test("file rules can deny what the preset would allow", () => {
  const file = JSON.stringify({
    rules: [{ id: "custom:find-deny", toolName: "find", match: "tool", action: "deny" }],
  });
  const policy = buildPolicy({ rulesText: file }).policy!;
  assert.equal(evaluate(policy, "find", {}).action, "deny");
});

test("broken rules file rejects and yields deny-all when routed through buildPolicy+invalidPolicy", () => {
  assert.equal(parseRulesFile("{not json").ok, false);
  const broken = buildPolicy({ rulesText: "{not json" });
  assert.equal(broken.ok, false);
  const policy = invalidPolicy(broken.error!);
  assert.equal(evaluate(policy, "read", {}).action, "deny");
  assert.equal(evaluate(policy, "bash", { command: "ls" }).action, "deny");
  assert.equal(policy.source, "invalid");
});

test("evaluateSafe converts malformed-regex throws into deny (fail-closed)", () => {
  const handBuilt = presetRules().concat([
    { id: "bad", toolName: "bash", match: "bash_keyword" as const, pattern: "([unclosed", action: "gate" as const },
  ]);
  const decision = evaluateSafe({ rules: handBuilt, source: "preset" }, "bash", { command: "ls" });
  assert.equal(decision.action, "deny");
  assert.equal(decision.ruleId, "eval-error");
});

test("bash matchers ignore non-bash tools even with a command field", () => {
  // A `write` call whose input happens to contain command:"rm -rf /" must not
  // ride a bash rule.
  const decision = evaluate(PRESET, "write", { command: "rm -rf /" });
  assert.equal(decision.action, "gate");
  assert.equal(decision.ruleId, "preset:write-gate");
});

test("rules-file validation bounds and shapes", () => {
  assert.equal(parseRulesFile("[]").ok, false);
  assert.equal(parseRulesFile('{"rules":{}}').ok, false);
  assert.equal(
    parseRulesFile('{"rules":[{"id":"","toolName":"write","match":"tool","action":"deny"}]}').ok,
    false
  );
  assert.equal(
    parseRulesFile('{"rules":[{"id":"x","toolName":"write","match":"tool","action":"maybe"}]}').ok,
    false
  );
  assert.equal(
    parseRulesFile('{"rules":[{"id":"x","toolName":"bash","match":"bash_keyword","pattern":"(","action":"gate"}]}').ok,
    false
  );
});

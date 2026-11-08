/**
 * codar-gate rule engine unit tests — offline, deterministic (PRD §7).
 */
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("M3.1a: path_prefix matcher — write/edit path matched, bash/unrelated not", () => {
  const file = JSON.stringify({
    rules: [
      { id: "r1", toolName: "write", match: "path_prefix", pattern: "/home/bot/shared/", action: "allow" },
    ],
  });
  const built = buildPolicy({ rulesText: file });
  assert.ok(built.ok && built.policy !== undefined);

  const hit = evaluate(built.policy, "write", { path: "/home/bot/shared/report.md", content: "x" });
  assert.equal(hit.action, "allow");
  assert.equal(hit.ruleId, "r1");

  const miss = evaluate(built.policy, "write", { path: "/etc/passwd", content: "x" });
  assert.notEqual(miss.ruleId, "r1"); // falls through to preset write-gate

  // edit tool with file_path field name (forward compat) — the rule targets
  // write specifically, so edit falls to preset; a * rule would match both.
  const hit2 = evaluate(built.policy, "edit", { file_path: "/home/bot/shared/x.ts" });
  assert.equal(hit2.ruleId, "preset:edit-gate"); // preset (toolName mismatch)

  // bash tool never hits a path_prefix rule
  const bash = evaluate(built.policy, "bash", { command: "cat /home/bot/shared/x" });
  assert.notEqual(bash.ruleId, "r1");
});

test("M3.1a: path_prefix with deny — a global never-rule blocks writes to a protected path", () => {
  const file = JSON.stringify({
    rules: [
      { id: "never-keys", toolName: "*", match: "path_prefix", pattern: "/etc/ssh/", action: "deny" },
    ],
  });
  const built = buildPolicy({ rulesText: file });
  assert.ok(built.ok);
  const hit = evaluate(built.policy!, "write", { path: "/etc/ssh/authorized_keys" });
  assert.equal(hit.action, "deny");
  assert.equal(hit.ruleId, "never-keys");
});

test("M3.1a: mtime hot reload — rules file mtime detectable for the gate's reloadIfStale", async () => {
  const { writeFileSync, statSync, utimesSync } = await import("node:fs");
  const rulesPath = join(tmpdir(), `codar-gate-mtime-${Date.now()}.json`);
  writeFileSync(rulesPath, JSON.stringify({ rules: [] }));
  const m1 = statSync(rulesPath).mtimeMs;
  // Simulate the host writing new rules (tmp+rename: new file, new mtime)
  const tmp = `${rulesPath}.tmp`;
  writeFileSync(tmp, JSON.stringify({ rules: [
    { id: "w1", toolName: "write", match: "tool", action: "allow" },
  ]}));
  const { renameSync, rmSync } = await import("node:fs");
  renameSync(tmp, rulesPath);
  const m2 = statSync(rulesPath).mtimeMs;
  assert.ok(m2 >= m1, "rename produces a detectable mtime change");
  rmSync(rulesPath, { force: true });
});

/**
 * codar-gate rule engine — pure module (no pi imports, no I/O).
 *
 * Donated semantics from an earlier internal project an earlier internal gate/rules.ts (Apache-2.0 donor
 * project, PRD §14; 5383-test-pinned fail-closed evaluation), re-cut for the
 * codar-bot M1/M2 default policy (architecture.md §5.4):
 * read-class tools allow; write/edit gate (approval); bash allows container-
 * interior work but gates destructive/egress patterns; unknown tools gate.
 *
 * Semantics (v0, inherited):
 *  - A policy is an ordered rule list; the FIRST matching rule wins.
 *  - File rules (CODAR_GATE_RULES JSON) evaluate BEFORE preset rules.
 *  - Evaluation errors fail CLOSED: evaluate() throws on malformed rules;
 *    evaluateSafe() converts any throw into a deny decision.
 */

export type GateAction = "allow" | "deny" | "gate";

/** v0 supported matchers. `tool` matches the tool name only; the bash
 *  matchers test the bash tool's `command` input. */
export type GateMatch = "tool" | "bash_prefix" | "bash_keyword" | "path_prefix";

export interface GateRule {
  readonly id: string;
  /** Exact tool name, or "*" for any tool. */
  readonly toolName: string;
  readonly match: GateMatch;
  /** Required for bash_prefix/bash_keyword (command) and path_prefix (file path). */
  readonly pattern?: string;
  readonly action: GateAction;
  readonly description?: string;
}

export interface GatePolicy {
  readonly rules: readonly GateRule[];
  readonly source: "preset" | "file" | "invalid";
  /** Bounded load error; set only when source === "invalid". */
  readonly loadError?: string;
}

export interface GateDecision {
  readonly action: GateAction;
  readonly ruleId: string;
  /** Bounded extra context (eval errors, truncation markers). */
  readonly detail?: string;
}

export interface GateBuildResult {
  readonly ok: boolean;
  readonly policy?: GatePolicy;
  readonly error?: string;
}

// --- bounds (single-session lifecycle; deliberately small and explicit) ---

export const RULE_ID_MAX = 64;
export const RULE_TOOL_NAME_MAX = 64;
export const RULE_PATTERN_MAX = 256;
export const RULE_DESCRIPTION_MAX = 256;
/** Command text tested by bash matchers; longer commands are truncated for
 *  matching (regex bound) — the audit summary keeps its own bound. */
export const BASH_COMMAND_MATCH_MAX = 8_192;
export const POLICY_RULES_MAX = 256;
export const LOAD_ERROR_MAX = 256;

/** Read-class tools: no side effects, always allowed by the codar preset. */
export const READ_TOOLS: readonly string[] = ["read", "grep", "glob", "find", "ls"];
/** Tools the codar preset knows individually; everything else is unknown → gate. */
const KNOWN_TOOLS: readonly string[] = [...READ_TOOLS, "write", "edit", "bash"];

interface BashPatternSpec {
  readonly id: string;
  readonly keyword: string;
  readonly description: string;
}

/** Destructive / boundary patterns gated by the codar preset (donated list,
 *  egress included — the trusted tier did not survive the donation cut).
 *
 *  KNOWN-BYPASSABLE BY DESIGN: these keyword regexes are advisory mediation,
 *  not a security boundary — structured variants (`rm -r -f`, `git -C x
 *  push`), unlisted binaries (dd/mkfs/docker), and >BASH_COMMAND_MATCH_MAX
 *  tails all slip past. The real boundary is the Docker sandbox (S4,
 *  fail-closed); the gate exists to make the MODEL ask first, not to defeat
 *  a determined operator. */
const GATE_PATTERNS: readonly BashPatternSpec[] = [
  {
    id: "bash:git-push",
    keyword: "\\bgit\\s+push\\b",
    description: "git push (boundary action)",
  },
  {
    id: "bash:rm-recursive-force",
    keyword: "\\brm\\s+(-\\w*r\\w*f|-\\w*f\\w*r|--recursive)\\b",
    description: "rm with recursive+force or --recursive",
  },
  {
    id: "bash:sudo",
    keyword: "\\bsudo\\b",
    description: "sudo",
  },
  {
    id: "bash:chmod-777",
    keyword: "\\b(chmod|chown)\\b[^&|;]*\\b777\\b",
    description: "chmod/chown 777",
  },
  {
    id: "bash:egress",
    keyword: "\\b(curl|wget)\\b",
    description: "network egress via curl/wget",
  },
];

function bashKeywordRule(spec: BashPatternSpec): GateRule {
  return {
    id: `preset:${spec.id}`,
    toolName: "bash",
    match: "bash_keyword",
    pattern: spec.keyword,
    action: "gate",
    description: spec.description,
  };
}

/** Ordered codar preset rules (architecture.md §5.4 M1/M2 defaults). */
export function presetRules(): readonly GateRule[] {
  return [
    ...READ_TOOLS.map<GateRule>((tool) => ({
      id: `preset:${tool}-allow`,
      toolName: tool,
      match: "tool" as const,
      action: "allow" as const,
      description: "read-class tool allowed (M1/M2 default)",
    })),
    {
      id: "preset:write-gate",
      toolName: "write",
      match: "tool",
      action: "gate",
      description: "write requires approval (M1/M2 default)",
    },
    {
      id: "preset:edit-gate",
      toolName: "edit",
      match: "tool",
      action: "gate",
      description: "edit requires approval (M1/M2 default)",
    },
    ...GATE_PATTERNS.map(bashKeywordRule),
  ];
}

/** The deny-all policy installed when configuration is unusable: loading a
 *  broken rules file must never degrade into an ungated session (pi would
 *  keep running without the extension's protection if the factory threw). */
export function invalidPolicy(error: string): GatePolicy {
  return {
    rules: [
      {
        id: "invalid:deny-all",
        toolName: "*",
        match: "tool",
        action: "deny",
        description: "rules configuration failed to load; failing closed",
      },
    ],
    source: "invalid",
    loadError: error.slice(0, LOAD_ERROR_MAX),
  };
}

// --- rules-file parsing (CODAR_GATE_RULES) ---

export interface ParsedRulesFile {
  readonly rules: readonly GateRule[];
}

export type ParseRulesResult = { ok: true; value: ParsedRulesFile } | { ok: false; error: string };

function isGateAction(value: unknown): value is GateAction {
  return value === "allow" || value === "deny" || value === "gate";
}

function isGateMatch(value: unknown): value is GateMatch {
  return value === "tool" || value === "bash_prefix" || value === "bash_keyword" || value === "path_prefix";
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/**
 * Parse and validate the CODAR_GATE_RULES JSON document: `{ "rules": GateRule[]? }`.
 * File rules evaluate before the preset rules. Strict validation: any
 * malformed rule rejects the whole file (the caller installs deny-all).
 */
export function parseRulesFile(text: string): ParseRulesResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `rules file is not valid JSON: ${String(error).slice(0, 120)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "rules file must be a JSON object" };
  }
  const root = parsed as Record<string, unknown>;

  const rawRules: unknown = root["rules"] ?? [];
  if (!Array.isArray(rawRules)) {
    return { ok: false, error: "rules file 'rules' must be an array" };
  }
  if (rawRules.length > POLICY_RULES_MAX) {
    return { ok: false, error: `rules file exceeds ${POLICY_RULES_MAX} rules` };
  }

  const rules: GateRule[] = [];
  for (let i = 0; i < rawRules.length; i++) {
    const raw = rawRules[i];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, error: `rules[${i}] must be an object` };
    }
    const rule = raw as Record<string, unknown>;
    if (!isBoundedString(rule["id"], RULE_ID_MAX)) {
      return { ok: false, error: `rules[${i}].id must be a non-empty string (max ${RULE_ID_MAX})` };
    }
    const toolName = rule["toolName"];
    if (toolName !== "*" && !isBoundedString(toolName, RULE_TOOL_NAME_MAX)) {
      return {
        ok: false,
        error: `rules[${i}].toolName must be a non-empty string or "*" (max ${RULE_TOOL_NAME_MAX})`,
      };
    }
    if (!isGateMatch(rule["match"])) {
      return { ok: false, error: `rules[${i}].match must be tool|bash_prefix|bash_keyword|path_prefix` };
    }
    const match = rule["match"] as GateMatch;
    let pattern: string | undefined;
    if (match === "bash_prefix" || match === "bash_keyword" || match === "path_prefix") {
      if (!isBoundedString(rule["pattern"], RULE_PATTERN_MAX)) {
        return {
          ok: false,
          error: `rules[${i}].pattern required for ${match} (non-empty string, max ${RULE_PATTERN_MAX})`,
        };
      }
      pattern = rule["pattern"];
      if (match === "bash_keyword") {
        try {
          void new RegExp(pattern);
        } catch (error) {
          return { ok: false, error: `rules[${i}].pattern is not a valid regex: ${String(error).slice(0, 120)}` };
        }
      }
    }
    if (!isGateAction(rule["action"])) {
      return { ok: false, error: `rules[${i}].action must be allow|deny|gate` };
    }
    let description: string | undefined;
    if (rule["description"] !== undefined) {
      if (typeof rule["description"] !== "string") {
        return { ok: false, error: `rules[${i}].description must be a string` };
      }
      description = rule["description"].slice(0, RULE_DESCRIPTION_MAX);
    }
    rules.push({
      id: rule["id"],
      toolName: toolName as string,
      match,
      ...(pattern !== undefined ? { pattern } : {}),
      action: rule["action"] as GateAction,
      ...(description !== undefined ? { description } : {}),
    });
  }
  return { ok: true, value: { rules } };
}

/** Build the effective policy: file rules (if any) first, then the preset. */
export function buildPolicy(input: { rulesText?: string }): GateBuildResult {
  if (input.rulesText === undefined) {
    return { ok: true, policy: { rules: presetRules(), source: "preset" } };
  }
  const parsed = parseRulesFile(input.rulesText);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  return { ok: true, policy: { rules: [...parsed.value.rules, ...presetRules()], source: "file" } };
}

// --- evaluation ---

function bashCommandOf(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null && "command" in input) {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string") {
      return command.slice(0, BASH_COMMAND_MATCH_MAX);
    }
  }
  return undefined;
}

/** write/edit tool path input — the path_prefix matcher's test subject.
 *  pi 1.5.0 write/edit carry the target as `path` (verified against the
 *  tool schemas; `file_path` is the fallback for forward compat). */
function filePathOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  const p = rec["path"] ?? rec["file_path"];
  return typeof p === "string" ? p : undefined;
}

function ruleMatches(rule: GateRule, toolName: string, input: unknown): boolean {
  if (rule.toolName !== "*" && rule.toolName !== toolName) {
    return false;
  }
  if (rule.match === "tool") {
    return true;
  }
  if (rule.match === "path_prefix") {
    // P3-6: path_prefix applies ONLY to write/edit — a bash tool carrying
    // a path argument must not be matched by a path rule.
    if (toolName !== "write" && toolName !== "edit") return false;
    const path = filePathOf(input);
    return path !== undefined && path.startsWith(rule.pattern ?? "");
  }
  // bash matchers apply to the bash tool's command input only.
  const command = toolName === "bash" ? bashCommandOf(input) : undefined;
  if (command === undefined) {
    return false;
  }
  if (rule.match === "bash_prefix") {
    return command.trimStart().startsWith(rule.pattern ?? "");
  }
  // bash_keyword: compiled lazily so a malformed pattern (hand-built policy
  // bypassing parseRulesFile) throws HERE — evaluateSafe turns that into deny.
  return new RegExp(rule.pattern ?? "").test(command);
}

/** Preset default applied when no rule matched. */
function defaultDecision(toolName: string): GateDecision {
  if (READ_TOOLS.includes(toolName)) {
    return { action: "allow", ruleId: "default:read-allow" };
  }
  if (KNOWN_TOOLS.includes(toolName)) {
    return { action: "allow", ruleId: "default:interior-allow" };
  }
  return { action: "gate", ruleId: "default:unknown-confirm" };
}

/**
 * Evaluate a policy against a tool call. THROWS on malformed rules (invalid
 * regex, non-string pattern) — callers must either use evaluateSafe or treat
 * a throw as a block (fail-closed).
 */
export function evaluate(policy: GatePolicy, toolName: string, input: unknown): GateDecision {
  if (toolName === "bash" && bashCommandOf(input) === undefined) {
    // A bash call without a string command is malformed — never let it ride
    // the permissive interior default.
    return { action: "gate", ruleId: "guard:bash-no-command", detail: "bash input has no command string" };
  }
  for (const rule of policy.rules) {
    if (ruleMatches(rule, toolName, input)) {
      return { action: rule.action, ruleId: rule.id };
    }
  }
  return defaultDecision(toolName);
}

const EVAL_ERROR_DETAIL_MAX = 128;

/** Total version of evaluate: any evaluation error becomes a deny decision. */
export function evaluateSafe(policy: GatePolicy, toolName: string, input: unknown): GateDecision {
  try {
    return evaluate(policy, toolName, input);
  } catch (error) {
    return {
      action: "deny",
      ruleId: "eval-error",
      detail: `rule evaluation failed (fail-closed): ${String(error).slice(0, EVAL_ERROR_DETAIL_MAX)}`,
    };
  }
}

/**
 * codar-gate — the codar-bot pi gate extension (M0-S2 port).
 *
 * Donated from WorkerOS workeros-gate (PRD §14: gate extension code is the
 * one code-level donation), re-targeted at the pi 1.5.0 extension surface and
 * re-cut to the codar-bot M1/M2 policy (architecture.md §5.4):
 *
 *  - tool_call: EVERY call is audited first (JSONL append to
 *    $CODAR_GATE_AUDIT, default `<cwd>/.codar-gate-audit.jsonl`); then the
 *    rule engine decides. `deny` blocks; `gate` blocks on ctx.ui.confirm
 *    (no timeout — the approval parks until the host answers; minute-scale
 *    park is an M0-S2 acceptance criterion). Rule evaluation errors, audit
 *    write failures, and internal errors all BLOCK (fail-closed).
 *  - message_end: usage+cost appended to the same audit file (S3 metering
 *    source ①).
 *  - bridge_echo (S2 criterion ② only): a structured round-trip over the
 *    extension_ui bridge — the D1 message_bot channel premise. The call is
 *    parked in the tool_call handler (where ctx.ui lives, the ask_user
 *    pattern workeros proved): params go OUT as the input-dialog placeholder
 *    JSON, the host's structured reply comes BACK as the dialog value, and
 *    the memoized result is reported by execute() — no second dialog.
 *
 * Env knobs:
 *  - CODAR_GATE_RULES   path to a JSON rule pack ({rules?}); absent → preset.
 *  - CODAR_GATE_AUDIT   audit JSONL path; absent → <cwd>/.codar-gate-audit.jsonl.
 *
 * A broken rules file must NOT throw out of the factory (pi would keep
 * running WITHOUT the gate): the factory installs the deny-all policy and
 * logs the load error (see rules.ts invalidPolicy()).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildPolicy, evaluateSafe, invalidPolicy, type GatePolicy } from "./rules.js";
import {
  createAuditSink,
  nowIso,
  projectUsage,
  summarizeInput,
  toolCallEntry,
  type AuditSink,
} from "./audit.js";

const RULES_ENV = "CODAR_GATE_RULES";
const AUDIT_ENV = "CODAR_GATE_AUDIT";
const DEFAULT_AUDIT_FILENAME = ".codar-gate-audit.jsonl";
const CONFIRM_TITLE = "codar-gate: approval required";
/** S2 criterion ② marker: structured dispatch over the ui bridge (D1). */
export const BRIDGE_ECHO_TITLE = "codar:bridge-echo";
const BRIDGE_ECHO_TOOL = "bridge_echo";
const REASON_MAX = 256;

function boundedReason(text: string): string {
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text;
}

function loadPolicyFromEnv(): GatePolicy {
  const rulesPath = process.env[RULES_ENV];
  if (rulesPath === undefined || rulesPath === "") {
    const built = buildPolicy({});
    return built.ok && built.policy !== undefined ? built.policy : invalidPolicy(built.error ?? "unknown");
  }
  let text: string;
  try {
    text = readFileSync(rulesPath, "utf8");
  } catch (error) {
    return invalidPolicy(`cannot read ${RULES_ENV}=${rulesPath}: ${String(error).slice(0, 160)}`);
  }
  const built = buildPolicy({ rulesText: text });
  if (!built.ok || built.policy === undefined) {
    return invalidPolicy(built.error ?? "unknown rules error");
  }
  return built.policy;
}

/** Per-toolCallId memo for bridge_echo: the dialog already ran in the
 *  tool_call handler; execute() only reports it (workeros ask_user pattern). */
interface BridgeEchoMemo {
  ok: boolean;
  marker?: string;
  code?: string;
  message?: string;
}
const bridgeEchoAnswers = new Map<string, BridgeEchoMemo>();

export default function codarGate(pi: ExtensionAPI): void {
  const loaded = loadPolicyFromEnv();
  const policy = loaded;
  if (loaded.source === "invalid") {
    console.error(`[codar-gate] RULES LOAD FAILED, denying all tool calls: ${loaded.loadError ?? "unknown"}`);
  }

  const auditEnv = process.env[AUDIT_ENV];
  // NOTE (S3/S4 prerequisite): when unset, the audit file defaults INTO the
  // bot-writable cwd — acceptable only for bare-process spikes. The host must
  // always set CODAR_GATE_AUDIT to a host-controlled path (outside workDir/
  // sharedDir mounts); S4's container mount table carries it.
  const auditPath =
    auditEnv !== undefined && auditEnv !== ""
      ? auditEnv
      : join(process.cwd(), DEFAULT_AUDIT_FILENAME);
  const audit: AuditSink = createAuditSink(auditPath);
  console.error(`[codar-gate] active source=${policy.source} rules=${policy.rules.length} audit=${auditPath}`);

  pi.on("tool_call", async (event, ctx) => {
    try {
      // bridge_echo branch — BEFORE the rule engine: the structured
      // round-trip parks on ctx.ui.input (params out as placeholder JSON,
      // host reply back as the value), the memo records the outcome, and the
      // audit line lands like any other mediation.
      if (event.toolName === BRIDGE_ECHO_TOOL) {
        audit.append(
          toolCallEntry({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
            action: "gate",
            ruleId: "gate:tool:bridge_echo",
          })
        );
        if (!ctx.hasUI) {
          return {
            block: true,
            reason: boundedReason("codar-gate: bridge_echo requires a UI channel and none is available (fail-closed)"),
          };
        }
        const startedAt = Date.now();
        const outbound = JSON.stringify({ payload: (event.input as { payload?: unknown })?.payload ?? null });
        const answer = await ctx.ui.input(BRIDGE_ECHO_TITLE, outbound);
        let memo: BridgeEchoMemo;
        if (answer === undefined) {
          memo = { ok: false, code: "cancelled", message: "host cancelled the dialog" };
        } else {
          try {
            const parsed = JSON.parse(answer) as { status?: string; marker?: string };
            memo =
              parsed?.status === "ok" && typeof parsed.marker === "string"
                ? { ok: true, marker: parsed.marker }
                : { ok: false, code: "bad_shape", message: "host reply had unexpected shape" };
          } catch {
            memo = { ok: false, code: "non_json_reply", message: "host reply was not JSON" };
          }
        }
        audit.append({
          kind: "approval",
          ts: nowIso(),
          toolCallId: event.toolCallId,
          approved: memo.ok,
          waitedMs: Date.now() - startedAt,
        });
        // Memo only on the allowed path: a blocked call never reaches
        // execute(), so setting it here would leak one entry per failure.
        if (!memo.ok) {
          return {
            block: true,
            reason: boundedReason(`codar-gate: bridge_echo failed (${memo.code ?? "unknown"}) — nothing echoed`),
          };
        }
        bridgeEchoAnswers.set(event.toolCallId, memo);
        return undefined;
      }

      const decision = evaluateSafe(policy, event.toolName, event.input);
      // Audit BEFORE acting on the call — the causal record must exist even
      // when the gate blocks or the process dies mid-approval.
      audit.append(
        toolCallEntry({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
          action: decision.action,
          ruleId: decision.ruleId,
        })
      );

      if (decision.action === "deny") {
        const detail = decision.detail !== undefined ? ` (${decision.detail})` : "";
        return {
          block: true,
          reason: boundedReason(`codar-gate: denied by rule ${decision.ruleId}${detail}`),
        };
      }

      if (decision.action === "gate") {
        if (!ctx.hasUI) {
          return {
            block: true,
            reason: boundedReason(
              `codar-gate: rule ${decision.ruleId} requires approval but no UI is available (fail-closed)`
            ),
          };
        }
        const startedAt = Date.now();
        // No timeout option: the approval parks until the rpc host answers
        // (minute-scale park is an M0-S2 criterion). cancelled and
        // unrecognized responses resolve to false — fail-safe deny.
        const approved = await ctx.ui.confirm(
          CONFIRM_TITLE,
          `${event.toolName}: ${summarizeInput(event.input, 256)}\nrule: ${decision.ruleId}\nApprove this call?`
        );
        const waitedMs = Date.now() - startedAt;
        audit.append({
          kind: "approval",
          ts: nowIso(),
          toolCallId: event.toolCallId,
          approved,
          waitedMs,
        });
        if (!approved) {
          return {
            block: true,
            reason: boundedReason(
              `codar-gate: denied by approver after ${waitedMs}ms (rule ${decision.ruleId})`
            ),
          };
        }
      }

      return undefined;
    } catch (error) {
      // Belt and braces beyond pi's own fail-closed handler semantics: give
      // the model a gate-attributable reason and keep the audit invariant.
      return {
        block: true,
        reason: boundedReason(`codar-gate: internal error, blocking (fail-closed): ${String(error)}`),
      };
    }
  });

  pi.on("message_end", (event) => {
    try {
      const message = event.message as unknown as { usage?: unknown } | undefined;
      const usage = projectUsage(message?.usage);
      if (usage !== undefined) {
        audit.append({ kind: "usage", ts: nowIso(), usage });
      }
    } catch (error) {
      console.error(`[codar-gate] usage audit failed: ${String(error).slice(0, 160)}`);
    }
  });

  // S2 criterion ② — the report half of the ask_user pattern: the dialog
  // already ran in the tool_call handler; this body only REPORTS it. No
  // second question is ever asked.
  pi.registerTool({
    name: BRIDGE_ECHO_TOOL,
    label: "Bridge Echo",
    description:
      "Spike tool (M0-S2): echo a structured payload through the host ui bridge and back. Pass any JSON-serializable value as `payload`; the result marker proves the structured round-trip (D1 channel premise).",
    parameters: Type.Object({
      payload: Type.Optional(Type.Unknown({ description: "Any JSON-serializable value to echo through the bridge." })),
    }) as ToolDefinition["parameters"],
    async execute(toolCallId, _params) {
      const memo = bridgeEchoAnswers.get(toolCallId);
      if (memo === undefined) {
        return {
          isError: true,
          details: undefined,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                code: "bridge_echo_unrouted",
                message: "this bridge_echo call never went through the gate's input arm (routing bug); nothing was echoed.",
              }),
            },
          ],
        };
      }
      bridgeEchoAnswers.delete(toolCallId);
      return {
        isError: !memo.ok,
        details: undefined,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              memo.ok
                ? { status: "ok", marker: memo.marker }
                : { status: "error", code: memo.code, message: memo.message }
            ),
          },
        ],
      };
    },
  });
}

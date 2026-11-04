/**
 * codar-gate audit sink — bounded JSONL append to a single file.
 *
 * Donated semantics from WorkerOS workeros-gate/audit.ts (PRD §14): every
 * tool call is audited BEFORE the gate acts on it ("先记审计"), approvals are
 * audited when they resolve, and message_end usage+cost is appended to the
 * SAME file (S3 metering source ①).
 *
 * Bounds: every field is explicitly bounded and every serialized line is
 * hard-capped (AUDIT_LINE_MAX). Single-session lifecycle: append-only, no
 * rotation. A write failure must propagate to the caller — the gate treats
 * "cannot audit" as "cannot allow" (fail-closed).
 */

import { appendFileSync } from "node:fs";
import type { GateAction } from "./rules.js";

// --- bounds ---

export const AUDIT_INPUT_SUMMARY_MAX = 512;
export const AUDIT_TOOL_NAME_MAX = 128;
export const AUDIT_TOOL_CALL_ID_MAX = 128;
export const AUDIT_RULE_ID_MAX = 128;
export const AUDIT_LINE_MAX = 2_048;

// --- entry shapes (stable field order for deterministic lines) ---

export interface AuditToolCallEntry {
  readonly kind: "tool_call";
  readonly ts: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly inputSummary: string;
  readonly action: GateAction;
  readonly ruleId: string;
}

export interface AuditApprovalEntry {
  readonly kind: "approval";
  readonly ts: string;
  readonly toolCallId: string;
  readonly approved: boolean;
  readonly waitedMs: number;
}

/** Whitelisted projection of pi's Usage object — numeric fields only, so the
 *  audit line is bounded by construction regardless of provider extras. */
export interface UsageAuditRecord {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** Subset of cacheWrite with 1h retention (Anthropic-only split, pi-ai
   *  1.5.0); usage.sqlite has a dedicated column (architecture §4). */
  readonly cacheWrite1h?: number;
  readonly totalTokens: number;
  readonly reasoning?: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
    /** True when the provider's own billed total was used instead of the
     *  catalog price (pi-ai 1.5.0) — the S3 cost-unit question in a flag. */
    readonly totalFromProvider?: boolean;
  };
}

export interface AuditUsageEntry {
  readonly kind: "usage";
  readonly ts: string;
  readonly usage: UsageAuditRecord;
}

export type AuditEntry = AuditToolCallEntry | AuditApprovalEntry | AuditUsageEntry;

// --- pure formatting helpers ---

export function nowIso(): string {
  return new Date().toISOString();
}

/** Bounded JSON summary of a tool input; unserializable inputs degrade to a
 *  marker string instead of throwing. */
export function summarizeInput(input: unknown, maxLen: number = AUDIT_INPUT_SUMMARY_MAX): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? "null";
  } catch {
    return "[unserializable-input]";
  }
  if (text.length > maxLen) {
    return `${text.slice(0, maxLen)}…[truncated ${text.length - maxLen}]`;
  }
  return text;
}

function bounded(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function numOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Project an unknown usage payload onto the whitelisted record. Returns
 *  undefined when nothing numeric is present (nothing to audit). */
export function projectUsage(raw: unknown): UsageAuditRecord | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const usage = raw as Record<string, unknown>;
  const costRaw = usage["cost"];
  const cost =
    typeof costRaw === "object" && costRaw !== null ? (costRaw as Record<string, unknown>) : {};
  const record: UsageAuditRecord = {
    input: numOrZero(usage["input"]),
    output: numOrZero(usage["output"]),
    cacheRead: numOrZero(usage["cacheRead"]),
    cacheWrite: numOrZero(usage["cacheWrite"]),
    ...(typeof usage["cacheWrite1h"] === "number" && Number.isFinite(usage["cacheWrite1h"])
      ? { cacheWrite1h: usage["cacheWrite1h"] }
      : {}),
    totalTokens: numOrZero(usage["totalTokens"]),
    ...(typeof usage["reasoning"] === "number" && Number.isFinite(usage["reasoning"])
      ? { reasoning: usage["reasoning"] }
      : {}),
    cost: {
      input: numOrZero(cost["input"]),
      output: numOrZero(cost["output"]),
      cacheRead: numOrZero(cost["cacheRead"]),
      cacheWrite: numOrZero(cost["cacheWrite"]),
      total: numOrZero(cost["total"]),
      ...(cost["totalFromProvider"] === true ? { totalFromProvider: true } : {}),
    },
  };
  const hasAnyNumber =
    record.input !== 0 ||
    record.output !== 0 ||
    record.cacheRead !== 0 ||
    record.cacheWrite !== 0 ||
    record.totalTokens !== 0 ||
    record.cost.total !== 0;
  return hasAnyNumber ? record : undefined;
}

/** Serialize one entry to a single hard-bounded JSONL line (with trailing
 *  newline). Oversized lines are replaced by a truncation marker line so the
 *  file stays parseable line-by-line. */
export function formatAuditLine(entry: AuditEntry): string {
  const line = JSON.stringify(entry);
  if (line.length <= AUDIT_LINE_MAX) {
    return `${line}\n`;
  }
  return `${JSON.stringify({
    kind: entry.kind,
    ts: entry.ts,
    truncated: true,
    originalBytes: line.length,
  })}\n`;
}

/** Normalize and bound a tool_call entry's free-form fields. */
export function toolCallEntry(fields: {
  toolCallId: string;
  toolName: string;
  input: unknown;
  action: GateAction;
  ruleId: string;
  ts?: string;
}): AuditToolCallEntry {
  return {
    kind: "tool_call",
    ts: fields.ts ?? nowIso(),
    toolCallId: bounded(fields.toolCallId, AUDIT_TOOL_CALL_ID_MAX),
    toolName: bounded(fields.toolName, AUDIT_TOOL_NAME_MAX),
    inputSummary: summarizeInput(fields.input),
    action: fields.action,
    ruleId: bounded(fields.ruleId, AUDIT_RULE_ID_MAX),
  };
}

// --- sink ---

export interface AuditSink {
  readonly path: string;
  /** Append one entry. THROWS on filesystem failure — callers fail closed. */
  append(entry: AuditEntry): void;
}

export function createAuditSink(path: string): AuditSink {
  return {
    path,
    append(entry: AuditEntry): void {
      appendFileSync(path, formatAuditLine(entry), "utf8");
    },
  };
}

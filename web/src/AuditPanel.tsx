/**
 * AuditPanel — M3.3 audit timeline (architecture m3 §4): merged host + gate
 * timeline with bot/kind/since filters, `before`-cursor paging, and JSONL
 * export of the loaded entries. Collapsed by default (the right column is
 * glance-first; audit is an on-demand drill-down).
 */
import { useEffect, useRef, useState } from "react";
import { jsonFetch } from "./api";

type T = ReturnType<typeof import("./i18n").makeT>;
type Overview = import("./api").Overview;
interface AuditResult {
  entries: AuditRow[];
  /** Oldest ts of the page, or null when exhausted (JSON null, not undefined). */
  cursor?: string | null;
}

/** Every kind the audit sources really write — host has three writers
 * (bot-manager, budget, memory) plus the gate extension (r5 P2-a: the
 * original list missed 8 of 17 kinds, so those rows were unfilterable). */
const KINDS = [
  "approval", "tool_call", "usage", "rule_created", "lifecycle", "bot_failed", "start_failed",
  "session-auto-reset", "session_path_unmappable",
  "budget-check-error", "budget-warn", "budget-stop",
  "memory-review", "memory-review-failed", "memory-review-torn", "memory-review-skipped", "memory-review-rejected",
] as const;
const SINCE_MS: Record<string, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 };
const PAGE = 50;

interface AuditRow {
  ts: string;
  kind: string;
  botId?: string;
  [k: string]: unknown;
}

/** One-line detail per kind, keyed to the fields each writer emits:
 *  approval→resolvedAs(host)/approved(gate), tool_call→toolName+inputSummary,
 *  budget-warn/stop→dimension used/limit[→stopResult], memory-review→
 *  turns→files, everything else falls through the reason/error chain. */
function detailOf(e: AuditRow): string {
  if (e.kind === "budget-warn" || e.kind === "budget-stop") {
    return `${String(e.dimension)} ${String(e.used)}/${String(e.limit)}` +
      (e.stopResult !== undefined ? ` → ${String(e.stopResult)}` : "") +
      (e.error !== undefined ? ` (${String(e.error)})` : "");
  }
  if (e.kind === "tool_call") return `${String(e.toolName)} ${String(e.inputSummary ?? "")}`;
  if (e.kind === "memory-review") return `${String(e.turns)} turns → ${String(e.files)} files`;
  if (e.kind === "usage") {
    const u = e.usage as { input?: number; output?: number } | undefined;
    return u !== undefined ? `${u.input ?? 0}/${u.output ?? 0} tok` : "";
  }
  return String(e.resolvedAs ?? e.approved ?? e.reason ?? e.error ?? e.detail ?? e.dropped ?? e.ruleSpec ?? e.childPath ?? e.hostPath ?? "");
}

interface Props {
  t: T;
  overview: Overview | null;
}

export function AuditPanel(p: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [bot, setBot] = useState("all");
  const [kind, setKind] = useState("all");
  const [since, setSince] = useState("all");
  const [entries, setEntries] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // r5 P3: no request sequencing → a slow response from an older filter
  // could land last and overwrite the fresh one (last-writer-wins). Every
  // fetch takes a ticket; stale responses drop themselves.
  const seq = useRef(0);
  // `since` is computed from Date.now() at page-1 time and frozen for the
  // whole page walk — recomputing per page shifts the boundary row.
  const sinceIso = useRef<string | null>(null);

  async function fetchPage(mode: "first" | "more", beforeTs?: string): Promise<void> {
    const my = ++seq.current;
    if (mode === "first") sinceIso.current = since !== "all" ? new Date(Date.now() - SINCE_MS[since]!).toISOString() : null;
    setLoading(true);
    setErr(null);
    try {
      const q = new URLSearchParams();
      if (bot !== "all") q.set("bot", bot);
      if (kind !== "all") q.set("kind", kind);
      if (sinceIso.current !== null) q.set("since", sinceIso.current);
      if (mode === "more" && beforeTs !== undefined) q.set("before", beforeTs);
      q.set("limit", String(PAGE));
      const r = await jsonFetch<AuditResult>(`/api/audit?${q.toString()}`);
      if (my !== seq.current) return; // a newer filter/page request superseded us
      setEntries((prev) => (mode === "more" ? [...prev, ...r.entries] : r.entries));
      setCursor(r.cursor ?? undefined);
    } catch (e) {
      if (my === seq.current) setErr(String(e).slice(0, 120));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }

  // Filter changes / opening → fresh page 1. fetchPage closes over the
  // current bot/kind/since, and this effect re-runs exactly when those
  // change, so the fetch always uses what the user just picked.
  useEffect(() => {
    if (open) void fetchPage("first");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bot, kind, since]);

  const exportJsonl = (): void => {
    const blob = new Blob([entries.map((e) => JSON.stringify(e)).join("\n") + "\n"], { type: "application/jsonl" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `codar-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
    a.click();
    // Revoking synchronously can race the browser's download grab; defer.
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  };

  const botName = (id: string | undefined): string =>
    id === undefined ? "?" : p.overview?.bots.find((b) => b.id === id)?.name ?? id;
  const fmtTs = (ts: string): string => ts.replace("T", " ").replace(/(Z|\.\d{3}Z)$/, "");

  return (
    <section className="panel">
      <h3>
        {p.t.auditTitle}{" "}
        <button className="ghost mini" aria-expanded={open} aria-label={p.t.auditTitle} onClick={() => setOpen(!open)}>
          {open ? "–" : "+"}
        </button>
      </h3>
      {!open ? null : (
        <div className="audit">
          <div className="audit-filters">
            <select value={bot} onChange={(e) => setBot(e.target.value)} aria-label={p.t.auditBot}>
              <option value="all">{p.t.auditAllBots}</option>
              {(p.overview?.bots ?? []).map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label={p.t.auditKind}>
              <option value="all">{p.t.auditAllKinds}</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            <select value={since} onChange={(e) => setSince(e.target.value)} aria-label={p.t.auditSince}>
              <option value="all">{p.t.auditSinceAll}</option>
              <option value="1h">{p.t.auditSince1h}</option>
              <option value="24h">{p.t.auditSince24h}</option>
              <option value="7d">{p.t.auditSince7d}</option>
            </select>
          </div>
          {err !== null && <div className="form-error">{err}</div>}
          {entries.length === 0 && !loading ? (
            <div className="dim">{p.t.auditEmpty}</div>
          ) : (
            <div className="audit-list">
              {entries.map((e, i) => (
                <div key={`${e.ts}-${i}`} className="audit-row">
                  <span className="dim">{fmtTs(e.ts)}</span>
                  <span className="audit-kind">{e.kind}</span>
                  <span>{botName(e.botId)}</span>
                  <span className="dim audit-detail">{detailOf(e)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="audit-foot">
            {cursor != null && (
              <button className="mini" disabled={loading} onClick={() => void fetchPage("more", cursor)}>{p.t.auditMore}</button>
            )}
            {entries.length > 0 && (
              <button className="mini ghost" onClick={exportJsonl} title={p.t.auditExportHint}>{p.t.auditExport}</button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

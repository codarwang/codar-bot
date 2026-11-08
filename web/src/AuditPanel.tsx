/**
 * AuditPanel — M3.3 audit timeline (architecture m3 §4): merged host + gate
 * timeline with bot/kind/since filters, `before`-cursor paging, and JSONL
 * export of the loaded entries. Collapsed by default (the right column is
 * glance-first; audit is an on-demand drill-down).
 */
import { useEffect, useState } from "react";
import { jsonFetch } from "./api";

type T = ReturnType<typeof import("./i18n").makeT>;
type Overview = import("./api").Overview;
interface AuditResult {
  entries: Array<{ ts: string; kind: string; botId?: string; [k: string]: unknown }>;
  /** Oldest ts of the page, or null when exhausted (JSON null, not undefined). */
  cursor?: string | null;
}

/** Every kind either source writes (host bot-manager + gate audit.ts). */
const KINDS = ["approval", "tool_call", "usage", "rule_created", "lifecycle", "bot_failed", "start_failed", "session-auto-reset", "session_path_unmappable"] as const;
const SINCE_MS: Record<string, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 };
const PAGE = 50;

interface Props {
  t: T;
  overview: Overview | null;
}

export function AuditPanel(p: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [bot, setBot] = useState("all");
  const [kind, setKind] = useState("all");
  const [since, setSince] = useState("all");
  const [entries, setEntries] = useState<AuditResult["entries"]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function fetchPage(mode: "first" | "more", beforeTs?: string): Promise<void> {
    setLoading(true);
    setErr(null);
    try {
      const q = new URLSearchParams();
      if (bot !== "all") q.set("bot", bot);
      if (kind !== "all") q.set("kind", kind);
      if (since !== "all") q.set("since", new Date(Date.now() - SINCE_MS[since]!).toISOString());
      if (mode === "more" && beforeTs !== undefined) q.set("before", beforeTs);
      q.set("limit", String(PAGE));
      const r = await jsonFetch<AuditResult>(`/api/audit?${q.toString()}`);
      setEntries((prev) => (mode === "more" ? [...prev, ...r.entries] : r.entries));
      setCursor(r.cursor ?? undefined);
    } catch (e) {
      setErr(String(e).slice(0, 120));
    } finally {
      setLoading(false);
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
    URL.revokeObjectURL(a.href);
  };

  const botName = (id: string | undefined): string =>
    id === undefined ? "?" : p.overview?.bots.find((b) => b.id === id)?.name ?? id;
  const fmtTs = (ts: string): string => ts.replace("T", " ").replace(/(Z|\.\d{3}Z)$/, "");

  return (
    <section className="panel">
      <h3>
        {p.t.auditTitle}{" "}
        <button className="ghost mini" onClick={() => setOpen(!open)}>
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
                  <span className="dim audit-detail">
                    {/* First detail field each kind actually writes:
                      approval→resolvedAs(app)/approved(gate), tool_call→
                      toolName+inputSummary, *_failed→reason, lifecycle→detail. */}
                    {String(e.resolvedAs ?? e.approved ?? (e.toolName !== undefined ? `${String(e.toolName)} ${String(e.inputSummary ?? "")}` : undefined) ?? e.reason ?? e.detail ?? "")}
                  </span>
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

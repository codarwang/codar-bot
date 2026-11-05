/**
 * ContextPanel — the right column (ui-design §5): TURN / WORKS / BUDGET
 * panels, and BOT DETAIL as the second view (model, budget 4-dim, sandbox
 * honesty badge, session, memory management — PRD 2.3).
 */
import { useEffect, useState } from "react";
import { money, type Lang } from "./i18n";
import { jsonFetch, put, type BudgetRow, type Overview, type RoomRecord, type TurnEvent } from "./api";
import type { WorkView } from "./App";

type T = ReturnType<typeof import("./i18n").makeT>;

interface Props {
  t: T;
  lang: Lang;
  overview: Overview | null;
  room: RoomRecord | null;
  turn: TurnEvent | null;
  works: WorkView[];
  budgetRows: BudgetRow[];
  detailBotId: string | null;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onBudgetChanged: () => Promise<void>;
}

const SLOT_LABEL: Record<string, string> = {
  waiting: "○", speaking: "▶", posted: "✓", passed: "–", working: "⏱", failed: "✗", "timed-out": "⏱✗",
};

export function ContextPanel(p: Props): JSX.Element {
  if (p.detailBotId !== null) {
    const bot = p.overview?.bots.find((b) => b.id === p.detailBotId);
    if (bot !== undefined) {
      // key = remount per bot: budget/memory drafts can never leak across
      // bots (the M1 stale-closure class this rebuild must kill, §9).
      return <BotDetail key={bot.id} {...p} botId={bot.id} />;
    }
  }
  const { t, room } = p;
  const botName = (id: string): string => p.overview?.bots.find((b) => b.id === id)?.name ?? id;
  const rowFor = (scope: "bot" | "room", id: string): BudgetRow | undefined =>
    p.budgetRows.find((r) => r.scope === scope && r.id === id);

  return (
    <aside className="ctx">
      <section className="panel">
        <h3>{t.ctxTurn}</h3>
        {room === null ? (
          <div className="dim">{t.worksEmpty}</div>
        ) : (
          <div className="turn-list">
            {room.members.map((m) => {
              const slot = p.turn?.slots[m] ?? "waiting";
              return (
                <div key={m} className={`turn-row slot-${slot}`}>
                  <span className="slot-glyph">{SLOT_LABEL[slot] ?? "○"}</span> {botName(m)}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="panel">
        <h3>{t.ctxWorks}</h3>
        {p.works.length === 0 ? (
          <div className="dim">{t.worksEmpty}</div>
        ) : (
          <div className="works-list">
            {p.works.map((w) => (
              <div key={w.id} className={`work-row st-${w.status}`}>
                <span>{w.status === "done" ? "✓" : w.status === "failed" ? "✗" : w.status === "rejected" ? "⛔" : w.status === "pending" ? "⌛" : "▶"}</span>
                <span className="work-id">#{w.id.slice(5)}</span>
                <span className="dim">{botName(w.parent)}→{botName(w.child)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h3>{t.ctxBudget}</h3>
        {room !== null && (
          <BudgetMeter t={t} lang={p.lang} row={rowFor("room", room.id)} label={`◎ ${room.name}`} />
        )}
        {(room?.members ?? []).map((m) => (
          <BudgetMeter key={m} t={t} lang={p.lang} row={rowFor("bot", m)} label={botName(m)} />
        ))}
      </section>
    </aside>
  );
}

function BudgetMeter(props: { t: T; lang: Lang; row: BudgetRow | undefined; label: string }): JSX.Element {
  const { t, row } = props;
  if (row === undefined) return <div className="meter-row dim">{props.label} · …</div>;
  // Dimension preference: cost > tokens > turns — mirrors what can actually
  // stop the scope; a fully-unlimited scope shows no meter (R1 P2-9).
  const used = row.budget.maxCostMicros > 0
    ? { pct: Math.min(100, Math.round((row.costMicros / row.budget.maxCostMicros) * 100)), display: `${money(props.lang, row.costMicros)} ${t.budgetOf} ${money(props.lang, row.budget.maxCostMicros)}` }
    : row.budget.maxTokens > 0
      ? { pct: Math.min(100, Math.round((row.tokens / row.budget.maxTokens) * 100)), display: `${row.tokens.toLocaleString()} ${t.budgetOf} ${row.budget.maxTokens.toLocaleString()}${row.costMicros === 0 ? ` · ${t.tokenFallback}` : ""}` }
      : row.budget.maxTurns > 0 && row.turns !== undefined
        ? { pct: Math.min(100, Math.round((row.turns / row.budget.maxTurns) * 100)), display: t.budgetTurnsUsed(row.turns, row.budget.maxTurns) }
        : { pct: 0, display: t.budgetUnset };
  return (
    <div className="meter-row" title={`${row.month} · ${used.display}${row.budget.maxTurns > 0 && row.turns !== undefined && row.budget.maxCostMicros > 0 ? ` · ${t.budgetTurnsUsed(row.turns, row.budget.maxTurns)}` : ""}${row.budget.maxWallMs > 0 ? ` · ${t.budgetWall(row.budget.maxWallMs)}` : ""}`}>
      <span className="meter-label">{props.label}</span>
      <span className={`meter ${used.pct >= 100 ? "over" : used.pct >= 80 ? "warn" : ""}`}>
        <span className="meter-fill" style={{ width: `${used.pct}%` }} />
      </span>
      <span className="meter-pct dim">{used.pct}%</span>
      <span className="meter-val dim">{used.display}</span>
    </div>
  );
}

function BotDetail(props: Props & { botId: string }): JSX.Element {
  const { t, lang } = props;
  const bot = props.overview?.bots.find((b) => b.id === props.botId)!;
  const [budgetDraft, setBudgetDraft] = useState(bot.budget);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [memFiles, setMemFiles] = useState<Array<{ path: string; content: string }>>([]);
  const [memPending, setMemPending] = useState(0);
  const [memEdit, setMemEdit] = useState<{ path: string; content: string } | null>(null);

  useEffect(() => {
    void jsonFetch<{ files: Array<{ path: string; content: string }>; pending: number }>(`/api/memory/bots/${bot.id}`)
      .then((r) => {
        setMemFiles(r.files);
        setMemPending(r.pending);
      })
      .catch(() => setMemFiles([]));
  }, [bot.id]);

  const saveBudget = async (): Promise<void> => {
    setSaveMsg(null);
    try {
      await put(`/api/budget/${bot.id}`, budgetDraft);
      await props.onBudgetChanged();
      await props.onRefresh();
      setSaveMsg("✓");
    } catch (e) {
      setSaveMsg(String(e));
    }
  };

  const saveMemory = async (): Promise<void> => {
    if (memEdit === null) return;
    try {
      await put(`/api/memory/bots/${bot.id}`, memEdit);
      setMemFiles((fs) => fs.map((f) => (f.path === memEdit.path ? { path: f.path, content: memEdit.content } : f)));
      setMemEdit(null);
    } catch (e) {
      setSaveMsg(String(e));
    }
  };

  return (
    <aside className="ctx detail">
      <button className="ghost" onClick={props.onBack}>{t.backToRoom}</button>
      <section className="panel">
        <h3>{t.ctxDetail}</h3>
        <div className="kv"><span>{t.nameLabel}</span><b>{bot.name}{bot.chief ? " ★" : ""}</b></div>
        {bot.role !== "" && <div className="kv"><span>{t.roleLabel}</span><b>{bot.role}</b></div>}
        <div className="kv"><span>{t.modelLabel}</span><b>{bot.model.provider}/{bot.model.modelId}</b></div>
        <div className="kv"><span>{t.effortLabel}</span><b>{bot.model.thinkingLevel}</b></div>
        <div className="kv">
          <span>{t.sandboxLabel}</span>
          <b className={`badge-sandbox ${bot.sandbox.mode === "docker" ? "" : "warn"}`}>
            {bot.sandbox.mode === "docker" ? t.sandboxDocker : t.sandboxHost}
          </b>
        </div>
        {bot.sessionPath !== null && <div className="kv path"><span>{t.sessionPath}</span><b>{bot.sessionPath}</b></div>}
      </section>

      <section className="panel">
        <h3>{t.budgetLabel} <span className="dim">{t.monthLabel}</span></h3>
        {(["maxTokens", "maxCostMicros", "maxTurns", "maxWallMs"] as const).map((k) => (
          <div className="kv" key={k}>
            <span>{k}</span>
            <input
              type="number"
              min={0}
              value={budgetDraft[k]}
              onChange={(e) => setBudgetDraft({ ...budgetDraft, [k]: Number(e.target.value) })}
            />
          </div>
        ))}
        <div className="form-row">
          <button onClick={() => void saveBudget()}>{t.save}</button>
          {saveMsg !== null && <span className="dim">{saveMsg}</span>}
        </div>
        <div className="dim">costMicros · {money(lang, bot.budget.maxCostMicros)}</div>
      </section>

      <section className="panel">
        <h3>{t.memoryTitle}</h3>
        {memPending > 0 && <div className="dim">{t.memoryPending(memPending)}</div>}
        {memFiles.length === 0 && <div className="dim">—</div>}
        {memFiles.map((f) => (
          <div className="kv" key={f.path}>
            <span className="mem-path">{f.path}</span>
            {memEdit?.path === f.path ? (
              <button className="mini" onClick={() => void saveMemory()}>{t.memorySave}</button>
            ) : (
              <button className="mini" onClick={() => setMemEdit({ path: f.path, content: f.content })}>✎</button>
            )}
          </div>
        ))}
        {memEdit !== null && (
          <textarea
            className="mem-edit"
            value={memEdit.content}
            onChange={(e) => setMemEdit({ ...memEdit, content: e.target.value })}
            rows={10}
          />
        )}
      </section>
    </aside>
  );
}

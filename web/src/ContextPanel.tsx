/**
 * ContextPanel — the right column (ui-design §5): TURN / WORKS / BUDGET
 * panels, and BOT DETAIL as the second view (model, budget 4-dim, sandbox
 * honesty badge, session, memory management — PRD 2.3).
 */
import { useEffect, useRef, useState } from "react";
import { money, type Lang } from "./i18n";
import { jsonFetch, post, put, type BudgetRow, type Overview, type RoomRecord, type TurnEvent } from "./api";
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
  streaming: Record<string, string>;
  toolAt: Record<string, { name: string; args: string; ts: number; step: number }>;
  statuses: Record<string, string>;
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
  // costLive: unpriced providers report cost 0 forever while a cost limit
  // exists — fall through to tokens so the meter agrees with the warn bar
  // (D2 R2 P3).
  const costLive = row.costMicros > 0;
  const used = row.budget.maxCostMicros > 0 && costLive
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
      <WorkLog
        t={t}
        botId={bot.id}
        botName={bot.name}
        status={props.statuses[bot.id] ?? "stopped"}
        streaming={props.streaming[bot.id] ?? ""}
        tool={props.toolAt[bot.id]}
        onResetSession={async () => {
          await post(`/api/bots/${bot.id}/reset-session`);
          await props.onRefresh();
        }}
      />
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

/** Live work log (dogfood D3): what the bot is doing RIGHT NOW — current
 *  tool with args + step, live streaming output, and the session tail
 *  (its own recent turns/tool results). The static config below answers
 *  "what is this bot"; this answers "what is it doing". */
function WorkLog(props: {
  t: T;
  botId: string;
  botName: string;
  status: string;
  streaming: string;
  tool?: { name: string; args: string; ts: number; step: number };
  onResetSession: () => Promise<void>;
}): JSX.Element {
  const { t } = props;
  const [now, setNow] = useState(Date.now());
  const [tail, setTail] = useState<Array<{ role: string; text: string }>>([]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // Session tail: fetch while the bot runs (poll 2s), once when idle.
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void jsonFetch<{ messages: Array<{ role: string; text: string }> }>(`/api/bots/${props.botId}/messages`)
        .then((r) => { if (!cancelled) setTail(r.messages.slice(-8)); })
        .catch(() => undefined);
    };
    load();
    if (props.status === "working") {
      const timer = setInterval(load, 2000);
      return () => { cancelled = true; clearInterval(timer); };
    }
    return () => { cancelled = true; };
  }, [props.botId, props.status]);
  const toolSecs = props.tool !== undefined ? Math.max(0, Math.round((now - props.tool.ts) / 1000)) : 0;
  // Turn age: since the bot went working (status prop flips) — we do not
  // have turn slots here, so track the working-since moment locally.
  const workingSince = useRef<number | null>(null);
  if (props.status === "working" && workingSince.current === null) workingSince.current = Date.now();
  if (props.status !== "working") workingSince.current = null;
  const noTokenSecs =
    props.status === "working" && props.tool === undefined && props.streaming === "" && workingSince.current !== null
      ? Math.max(0, Math.round((now - workingSince.current) / 1000))
      : 0;
  const live =
    props.tool !== undefined
      ? `#${props.tool.step} ⚙ ${props.tool.name} … ${toolSecs}s${props.tool.args !== "" ? ` · ${props.tool.args}` : ""}`
      : props.streaming !== ""
        ? t.liveOutput
        : noTokenSecs > 0
          ? `${t.noFirstToken(noTokenSecs)}${noTokenSecs >= 30 ? ` · ${t.possiblyStuck}` : ""}`
          : null;
  return (
    <section className="panel">
      <h3>{t.workLog} · {props.botName}</h3>
      <div className="worklog-actions">
        <button
          className="mini"
          title={t.resetSessionHint}
          disabled={props.status === "working"}
          onClick={() => void props.onResetSession()}
        >↻ {t.resetSession}</button>
        <span className="dim">{t.resetSessionHint}</span>
      </div>
      {live !== null ? (
        <div className={`worklog-live ${noTokenSecs >= 30 ? "stuck" : ""}`}>
          {live}
          {props.streaming !== "" && (
            <div className="worklog-stream">{props.streaming.slice(-240)}▍</div>
          )}
        </div>
      ) : (
        <div className="dim">{t.workLogIdle}</div>
      )}
      {tail.length > 0 && (
        <div className="worklog-tail">
          {tail.map((m, i) => (
            <div key={i} className="worklog-row">
              <span className="worklog-role dim">{m.role}</span>
              <span className="worklog-text">{m.text.slice(0, 90).replace(/\n/g, " ")}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

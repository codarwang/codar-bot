/**
 * Chat — the timeline (ui-design §3): message bubbles, system lines, inline
 * cards (handoff lifecycle / budget stops / approvals), the TURN strip above
 * the composer, and the composer itself. CSS red lines (§10a): stream
 * children never shrink; strips and card headers stay single-line.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { elapsed, money, timeStr, type Lang } from "./i18n";
import { post, type ApprovalEvent, type Overview, type RoomMessage, type RoomRecord, type TurnEvent } from "./api";
import type { WorkView } from "./App";

type T = ReturnType<typeof import("./i18n").makeT>;

interface Props {
  t: T;
  lang: Lang;
  overview: Overview | null;
  room: RoomRecord | null;
  turn: TurnEvent | null;
  messages: RoomMessage[];
  works: WorkView[];
  streaming: Record<string, string>;
  approvals: Array<ApprovalEvent & { resolved?: boolean; outcome?: boolean }>;
  onResolveApproval: (id: string, confirmed: boolean) => Promise<void>;
  onRefresh: () => Promise<void>;
}

const SLOT_LABEL: Record<string, string> = {
  waiting: "○", speaking: "▶", posted: "✓", passed: "–", working: "⏱", failed: "✗", "timed-out": "⏱✗",
};

export function Chat(p: Props): JSX.Element {
  const { t, lang, room } = p;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);
  const bots = useMemo(() => p.overview?.bots ?? [], [p.overview]);
  const botName = (id?: string): string => bots.find((b) => b.id === id)?.name ?? (id ?? "?");
  const modelOf = (id?: string): string => {
    const b = bots.find((x) => x.id === id);
    return b !== undefined ? `${b.model.provider}/${b.model.modelId}` : "";
  };

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [p.messages.length, p.works.length, p.approvals.length]);

  const paused = room?.status === "paused";
  const send = async (): Promise<void> => {
    if (draft.trim() === "" || room === null || paused) return;
    const text = draft;
    setDraft("");
    setError(null);
    try {
      await post(`/api/rooms/${room.id}/messages`, { text });
      // 202 async: the turn engine appends the user line via SSE.
    } catch (e) {
      setError(String(e));
      setDraft(text);
    }
  };

  const roomMembers = room?.members ?? [];
  const openApprovals = p.approvals.filter(
    (a) => a.botId !== null && roomMembers.includes(a.botId)
  );

  return (
    <section className="chat">
      {room === null ? (
        <div className="empty">{t.emptyRoom}</div>
      ) : (
        <>
          <header className="chat-head">
            <span className="chat-title">◎ {room.name}</span>
            <span className="dim">{room.members.map((m) => botName(m)).join(", ")}</span>
            <span className="dim">· {t.turnMode}: {room.mode}</span>
          </header>

          <div className="stream" ref={scrollRef}>
            {p.messages.map((m) => (
              <MessageBubble key={m.seq} t={t} lang={lang} m={m} botName={botName} modelOf={modelOf} />
            ))}
            {p.works
              .filter((w) => w.status !== "done" || w.endedAt === undefined || now - w.endedAt < 60_000)
              .map((w) => (
                <WorkCard key={w.id} t={t} w={w} botName={botName} now={now} />
              ))}
            {openApprovals.map((a) => (
              <ApprovalCard key={a.id} t={t} a={a} botName={botName} onResolve={p.onResolveApproval} />
            ))}
            {roomMembers
              .filter((m) => p.streaming[m] !== undefined && p.streaming[m] !== "")
              .map((m) => (
                <div key={`s-${m}`} className="msg msg-bot streaming">
                  <Avatar name={botName(m)} id={m} />
                  <div className="bubble">
                    <div className="meta">{botName(m)} <span className="dim">{modelOf(m)}</span></div>
                    {p.streaming[m]}▍
                  </div>
                </div>
              ))}
            {p.messages.length === 0 && <div className="empty">{t.emptyRoom}</div>}
          </div>

          <TurnStrip t={t} turn={p.turn} room={room} botName={botName} now={now} />

          {paused && (
            <div className={`pause-card ${room.pauseReason === "budget" ? "stop" : "warn"}`}>
              {room.pauseReason === "budget" ? t.budgetStoppedRoom : room.pauseReason === "ping-pong" ? t.pausedPingPong : t.pausedManual}
            </div>
          )}
          {error !== null && <div className="error">{error}</div>}
          <div className="composer">
            <input
              placeholder={paused ? t.roomPausedComposer : t.saySomething}
              disabled={paused}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button className="primary" disabled={paused || draft.trim() === ""} onClick={() => void send()}>➤ {t.send}</button>
          </div>
        </>
      )}
    </section>
  );
}

function Avatar({ name, id }: { name: string; id: string }): JSX.Element {
  const colors = ["#6c8cff", "#41b883", "#e29a3a", "#c65cc4", "#3ab0c9", "#d4615f"];
  const c = colors[[...id].reduce((a, ch) => a + ch.charCodeAt(0), 0) % colors.length]!;
  return <span className="avatar" style={{ background: c }}>{name.slice(0, 1)}</span>;
}

function MessageBubble(props: {
  t: T;
  lang: Lang;
  m: RoomMessage;
  botName: (id?: string) => string;
  modelOf: (id?: string) => string;
}): JSX.Element {
  const { t, lang, m } = props;
  if (m.from.kind === "user") {
    return <div className="msg msg-user"><div className="bubble">{m.text}</div></div>;
  }
  if (m.from.kind === "system") {
    // Budget stop/pause broadcasts get card weight; everything else is a
    // quiet centered line (§3.1 + §3.4 shapes).
    const isStop = m.text.includes("BUDGET STOPPED");
    const isPause = m.text.includes("ROOM PAUSED");
    if (isStop || isPause) {
      return (
        <div className={`card card-budget ${isPause ? "room" : ""}`}>
          <div className="card-head">⛔ {isPause ? t.budgetStoppedRoom : m.text.split("—")[0]!.trim()}</div>
          <div className="card-body">{m.text}</div>
        </div>
      );
    }
    return <div className="sysline"><span>{m.text}</span></div>;
  }
  return (
    <div className="msg msg-bot">
      <Avatar name={props.botName(m.from.id)} id={m.from.id ?? "?"} />
      <div className="bubble">
        <div className="meta">{props.botName(m.from.id)} <span className="dim">{props.modelOf(m.from.id)}</span> <span className="dim">{timeStr(lang, m.ts)}</span></div>
        {m.text}
      </div>
    </div>
  );
}

function WorkCard(props: { t: T; w: WorkView; botName: (id?: string) => string; now: number }): JSX.Element {
  const { t, w } = props;
  const ms = (w.endedAt ?? props.now) - w.firstSeen;
  const oneLiner =
    w.oneLiner ??
    (w.status === "pending" ? t.taskQueued(props.botName(w.child)) : w.status === "working" ? t.taskStarting : "");
  const statusGlyph = w.status === "done" ? "✓" : w.status === "failed" ? "✗" : w.status === "rejected" ? "⛔" : w.status === "pending" ? "⌛" : "▶";
  return (
    <div className={`card card-work st-${w.status}`}>
      <div className="card-head">
        {statusGlyph} {t.taskLabel} #{w.id.slice(5)} {w.status === "done" ? t.taskDone : w.status === "failed" ? t.taskFailed : w.status === "rejected" ? t.taskRejected : ""} → {props.botName(w.child)}
        {w.status !== "pending" && <span className="dim"> · {elapsed(ms)}</span>}
      </div>
      {(oneLiner !== "" || w.task !== "") && (
        <div className="card-body">
          {w.task !== "" && <div className="task-text">{w.task.slice(0, 140)}</div>}
          {oneLiner !== "" && <div>{oneLiner}</div>}
          {w.status === "failed" && w.oneLiner?.includes("interrupted") === true && <div>{t.taskInterrupted}</div>}
          {w.status === "rejected" && <div>{t.taskCycle}</div>}
        </div>
      )}
    </div>
  );
}

function ApprovalCard(props: {
  t: T;
  a: ApprovalEvent & { resolved?: boolean; outcome?: boolean };
  botName: (id?: string) => string;
  onResolve: (id: string, confirmed: boolean) => Promise<void>;
}): JSX.Element {
  const { t, a } = props;
  return (
    <div className={`card card-approval ${a.resolved === true ? "resolved" : ""}`}>
      <div className="card-head">🔐 {t.approvalTitle(props.botName(a.botId ?? undefined))}</div>
      <div className="card-body">
        <div>{a.title} {a.message !== "" ? `· ${String(a.message).slice(0, 80)}` : ""}</div>
        {a.resolved !== true ? (
          <div className="card-actions">
            <button className="primary" onClick={() => void props.onResolve(a.id, true)}>{t.allowOnce}</button>
            <button disabled title="M3">{t.alwaysAllow} <span className="dim">{t.alwaysAllowM3}</span></button>
            <button className="danger" onClick={() => void props.onResolve(a.id, false)}>{t.deny}</button>
          </div>
        ) : (
          <div>{a.outcome === true ? t.approvalResolvedAllow : t.approvalResolvedDeny}</div>
        )}
      </div>
    </div>
  );
}

function TurnStrip(props: {
  t: T;
  turn: TurnEvent | null;
  room: RoomRecord;
  botName: (id?: string) => string;
  now: number;
}): JSX.Element {
  const { t, turn, room } = props;
  // §3.2: single-member rooms hide the strip.
  if (room.members.length < 2) return <div className="turnstrip placeholder" />;
  const paused = turn?.pausedReason ?? (room.status === "paused" ? room.pauseReason : null);
  return (
    <div className={`turnstrip ${paused !== null ? "paused" : ""}`}>
      <span className="turn-label">{t.turnTitle}</span>
      <div className="turn-slots">
        {room.members.map((m) => {
          const slot = turn?.slots[m] ?? "waiting";
          return (
            <span key={m} className={`slot slot-${slot}`}>
              {SLOT_LABEL[slot] ?? "○"} {props.botName(m)}
            </span>
          );
        })}
      </div>
      {paused !== null && <span className="pause-note">{paused === "budget" ? t.pausedBudget : t.pausedPingPong}</span>}
    </div>
  );
}

export function moneyLabel(t: T, lang: Lang, micros: number): string {
  void t;
  return money(lang, micros);
}

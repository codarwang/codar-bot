/**
 * Chat — the timeline (ui-design §3): message bubbles, system lines, inline
 * cards (handoff lifecycle / budget stops with RESUME actions / approvals),
 * the TURN strip above the composer, and the composer itself (textarea:
 * Enter send / Shift+Enter newline / IME-composition guard / @-mention
 * popup / streaming stop). CSS red lines (§10a): stream children never
 * shrink; strips and card headers stay single-line.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { elapsed, money, timeStr, type Lang } from "./i18n";
import { jsonFetch, post, put, type ApprovalEvent, type Budget4, type Overview, type RoomMessage, type RoomRecord, type TurnEvent } from "./api";
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
  statuses: Record<string, string>;
  failures: Record<string, string>;
  approvals: Array<ApprovalEvent & { resolved?: boolean; outcome?: boolean; stale?: boolean }>;
  draft: string;
  onDraft: (text: string) => void;
  onResolveApproval: (id: string, confirmed: boolean) => Promise<void>;
  onOpenDetail: (botId: string) => void;
  onRefresh: () => Promise<void>;
  onBudgetChanged: () => Promise<void>;
}

const SLOT_LABEL: Record<string, string> = {
  waiting: "○", speaking: "▶", posted: "✓", passed: "–", working: "⏱", failed: "✗", "timed-out": "⏱✗",
};

export function Chat(p: Props): JSX.Element {
  const { t, lang, room } = p;
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [mentionOpen, setMentionOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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
  const streamCount = Object.keys(p.streaming).length;
  const streamLen = useMemo(() => Object.values(p.streaming).join("").length, [p.streaming]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [p.messages.length, p.works.length, p.approvals.length, streamCount, streamLen]);

  // Budget pauses block sending; ping-pong/manual pauses are LIFTED by a
  // user message (§5.3) — the composer stays open there (R1 P1-2).
  const budgetPaused = room?.status === "paused" && room.pauseReason === "budget";
  const liftablePause = room?.status === "paused" && room.pauseReason !== "budget";
  const roomMembers = room?.members ?? [];
  const roomStreamingBot = roomMembers.find((m) => p.streaming[m] !== undefined && p.streaming[m] !== "");
  // §7: a room whose EVERY member is stopped cannot take turns — the
  // stopped banners above already explain and offer Start.
  const allStopped = roomMembers.length > 0 && roomMembers.every((m) => p.statuses[m] === "stopped" || p.statuses[m] === "crashed");

  const send = async (): Promise<void> => {
    if (p.draft.trim() === "" || room === null || budgetPaused) return;
    const text = p.draft;
    p.onDraft("");
    setError(null);
    setMentionOpen(false);
    try {
      await post(`/api/rooms/${room.id}/messages`, { text });
      // 202 async: the turn engine appends the user line via SSE.
    } catch (e) {
      setError(String(e));
      p.onDraft(text);
    }
  };

  const abortStreaming = async (): Promise<void> => {
    // THE ROOM member — insertion order could pick a bot streaming in
    // ANOTHER room and abort it (R3 P2-1).
    if (roomStreamingBot === undefined) return;
    try {
      await post(`/api/bots/${roomStreamingBot}/abort`);
    } catch (e) {
      setError(String(e));
    }
  };

  // @-mention popup: matches the fragment after the last "@".
  const mentionMatches = useMemo(() => {
    const at = p.draft.lastIndexOf("@");
    if (at < 0) return [];
    const frag = p.draft.slice(at + 1);
    if (frag.includes(" ")) return [];
    return bots.filter((b) => b.name.toLowerCase().includes(frag.toLowerCase())).slice(0, 9);
  }, [p.draft, bots]);
  useEffect(() => {
    setMentionOpen(mentionMatches.length > 0);
  }, [mentionMatches.length]);
  const pickMention = (name: string): void => {
    const at = p.draft.lastIndexOf("@");
    p.onDraft(`${p.draft.slice(0, at)}@${name} `);
    inputRef.current?.focus();
  };

  const openApprovals = p.approvals.filter(
    (a) => a.botId !== null && roomMembers.includes(a.botId)
  );
  // The composer error strip carries the latest failure among room members
  // (§6: failure → composer error bar + roster 🔴), auto-dismissing.
  const [failureFlash, setFailureFlash] = useState<{ botId: string; reason: string } | null>(null);
  useEffect(() => {
    // Keyed per room: switching rooms drops a stale flash immediately
    // instead of letting it ride out its 8s (R2 P3).
    setFailureFlash(null);
    const inRoom = Object.entries(p.failures).filter(([id]) => roomMembers.includes(id));
    if (inRoom.length > 0) {
      setFailureFlash({ botId: inRoom[inRoom.length - 1]![0], reason: inRoom[inRoom.length - 1]![1] });
      const timer = setTimeout(() => setFailureFlash(null), 8000);
      return () => clearTimeout(timer);
    }
  }, [p.failures, room?.id, roomMembers.length]);

  return (
    <section className="chat">
      {room === null ? (
        <div className="empty">{t.emptyRoom}</div>
      ) : (
        <>
          {room.members
            .filter((m) => p.statuses[m] === "stopped" || p.statuses[m] === "crashed")
            .map((m) => (
              <div key={m} className="stoppedBanner">
                {t.botStoppedBanner(botName(m))}
                <button className="mini" onClick={() => { void post(`/api/bots/${m}/start`).then(() => p.onRefresh()).catch((e: unknown) => setError(String(e))); }}>
                  {t.start}
                </button>
              </div>
            ))}
          <header className="chat-head">
            <span className="chat-title">◎ {room.name}</span>
            <span className="dim">{room.members.map((m) => botName(m)).join(", ")}</span>
            <span className="dim">· {t.turnMode}: {room.mode}</span>
          </header>

          <div className="stream" ref={scrollRef}>
            {p.messages.map((m) => (
              <MessageBubble key={m.seq} t={t} lang={lang} m={m} botName={botName} modelOf={modelOf} onOpenDetail={p.onOpenDetail} />
            ))}
            {p.works.map((w) => (
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
            {p.messages.length === 0 && p.works.length === 0 && streamCount === 0 && <div className="empty">{t.emptyRoom}</div>}
          </div>

          <TurnStrip t={t} turn={p.turn} room={room} botName={botName} />

          {room.status === "paused" && (
            <PauseCard
              key={room.id}
              t={t}
              lang={lang}
              room={room}
              onRefresh={p.onRefresh}
              onBudgetChanged={p.onBudgetChanged}
              onBudgetSaved={() => void p.onRefresh()}
            />
          )}
          {failureFlash !== null && (
            <div className="errorStrip">
              {t.turnFailed(botName(failureFlash.botId))}: {failureFlash.reason.slice(0, 120)}
            </div>
          )}
          {error !== null && <div className="error">{error}</div>}
          <div className="composer">
            {mentionOpen && mentionMatches.length > 0 && (
              <div className="mention-pop">
                {mentionMatches.map((b, i) => (
                  <div key={b.id} className="mention-item" onClick={() => pickMention(b.name)}>
                    <span className="dim">{i + 1}</span> @{b.name}
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              rows={1}
              placeholder={budgetPaused ? t.roomPausedComposer : t.saySomething}
              disabled={budgetPaused || allStopped}
              value={p.draft}
              onChange={(e) => p.onDraft(e.target.value)}
              onKeyDown={(e) => {
                if (mentionOpen && /^[1-9]$/.test(e.key)) {
                  const idx = Number(e.key) - 1;
                  if (mentionMatches[idx] !== undefined) {
                    e.preventDefault();
                    pickMention(mentionMatches[idx]!.name);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {roomStreamingBot !== undefined ? (
              <button className="danger" onClick={() => void abortStreaming()}>■ {t.stopStreaming}</button>
            ) : (
              <button className="primary" disabled={budgetPaused || allStopped || p.draft.trim() === ""} onClick={() => void send()}>➤ {t.send}</button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function Avatar({ name, id }: { name: string; id: string }): JSX.Element {
  const colors = ["#6c8eff", "#41b883", "#e29a3a", "#c65cc4", "#3ab0c9", "#d4615f"];
  const c = colors[[...id].reduce((a, ch) => a + ch.charCodeAt(0), 0) % colors.length]!;
  return <span className="avatar" style={{ background: c }}>{name.slice(0, 1)}</span>;
}

function MessageBubble(props: {
  t: T;
  lang: Lang;
  m: RoomMessage;
  botName: (id?: string) => string;
  modelOf: (id?: string) => string;
  onOpenDetail: (botId: string) => void;
}): JSX.Element {
  const { t, lang, m } = props;
  if (m.from.kind === "user") {
    return <div className="msg msg-user"><div className="bubble">{m.text}</div></div>;
  }
  if (m.from.kind === "system") {
    // Budget stop/pause broadcasts get card weight with RESUME actions;
    // everything else is a quiet centered line (§3.1 + §3.4).
    const isStop = m.text.includes("BUDGET STOPPED");
    const isPause = m.text.includes("ROOM PAUSED");
    if (isStop || isPause) {
      const stoppedBotName = m.text.split("—")[1]?.trim().split(":")[0]?.trim() ?? "";
      return (
        <div className={`card card-budget ${isPause ? "room" : ""}`}>
          <div className="card-head">⛔ {isPause ? t.budgetStoppedRoom : `${t.budgetStoppedBot(stoppedBotName)}`}</div>
          <div className="card-body">
            {m.text}
            {!isPause && stoppedBotName.length > 0 && (
              <div className="card-actions">
                <button onClick={() => {
                  // §3.4 bot-level card: jump to that bot's budget editor.
                  void jsonFetch<Overview>("/api/overview").then((o) => {
                    const b = o.bots.find((x) => x.name === stoppedBotName);
                    if (b !== undefined) props.onOpenDetail(b.id);
                  }).catch(() => undefined);
                }}>{t.adjustBudget}</button>
                <button className="ghost" disabled>{t.keepStopped}</button>
              </div>
            )}
          </div>
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
  const statusLabel = w.status === "done" ? t.taskDone : w.status === "failed" ? t.taskFailed : w.status === "rejected" ? t.taskRejected : "";
  return (
    <div className={`card card-work st-${w.status}`}>
      <div className="card-head">
        {statusGlyph} {t.taskLabel} #{w.id.slice(5)} {statusLabel} → {props.botName(w.child)}
        {w.status !== "pending" && <span className="dim"> · {elapsed(ms)}</span>}
      </div>
      {(oneLiner !== "" || w.task !== "") && (
        <div className="card-body">
          {w.task !== "" && <div className="task-text">{w.task.slice(0, 140)}</div>}
          {oneLiner !== "" && <div>{oneLiner}</div>}
          {w.status === "rejected" && <div>{t.taskCycle}</div>}
        </div>
      )}
    </div>
  );
}

function ApprovalCard(props: {
  t: T;
  a: ApprovalEvent & { resolved?: boolean; outcome?: boolean; stale?: boolean };
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
          <div>{a.stale === true ? t.approvalStale : a.outcome === true ? t.approvalResolvedAllow : t.approvalResolvedDeny}</div>
        )}
      </div>
    </div>
  );
}

/** Room pause with the §3.4 exits: budget pauses get an inline room-budget
 *  editor (PUT /api/budget/room_xxx); liftable pauses say so honestly. */
function PauseCard(props: {
  t: T;
  lang: Lang;
  room: RoomRecord;
  onRefresh: () => Promise<void>;
  onBudgetChanged: () => Promise<void>;
  onBudgetSaved: () => void;
}): JSX.Element {
  const { t, room } = props;
  const budget = room.pauseReason === "budget";
  const [editing, setEditing] = useState(false);
  const [draftB, setDraftB] = useState<Budget4>(room.budget);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    setMsg(null);
    try {
      await put(`/api/budget/${room.id}`, draftB);
      await props.onBudgetChanged();
      await props.onRefresh();
      setMsg("✓");
      setEditing(false);
    } catch (e) {
      setMsg(String(e));
    }
  };
  return (
    <div className={`pause-card ${budget ? "stop" : "warn"}`}>
      <div>
        {budget ? t.budgetStoppedRoom : room.pauseReason === "ping-pong" ? t.pausedPingPong : t.pausedManual}
        {!budget && <span className="dim"> · {t.liftableHint}</span>}
      </div>
      {budget && !editing && (
        <div className="card-actions">
          <button onClick={() => setEditing(true)}>{t.adjustBudget}</button>
          <button className="ghost" disabled>{t.keepPaused}</button>
        </div>
      )}
      {budget && editing && (
        <div className="pause-edit">
          {(["maxTokens", "maxCostMicros", "maxTurns", "maxWallMs"] as const).map((k) => (
            <label key={k}>
              <span className="dim">{k}</span>
              <input type="number" min={0} value={draftB[k]} onChange={(e) => setDraftB({ ...draftB, [k]: Number(e.target.value) })} />
            </label>
          ))}
          <button className="primary" onClick={() => void save()}>{t.save}</button>
          <button className="ghost" onClick={() => setEditing(false)}>{t.cancel}</button>
          {msg !== null && <span className="dim">{msg}</span>}
        </div>
      )}
    </div>
  );
}

function TurnStrip(props: {
  t: T;
  turn: TurnEvent | null;
  room: RoomRecord;
  botName: (id?: string) => string;
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
      {paused !== null && (
        <span className="pause-note">
          {paused === "budget" ? t.pausedBudget : paused === "manual" ? t.pausedManual : t.pausedPingPong}
        </span>
      )}
    </div>
  );
}

export function moneyLabel(lang: Lang, micros: number): string {
  return money(lang, micros);
}

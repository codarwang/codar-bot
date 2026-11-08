/**
 * codar web — M2-E three-zone workstation (ui-design v1.3 contract):
 * ROSTER inbox | CHAT timeline with inline cards | CONTEXT panel.
 * The SSE hub lives here (§6 mapping); children are pure-ish views.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { makeT, type Lang } from "./i18n";
import { initToken, withToken } from "./api";
import {
  jsonFetch,
  post,
  type ApprovalEvent,
  type BudgetRow,
  type Overview,
  type RoomMessage,
  type TurnEvent,
  type WorkRecord,
} from "./api";
import { Roster } from "./Roster";
import { Chat } from "./Chat";
import { ContextPanel } from "./ContextPanel";

export interface WorkView extends WorkRecord {
  oneLiner?: string;
  firstSeen: number;
  endedAt?: number;
}

export function App(): JSX.Element {
  initToken(); // M3.4b: ?token=<key> → sessionStorage on first load
  const [lang, setLang] = useState<Lang>(() =>
    (localStorage.getItem("codar.lang") as Lang | null) ?? "zh"
  );
  const t = useMemo(() => makeT(lang), [lang]);
  const toggleLang = (): void => {
    setLang((l) => {
      const next = l === "zh" ? "en" : "zh";
      localStorage.setItem("codar.lang", next);
      return next;
    });
  };

  const [overview, setOverview] = useState<Overview | null>(null);
  const [roomId, setRoomId] = useState<string>("");
  const [detailBotId, setDetailBotId] = useState<string | null>(null);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [lastByRoom, setLastByRoom] = useState<Record<string, RoomMessage>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [works, setWorks] = useState<Record<string, WorkView>>({});
  const [turn, setTurn] = useState<TurnEvent | null>(null);
  const [budgetRows, setBudgetRows] = useState<BudgetRow[]>([]);
  const [approvals, setApprovals] = useState<Array<ApprovalEvent & { resolved?: boolean; outcome?: boolean; stale?: boolean }>>([]);
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [toolAt, setToolAt] = useState<Record<string, { name: string; args: string; ts: number; step: number }>>({});
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [sse, setSse] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [approvalErrors, setApprovalErrors] = useState<Record<string, string>>({});
  const [ctxOpen, setCtxOpen] = useState(true);
  const [rosterOpen, setRosterOpen] = useState(true);

  const lastSeqRef = useRef(0);

  const refreshOverview = useCallback(async () => {
    try {
      const o = await jsonFetch<Overview>("/api/overview");
      setOverview(o);
      setRoomId((cur) => (cur === "" && o.rooms.length > 0 ? o.rooms[0]!.id : cur));
      setStatuses(Object.fromEntries(o.bots.map((b) => [b.id, b.runtime?.status ?? "stopped"])));
    } catch {
      /* surfaced via sse state + error surfaces */
    }
  }, []);
  const refreshBudget = useCallback(async () => {
    try {
      setBudgetRows(await jsonFetch<BudgetRow[]>("/api/budget"));
    } catch {
      /* meter shows stale — honest */
    }
  }, []);

  const refreshWorks = useCallback(async () => {
    // UNFILTERED: the queued badge must see works in never-visited rooms
    // (the per-room hydrate only covers the selected room — D1 review P3).
    try {
      const ws = await jsonFetch<WorkRecord[]>("/api/works");
      const now = Date.now();
      setWorks((prev) => {
        const next = { ...prev };
        for (const w of ws) {
          next[w.id] = {
            ...w,
            oneLiner: next[w.id]?.oneLiner,
            firstSeen: next[w.id]?.firstSeen ?? now,
            endedAt: w.status === "done" || w.status === "failed" || w.status === "rejected"
              ? next[w.id]?.endedAt ?? now
              : undefined,
          };
        }
        return next;
      });
    } catch {
      /* works are supplementary */
    }
  }, []);
  useEffect(() => {
    void refreshOverview();
    void refreshBudget();
    void refreshWorks();
  }, [refreshOverview, refreshBudget, refreshWorks]);

  // Hydrate every room's preview tail once the overview lands (the inbox
  // metaphor needs per-room last lines, not just the selected room's).
  useEffect(() => {
    for (const r of overview?.rooms ?? []) {
      if (lastByRoom[r.id] !== undefined) continue;
      void jsonFetch<{ messages: RoomMessage[] }>(`/api/rooms/${r.id}/messages`)
        .then((res) => {
          const last = res.messages[res.messages.length - 1];
          if (last !== undefined) setLastByRoom((prev) => ({ ...prev, [r.id]: last }));
        })
        .catch(() => undefined);
    }
  }, [overview, lastByRoom]);

  // Room switch: hydrate history + works, reset the turn strip (no stale
  // cross-room slots), clear unread, park the draft per room.
  useEffect(() => {
    if (roomId === "") return;
    setTurn(null);
    setUnread((prev) => ({ ...prev, [roomId]: 0 }));
    // seq is PER-ROOM (each room counts from 1): the previous room's list
    // and watermark must not survive the switch — the R3 merge used to keep
    // them and leak old-room messages into the new timeline while the seq
    // collisions swallowed the new room's real messages (R4 P1). Clearing
    // here makes the merge's `prev` contain ONLY current-room SSE arrivals.
    setMessages([]);
    lastSeqRef.current = 0;
    const cur = roomId;
    void jsonFetch<{ messages: RoomMessage[] }>(`/api/rooms/${cur}/messages`)
      .then((r) => {
        // Race guard: a slow response for room A must not paint over room B
        // after a quick switch (R2 F4 — the M1 stale-closure class).
        if (roomRef.current !== cur) return;
        // MERGE, not clobber: messages that arrived via SSE between the
        // switch and this response would vanish under a flat overwrite and
        // stay gone until the next reconnect resync (R3 P3-2).
        const tail = r.messages.length > 0 ? r.messages[r.messages.length - 1]!.seq : 0;
        setMessages((prev) => {
          const fetched = new Set(r.messages.map((m) => m.seq));
          const liveOnly = prev.filter((m) => !fetched.has(m.seq) && m.seq > tail);
          return [...r.messages, ...liveOnly];
        });
        // Plain assign: per-room seq space — Math.max would carry the old
        // room's watermark and permanently skip early-seq messages after a
        // reconnect diff-fetch (R4 P1 secondary).
        lastSeqRef.current = tail;
      })
      .catch(() => {
        if (roomRef.current === cur) setMessages([]);
      });
    void jsonFetch<WorkRecord[]>(`/api/works?room=${roomId}`)
      .then((ws) => {
        const now = Date.now();
        setWorks((prev) => {
          const next = { ...prev };
          for (const w of ws) {
          next[w.id] = {
            ...w,
            oneLiner: next[w.id]?.oneLiner,
            firstSeen: next[w.id]?.firstSeen ?? now,
            endedAt: w.status === "done" || w.status === "failed" || w.status === "rejected"
              ? next[w.id]?.endedAt ?? now
              : undefined,
          };
        }
          return next;
        });
      })
      .catch(() => undefined);
    setDetailBotId(null);
  }, [roomId]);

  // --- SSE hub (§6 mapping) -------------------------------------------------------
  const roomRef = useRef(roomId);
  roomRef.current = roomId;
  useEffect(() => {
    const es = new EventSource(withToken("/api/events"));
    let everConnected = false;
    const on = (name: string, fn: (d: unknown) => void): void => {
      es.addEventListener(name, (e) => {
        try {
          fn(JSON.parse((e as MessageEvent).data));
        } catch {
          /* malformed frame — skip */
        }
      });
    };
    const resync = (): void => {
      // §6 reconnect semantics: diff-fetch messages since the last seq we
      // saw, and refresh the snapshot surfaces (status/budget/works).
      void refreshOverview();
      void refreshBudget();
      void refreshWorks();
      const cur = roomRef.current;
      if (cur !== "") {
        void jsonFetch<WorkRecord[]>(`/api/works?room=${cur}`)
          .then((ws) => {
            const now = Date.now();
            setWorks((prev) => {
              const next = { ...prev };
              for (const w of ws) {
          next[w.id] = {
            ...w,
            oneLiner: next[w.id]?.oneLiner,
            firstSeen: next[w.id]?.firstSeen ?? now,
            endedAt: w.status === "done" || w.status === "failed" || w.status === "rejected"
              ? next[w.id]?.endedAt ?? now
              : undefined,
          };
        }
              return next;
            });
          })
          .catch(() => undefined);
        void jsonFetch<{ messages: RoomMessage[] }>(`/api/rooms/${cur}/messages?since=${lastSeqRef.current}`)
          .then((r) => {
            // Same guard as the history fetch: a reconnect fetch in flight
            // while the user switches rooms must not append the OLD room's
            // messages into the new timeline (per-room seq spaces make the
            // seq dedupe and the watermark blind to the mix — R5 P1).
            if (roomRef.current !== cur) return;
            if (r.messages.length === 0) return;
            setMessages((prev) => {
              const seen = new Set(prev.map((m) => m.seq));
              return [...prev, ...r.messages.filter((m) => !seen.has(m.seq))];
            });
            lastSeqRef.current = Math.max(lastSeqRef.current, ...r.messages.map((m) => m.seq));
          })
          .catch(() => undefined);
      }
    };
    es.onopen = (): void => {
      setSse("live");
      if (everConnected) resync(); // a RE-connect diff-fills; first open hydrates via effects
      everConnected = true;
    };
    es.onerror = (): void => setSse("reconnecting");

    on("status", (d) => {
      const s = d as { botId: string; status: string };
      setStatuses((prev) => ({ ...prev, [s.botId]: s.status }));
      if (s.status !== "working") {
        setStreaming((prev) => {
          if (prev[s.botId] === undefined) return prev;
          const next = { ...prev };
          delete next[s.botId];
          return next;
        });
      }
      if (s.status === "idle" || s.status === "stopped" || s.status === "crashed") {
        setToolAt((prev) => {
          if (prev[s.botId] === undefined) return prev;
          const next = { ...prev };
          delete next[s.botId];
          return next;
        });
      }
      // A later transition clears the failure flag — one transient provider
      // blip must not brand the bot red forever (R1 P2-3).
      if (s.status === "idle" || s.status === "working" || s.status === "starting") {
        setFailures((prev) => {
          if (prev[s.botId] === undefined) return prev;
          const next = { ...prev };
          delete next[s.botId];
          return next;
        });
      }
      void refreshOverview();
    });
    on("delta", (d) => {
      const s = d as { botId: string; text: string };
      setStreaming((prev) => ({ ...prev, [s.botId]: (prev[s.botId] ?? "") + s.text }));
    });
    on("tool", (d) => {
      // Live tool activity (dogfood D2): Chief-class agents run multi-step
      // tool loops for 1-2 minutes BETWEEN deltas — silence looked dead.
      // D3: carry the args gist + a per-turn step counter so the loop reads
      // as PROGRESS ("step 4: bash cat poem.txt") not a hang.
      const e = d as { botId: string; toolName: string; argsPreview?: string };
      setToolAt((prev) => {
        const cur = prev[e.botId];
        return { ...prev, [e.botId]: { name: e.toolName, args: e.argsPreview ?? "", ts: Date.now(), step: (cur?.step ?? 0) + 1 } };
      });
    });
    on("message", (d) => {
      // assistant message_end = authoritative final (streaming bubble drops)
      const s = d as { botId: string; role: string };
      if (s.role === "assistant") {
        setStreaming((prev) => {
          if (prev[s.botId] === undefined) return prev;
          const next = { ...prev };
          delete next[s.botId];
          return next;
        });
      }
    });
    on("failure", (d) => {
      const s = d as { botId: string; reason: string };
      setFailures((prev) => ({ ...prev, [s.botId]: s.reason }));
    });
    on("aborted", (d) => {
      const s = d as { botId: string };
      setStreaming((prev) => {
        if (prev[s.botId] === undefined) return prev;
        const next = { ...prev };
        delete next[s.botId];
        return next;
      });
    });
    on("roommessage", (d) => {
      const m = d as RoomMessage;
      setLastByRoom((prev) => ({ ...prev, [m.room]: m }));
      if (m.room === roomRef.current) {
        lastSeqRef.current = Math.max(lastSeqRef.current, m.seq);
        setMessages((prev) => (prev.some((x) => x.seq === m.seq) ? prev : [...prev, m]));
      } else {
        setUnread((prev) => ({ ...prev, [m.room]: (prev[m.room] ?? 0) + 1 }));
      }
    });
    on("turn", (d) => {
      const s = d as TurnEvent;
      if (s.roomId === roomRef.current) setTurn(s);
    });
    on("system", (d) => {
      const s = d as { roomId: string };
      if (s.roomId === roomRef.current) void refreshOverview();
    });
    on("work", (d) => {
      const w = d as { workId: string; status: WorkRecord["status"]; parent: string; child: string; roomId?: string | null; task?: string };
      // Room-less works stay room-less: faking them into whatever room was
      // on screen put cross-bot cards in the wrong timeline (R2 P3).
      const belongs = w.roomId ?? null;
      setWorks((prev) => {
        const cur = prev[w.workId];
        if (cur !== undefined && cur.status === w.status) return prev;
        return {
          ...prev,
          [w.workId]: {
            ...(cur ?? { id: w.workId, parent: w.parent, child: w.child, requestId: "", roomId: belongs, task: w.task ?? "", firstSeen: Date.now() }),
            status: w.status,
            roomId: belongs,
            task: w.task ?? cur?.task ?? "",
            endedAt: w.status === "done" || w.status === "failed" || w.status === "rejected" ? Date.now() : undefined,
          },
        };
      });
    });
    on("progress", (d) => {
      const p = d as { workId: string; oneLiner: string; status: string; roomId?: string | null };
      setWorks((prev) => {
        const cur = prev[p.workId];
        if (cur === undefined) return prev;
        if (cur.oneLiner === p.oneLiner && cur.status === p.status) return prev;
        return { ...prev, [p.workId]: { ...cur, oneLiner: p.oneLiner, status: p.status as WorkRecord["status"] } };
      });
    });
    on("budget", (d) => {
      const b = d as { level: string };
      void refreshBudget();
      if (b.level === "stop") void refreshOverview();
    });
    on("approval", (d) => {
      setApprovals((prev) => [...prev.filter((a) => a.id !== (d as ApprovalEvent).id), d as ApprovalEvent]);
      void refreshOverview();
    });
    on("approvalResolved", (d) => {
      const r = d as { id: string; confirmed: boolean; stale?: boolean };
      setApprovals((prev) => prev.map((a) => (a.id === r.id ? { ...a, resolved: true, outcome: r.confirmed, stale: r.stale === true } : a)));
      setApprovalErrors((prev) => {
        if (prev[r.id] === undefined) return prev;
        const next = { ...prev };
        delete next[r.id];
        return next;
      });
    });
    return () => es.close();
  }, [refreshOverview, refreshBudget]);

  const resolveApproval = async (id: string, confirmed: boolean): Promise<void> => {
    setApprovalErrors((prev) => {
      if (prev[id] === undefined) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      await post(`/api/approvals/${id}/resolve`, { confirmed });
    } catch (e) {
      // ONLY a 404 settles the card stale: the approval no longer exists
      // host-side (resolved elsewhere, or the host restarted and its parked
      // map evaporated) and no SSE event will ever come for it. Any other
      // failure (transport blip, dev-proxy reload) leaves the card live —
      // staling it would lie about a still-parked approval (R4 P2).
      if ((e as { status?: number }).status === 404) {
        setApprovals((prev) =>
          // Never downgrade: a double-click whose first resolve SUCCEEDED can
          // 404 on the second — the SSE settle (allowed) already landed and
          // must win over the stale text (R5 P3).
          prev.map((a) => (a.id === id && a.resolved !== true ? { ...a, resolved: true, outcome: false, stale: true } : a))
        );
        return;
      }
      setApprovalErrors((prev) => ({ ...prev, [id]: String(e).slice(0, 120) }));
    }
  };

  const room = overview?.rooms.find((r) => r.id === roomId) ?? null;
  const roomWorks = useMemo(
    () => Object.values(works).filter((w) => w.roomId === roomId),
    [works, roomId]
  );
  // Queued-handoff badge source (dogfood D1): a bot targeted by pending
  // works LOOKS idle — the inbox must say "queued ×N" instead of silence.
  const queuedFor = useMemo(() => {
    const by: Record<string, number> = {};
    for (const w of Object.values(works)) {
      if (w.status === "pending" || w.status === "working") by[w.child] = (by[w.child] ?? 0) + 1;
    }
    return by;
  }, [works]);
  const setDraft = useCallback((text: string): void => {
    setDrafts((prev) => ({ ...prev, [roomRef.current]: text }));
  }, []);

  return (
    <div className={`app ${rosterOpen ? "" : "roster-closed"} ${ctxOpen ? "" : "ctx-closed"}`}>
      <header className="topbar">
        <button className="ghost" onClick={() => setRosterOpen((v) => !v)} aria-label="roster">☰</button>
        <div className="brand">
          {t.brand} <span className="dim">{t.brandSub}</span>
        </div>
        <div className="brand-note dim">not affiliated with earendil-works / pi</div>
        <div className="live">
          <span className={`dot dot-${sse === "live" ? "live" : "off"}`} />
          {sse === "live" ? t.connected : t.reconnecting}
        </div>
        <button className="ghost" onClick={() => setCtxOpen((v) => !v)} aria-label="context">▤</button>
        <button className="lang" onClick={toggleLang}>{t.langToggle}</button>
      </header>
      <div className="zones">
        <Roster
          t={t}
          lang={lang}
          overview={overview}
          statuses={statuses}
          failures={failures}
          approvals={approvals}
          lastByRoom={lastByRoom}
          unread={unread}
          queuedFor={queuedFor}
          roomId={roomId}
          onSelectRoom={setRoomId}
          onSelectBot={setDetailBotId}
          onRefresh={refreshOverview}
        />
        <Chat
          t={t}
          lang={lang}
          overview={overview}
          room={room}
          turn={turn}
          messages={messages}
          works={roomWorks}
          streaming={streaming}
          toolAt={toolAt}
          statuses={statuses}
          failures={failures}
          approvals={approvals}
          approvalErrors={approvalErrors}
          budgetRows={budgetRows}
          draft={drafts[roomId] ?? ""}
          onDraft={setDraft}
          onResolveApproval={resolveApproval}
          onOpenDetail={setDetailBotId}
          onRefresh={refreshOverview}
          onBudgetChanged={refreshBudget}
        />
        <ContextPanel
          t={t}
          lang={lang}
          overview={overview}
          room={room}
          turn={turn}
          works={roomWorks}
          budgetRows={budgetRows}
          streaming={streaming}
          toolAt={toolAt}
          statuses={statuses}
          detailBotId={detailBotId}
          onBack={() => setDetailBotId(null)}
          onRefresh={refreshOverview}
          onBudgetChanged={refreshBudget}
        />
      </div>
    </div>
  );
}

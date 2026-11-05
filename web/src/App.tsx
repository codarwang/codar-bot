/**
 * codar web — M2-E three-zone workstation (ui-design v1.3 contract):
 * ROSTER inbox | CHAT timeline with inline cards | CONTEXT panel.
 * The SSE hub lives here (§6 mapping); children are pure-ish views.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { makeT, type Lang } from "./i18n";
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
  const [works, setWorks] = useState<Record<string, WorkView>>({});
  const [turn, setTurn] = useState<TurnEvent | null>(null);
  const [budgetRows, setBudgetRows] = useState<BudgetRow[]>([]);
  const [approvals, setApprovals] = useState<Array<ApprovalEvent & { resolved?: boolean; outcome?: boolean }>>([]);
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [sse, setSse] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [ctxOpen, setCtxOpen] = useState(true);
  const [rosterOpen, setRosterOpen] = useState(true);

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

  useEffect(() => {
    void refreshOverview();
    void refreshBudget();
  }, [refreshOverview, refreshBudget]);

  // Room works hydration on selection + live merge via SSE below.
  useEffect(() => {
    if (roomId === "") return;
    void jsonFetch<{ messages: RoomMessage[] }>(`/api/rooms/${roomId}/messages`)
      .then((r) => setMessages(r.messages))
      .catch(() => setMessages([]));
    void jsonFetch<WorkRecord[]>(`/api/works?room=${roomId}`)
      .then((ws) => {
        const now = Date.now();
        setWorks((prev) => {
          const next = { ...prev };
          for (const w of ws) next[w.id] = { ...w, oneLiner: next[w.id]?.oneLiner, firstSeen: next[w.id]?.firstSeen ?? now };
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
    const es = new EventSource("/api/events");
    const on = (name: string, fn: (d: unknown) => void): void => {
      es.addEventListener(name, (e) => {
        try {
          fn(JSON.parse((e as MessageEvent).data));
        } catch {
          /* malformed frame — skip */
        }
      });
    };
    es.onopen = (): void => setSse("live");
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
      void refreshOverview();
    });
    on("delta", (d) => {
      const s = d as { botId: string; text: string };
      setStreaming((prev) => ({ ...prev, [s.botId]: (prev[s.botId] ?? "") + s.text }));
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
      if (m.room !== roomRef.current) return;
      setMessages((prev) => (prev.some((x) => x.seq === m.seq) ? prev : [...prev, m]));
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
      const w = d as { workId: string; status: WorkRecord["status"]; parent: string; child: string };
      setWorks((prev) => {
        const cur = prev[w.workId];
        if (cur !== undefined && cur.status === w.status) return prev;
        return {
          ...prev,
          [w.workId]: {
            ...(cur ?? { id: w.workId, parent: w.parent, child: w.child, requestId: "", roomId: roomRef.current, task: "", firstSeen: Date.now() }),
            status: w.status,
            endedAt: w.status === "done" || w.status === "failed" || w.status === "rejected" ? Date.now() : undefined,
          },
        };
      });
    });
    on("progress", (d) => {
      const p = d as { workId: string; oneLiner: string; status: string };
      setWorks((prev) => {
        const cur = prev[p.workId];
        if (cur === undefined) return prev; // out-of-room work — WORKS panel filters by room anyway
        if (cur.oneLiner === p.oneLiner && cur.status === p.status) return prev;
        return { ...prev, [p.workId]: { ...cur, oneLiner: p.oneLiner, status: p.status as WorkRecord["status"], firstSeen: cur.firstSeen ?? Date.now() } };
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
      const r = d as { id: string; confirmed: boolean };
      setApprovals((prev) => prev.map((a) => (a.id === r.id ? { ...a, resolved: true, outcome: r.confirmed } : a)));
    });
    return () => es.close();
  }, [refreshOverview, refreshBudget]);

  const resolveApproval = async (id: string, confirmed: boolean): Promise<void> => {
    try {
      await post(`/api/approvals/${id}/resolve`, { confirmed });
    } catch {
      /* 404 = already resolved elsewhere; the SSE sync will settle the card */
    }
  };

  const room = overview?.rooms.find((r) => r.id === roomId) ?? null;
  const roomWorks = useMemo(
    () => Object.values(works).filter((w) => w.roomId === roomId),
    [works, roomId]
  );

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
          messages={messages}
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
          approvals={approvals}
          onResolveApproval={resolveApproval}
          onRefresh={refreshOverview}
        />
        <ContextPanel
          t={t}
          lang={lang}
          overview={overview}
          room={room}
          turn={turn}
          works={roomWorks}
          budgetRows={budgetRows}
          detailBotId={detailBotId}
          onBack={() => setDetailBotId(null)}
          onRefresh={refreshOverview}
          onBudgetChanged={refreshBudget}
        />
      </div>
    </div>
  );
}

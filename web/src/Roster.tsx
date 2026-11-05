/**
 * Roster — the inbox sidebar (ui-design §2): every row is a bot or a room
 * with a one-line latest state (per-room previews + unread counters);
 * badges sort attention first; rooms creatable in-place.
 */
import { useState } from "react";
import type { Lang } from "./i18n";
import { jsonFetch, post, type ApprovalEvent, type Overview, type RoomMessage } from "./api";

type T = ReturnType<typeof import("./i18n").makeT>;

interface Props {
  t: T;
  lang: Lang;
  overview: Overview | null;
  statuses: Record<string, string>;
  failures: Record<string, string>;
  approvals: Array<ApprovalEvent & { resolved?: boolean }>;
  lastByRoom: Record<string, RoomMessage>;
  unread: Record<string, number>;
  roomId: string;
  onSelectRoom: (id: string) => void;
  onSelectBot: (id: string) => void;
  onRefresh: () => Promise<void>;
}

const AVATAR_COLORS = ["#6c8eff", "#41b883", "#e29a3a", "#c65cc4", "#3ab0c9", "#d4615f"];
const avatarColor = (id: string): string =>
  AVATAR_COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length]!;

export function Roster(p: Props): JSX.Element {
  const { t, overview } = p;
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState<"bot" | "room" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const attention = (botId: string): boolean =>
    p.approvals.some((a) => a.botId === botId && !a.resolved) || p.failures[botId] !== undefined;

  const botBadge = (botId: string): { cls: string; label: string } => {
    if (attention(botId)) return { cls: "attention", label: t.needAttention };
    const st = p.statuses[botId] ?? "stopped";
    if (st === "working") return { cls: "working", label: t.working };
    if (st === "crashed") return { cls: "attention", label: t.crashed };
    if (st === "stopped") return { cls: "stopped", label: t.stopped };
    return { cls: "idle", label: st };
  };

  const act = async (botId: string, action: "start" | "stop" | "delete"): Promise<void> => {
    setBusy(botId + action);
    try {
      if (action === "delete") await fetch(`/api/bots/${botId}`, { method: "DELETE" });
      else await post(`/api/bots/${botId}/${action}`);
      await p.onRefresh();
    } finally {
      setBusy(null);
    }
  };

  // §2 sort: attention > working > name.
  const bots = [...(overview?.bots ?? [])].sort((a, b) => {
    const rank = (id: string): number => (attention(id) ? 0 : (p.statuses[id] ?? "") === "working" ? 1 : 2);
    const r = rank(a.id) - rank(b.id);
    return r !== 0 ? r : a.name.localeCompare(b.name);
  });

  return (
    <aside className="roster">
      <div className="roster-section">{t.rosterRooms}</div>
      {(overview?.rooms ?? []).map((r) => {
        const last = p.lastByRoom[r.id];
        return (
          <div
            key={r.id}
            className={`row row-room ${r.id === p.roomId ? "sel" : ""}`}
            onClick={() => p.onSelectRoom(r.id)}
          >
            <div className="stack">
              {r.members.slice(0, 3).map((m, i) => (
                <span key={m} className="avatar avatar-sm" style={{ background: avatarColor(m), marginLeft: i === 0 ? 0 : -6 }}>{(overview?.bots.find((b) => b.id === m)?.name ?? "?").slice(0, 1)}</span>
              ))}
            </div>
            <div className="row-main">
              <div className="row-title">
                <span className="name">◎ {r.name}</span>
                {(p.unread[r.id] ?? 0) > 0 && <span className="badge badge-unread">{p.unread[r.id]} {t.unread}</span>}
                {r.status === "paused" && <span className={`badge badge-${r.pauseReason === "budget" ? "stop" : "warn"}`}>{r.pauseReason === "budget" ? t.pausedBudget : t.pausedPingPong}</span>}
              </div>
              <div className="row-sub">
                {last !== undefined ? last.text.slice(0, 60) : `${r.members.length} ${t.membersLabel}`}
              </div>
            </div>
          </div>
        );
      })}
      <div className="roster-foot">
        <button className="ghost" onClick={() => setCreating(creating === "room" ? null : "room")}>+ {t.newRoom}</button>
      </div>
      {creating === "room" && (
        <RoomForm
          t={t}
          overview={overview}
          error={formError}
          setError={setFormError}
          onDone={async () => {
            setCreating(null);
            await p.onRefresh();
          }}
          onCancel={() => setCreating(null)}
        />
      )}

      <div className="roster-section">{t.rosterBots}</div>
      {bots.map((b) => {
        const badge = botBadge(b.id);
        return (
          <div
            key={b.id}
            className={`row row-bot ${b.chief ? "chief" : ""}`}
            onClick={() => p.onSelectBot(b.id)}
          >
            <span className="avatar" style={{ background: avatarColor(b.id) }}>{b.name.slice(0, 1)}</span>
            <div className="row-main">
              <div className="row-title">
                <span className="name">{b.name}{b.chief ? " ★" : ""}</span>
                <span className={`badge badge-${badge.cls}`}>{badge.label}</span>
              </div>
              <div className="row-sub">
                {p.failures[b.id] !== undefined
                  ? p.failures[b.id]!.slice(0, 60)
                  : (p.statuses[b.id] === "working" ? t.working : `${b.model.provider}/${b.model.modelId}`).slice(0, 60)}
              </div>
            </div>
            <div className="row-acts" onClick={(e) => e.stopPropagation()}>
              {(p.statuses[b.id] === "stopped" || p.statuses[b.id] === "crashed") && (
                <button className="mini" disabled={busy !== null} onClick={() => void act(b.id, "start")}>{t.start}</button>
              )}
              {p.statuses[b.id] !== "stopped" && p.statuses[b.id] !== "crashed" && (
                <button className="mini" disabled={busy !== null} onClick={() => void act(b.id, "stop")}>{t.stopBot}</button>
              )}
              <button className="mini danger" disabled={busy !== null} onClick={() => void act(b.id, "delete")}>{t.delete}</button>
            </div>
          </div>
        );
      })}

      <div className="roster-foot">
        <button className="ghost" onClick={() => setCreating(creating === "bot" ? null : "bot")}>+ {t.newBot}</button>
      </div>

      {creating === "bot" && (
        <BotForm
          t={t}
          overview={overview}
          error={formError}
          setError={setFormError}
          onDone={async () => {
            setCreating(null);
            await p.onRefresh();
          }}
          onCancel={() => setCreating(null)}
        />
      )}
    </aside>
  );
}

function RoomForm(props: {
  t: T;
  overview: Overview | null;
  error: string | null;
  setError: (e: string | null) => void;
  onDone: () => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const { t } = props;
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [admin, setAdmin] = useState("");
  const [busy, setBusy] = useState(false);
  const toggle = (id: string): void => {
    setMembers((ms) => {
      const next = ms.includes(id) ? ms.filter((x) => x !== id) : [...ms, id];
      setAdmin((a) => (a === "" || next.includes(a) ? next[0] ?? "" : a));
      return next;
    });
  };
  const create = async (): Promise<void> => {
    setBusy(true);
    props.setError(null);
    try {
      await post("/api/rooms", { name, members, admin: admin || members[0] });
      await props.onDone();
    } catch (e) {
      props.setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="form">
      <input placeholder={t.roomNameLabel} value={name} onChange={(e) => setName(e.target.value)} />
      {(props.overview?.bots ?? []).map((b) => (
        <label key={b.id} className="check">
          <input type="checkbox" checked={members.includes(b.id)} onChange={() => toggle(b.id)} /> {b.name}
        </label>
      ))}
      <div className="form-row">
        <span className="dim">{t.adminPick}</span>
        <select value={admin} onChange={(e) => setAdmin(e.target.value)}>
          {members.map((m) => (
            <option key={m} value={m}>{props.overview?.bots.find((b) => b.id === m)?.name ?? m}</option>
          ))}
        </select>
      </div>
      {props.error !== null && <div className="error">{props.error}</div>}
      <div className="form-row">
        <button disabled={busy || name === "" || members.length === 0} onClick={() => void create()}>{t.createRoom}</button>
        <button className="ghost" onClick={props.onCancel}>{t.cancel}</button>
      </div>
    </div>
  );
}

function BotForm(props: {
  t: T;
  overview: Overview | null;
  error: string | null;
  setError: (e: string | null) => void;
  onDone: () => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const { t } = props;
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [workDir, setWorkDir] = useState("");
  const [provider, setProvider] = useState(props.overview?.bots[0]?.model.provider ?? "zai-coding-cn");
  const [modelId, setModelId] = useState(props.overview?.bots[0]?.model.modelId ?? "glm-5.3");
  const [thinking, setThinking] = useState("low");
  const [busy, setBusy] = useState(false);
  const create = async (): Promise<void> => {
    setBusy(true);
    props.setError(null);
    try {
      await post("/api/bots", {
        name, role, workDir,
        model: { provider, modelId, thinkingLevel: thinking },
      });
      await props.onDone();
    } catch (e) {
      props.setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="form">
      <input placeholder={t.nameLabel} value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder={t.roleLabel} value={role} onChange={(e) => setRole(e.target.value)} />
      <input placeholder={t.workDirLabel} value={workDir} onChange={(e) => setWorkDir(e.target.value)} />
      <div className="form-row">
        <input placeholder={t.providerLabel} value={provider} onChange={(e) => setProvider(e.target.value)} />
        <input placeholder={t.modelIdLabel} value={modelId} onChange={(e) => setModelId(e.target.value)} />
        <select value={thinking} onChange={(e) => setThinking(e.target.value)}>
          <option value="off">off</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
        </select>
      </div>
      {props.error !== null && <div className="error">{props.error}</div>}
      <div className="form-row">
        <button disabled={busy || name === "" || workDir === ""} onClick={() => void create()}>{t.createLabel}</button>
        <button className="ghost" onClick={props.onCancel}>{t.cancel}</button>
      </div>
    </div>
  );
}

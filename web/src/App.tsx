/**
 * codar web — M1 plain UI (deliberately unstyled-first; the real
 * interaction-design pass lands between M1 and M2 per product decision).
 * Views: Overview (roster) · Chat (streaming + stop) · Usage (ledger).
 */
import { useCallback, useEffect, useRef, useState } from "react";

interface BotRecord {
  id: string;
  name: string;
  role: string;
  chief: boolean;
  model: { provider: string; modelId: string; thinkingLevel: string };
  sandbox: { mode: string };
  sessionPath: string | null;
}
interface RuntimeStatus {
  botId: string;
  status: string;
  lastError: string | null;
}
interface Overview {
  bots: Array<BotRecord & { runtime?: RuntimeStatus }>;
  rooms: Array<{ id: string; name: string; members: string[]; admin: string; mode: string }>;
}
interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
}
interface UsageRow {
  botId: string;
  model: string;
  kind: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costMicros: number;
}

const jsonFetch = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, init);
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
};

export function App(): JSX.Element {
  const [tab, setTab] = useState<"overview" | "chat" | "usage">("overview");
  return (
    <div className="app">
      <header>
        <h1>codar <span className="dim">bot team</span></h1>
        <nav>
          <button className={tab === "overview" ? "on" : ""} onClick={() => setTab("overview")}>Overview</button>
          <button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>Chat</button>
          <button className={tab === "usage" ? "on" : ""} onClick={() => setTab("usage")}>Usage</button>
        </nav>
      </header>
      <main>
        {tab === "overview" && <Overview />}
        {tab === "chat" && <Chat />}
        {tab === "usage" && <Usage />}
      </main>
    </div>
  );
}

function Overview(): JSX.Element {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newWorkDir, setNewWorkDir] = useState("");
  const refresh = useCallback(async () => {
    try { setData(await jsonFetch<Overview>("/api/overview")); setError(null); }
    catch (e) { setError(String(e)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("status", () => void refresh());
    return () => es.close();
  }, [refresh]);

  const act = async (id: string, action: "start" | "stop" | "delete"): Promise<void> => {
    setBusy(id + action);
    try {
      if (action === "delete") await jsonFetch(`/api/bots/${id}`, { method: "DELETE" });
      else await jsonFetch(`/api/bots/${id}/${action}`, { method: "POST" });
      await refresh();
    } catch (e) { setError(String(e)); } finally { setBusy(null); }
  };

  const create = async (): Promise<void> => {
    setBusy("create");
    try {
      await jsonFetch("/api/bots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName, workDir: newWorkDir }),
      });
      setNewName(""); setNewWorkDir("");
      await refresh();
    } catch (e) { setError(String(e)); } finally { setBusy(null); }
  };

  return (
    <section>
      {error !== null && <div className="error">{error}</div>}
      <table>
        <thead><tr><th>bot</th><th>model</th><th>sandbox</th><th>status</th><th>actions</th></tr></thead>
        <tbody>
          {(data?.bots ?? []).map((b) => (
            <tr key={b.id}>
              <td>{b.name}{b.chief ? " ★" : ""}<div className="dim">{b.role}</div></td>
              <td className="dim">{b.model.provider}/{b.model.modelId}</td>
              <td className="dim">{b.sandbox.mode}</td>
              <td><span className={`st st-${b.runtime?.status ?? "stopped"}`}>{b.runtime?.status ?? "stopped"}</span>
                {b.runtime?.lastError != null && <div className="error">{b.runtime.lastError.slice(0, 120)}</div>}</td>
              <td>
                <button disabled={busy !== null} onClick={() => void act(b.id, b.id && (b.runtime?.status === "stopped" || b.runtime?.status === "crashed") ? "start" : "stop")}>
                  {(b.runtime?.status ?? "stopped") === "idle" || (b.runtime?.status ?? "") === "working" ? "stop" : "start"}
                </button>{" "}
                <button disabled={busy !== null} onClick={() => void act(b.id, "delete")}>delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <input placeholder="new bot name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <input placeholder="workDir (absolute)" value={newWorkDir} onChange={(e) => setNewWorkDir(e.target.value)} />
        <button disabled={busy !== null || newName === "" || newWorkDir === ""} onClick={() => void create()}>create bot</button>
      </div>
      <h3>rooms</h3>
      <ul>
        {(data?.rooms ?? []).map((r) => (
          <li key={r.id}>{r.name} · {r.mode} · members: {r.members.length}</li>
        ))}
      </ul>
    </section>
  );
}

function Chat(): JSX.Element {
  const [bots, setBots] = useState<BotRecord[]>([]);
  const [botId, setBotId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<string>("stopped");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void jsonFetch<BotRecord[]>("/api/bots").then((bs) => {
      setBots(bs);
      if (bs.length > 0) setBotId((cur) => cur === "" ? bs[0]!.id : cur);
    }).catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    const es = new EventSource("/api/events");
    const onStatus = (e: MessageEvent): void => {
      const d = JSON.parse(e.data) as { botId: string; status: string };
      if (d.botId === botId) setStatus(d.status);
    };
    const onDelta = (e: MessageEvent): void => {
      const d = JSON.parse(e.data) as { botId: string; text: string };
      if (d.botId !== botId) return;
      setStreaming(true);
      setMessages((ms) => {
        const last = ms[ms.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return [...ms.slice(0, -1), { ...last, text: last.text + d.text }];
        }
        return [...ms, { role: "assistant", text: d.text, streaming: true }];
      });
    };
    const onMessage = (e: MessageEvent): void => {
      const d = JSON.parse(e.data) as { botId: string; role: string; text: string };
      if (d.botId !== botId || d.role !== "assistant") return;
      setMessages((ms) => {
        const last = ms[ms.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return [...ms.slice(0, -1), { role: "assistant", text: d.text }];
        }
        return ms;
      });
      setStreaming(false);
    };
    es.addEventListener("status", onStatus);
    es.addEventListener("delta", onDelta);
    es.addEventListener("message", onMessage);
    return () => { es.close(); };
  }, [botId]);
  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight); }, [messages]);

  const send = async (): Promise<void> => {
    if (draft === "" || botId === "") return;
    const text = draft;
    setDraft("");
    setMessages((ms) => [...ms, { role: "user", text }]);
    try {
      // Optimistic local echo; the authoritative transcript is the ledger
      // of assistant messages (SSE) — final text arrives via /prompt result.
      await jsonFetch<{ text: string }>(`/api/bots/${botId}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
    } catch (e) {
      setError(String(e));
      setStreaming(false);
    }
  };
  const stop = async (): Promise<void> => {
    try { await jsonFetch(`/api/bots/${botId}/abort`, { method: "POST" }); }
    catch (e) { setError(String(e)); }
  };

  return (
    <section className="chat">
      {error !== null && <div className="error">{error}</div>}
      <div className="row">
        <select value={botId} onChange={(e) => { setBotId(e.target.value); setMessages([]); }}>
          {bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <span className={`st st-${status}`}>{status}</span>
        {streaming && <button onClick={() => void stop()}>■ stop</button>}
      </div>
      <div className="messages" ref={scrollRef}>
        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>{m.text}{(m as { streaming?: boolean }).streaming ? "▍" : ""}</div>
        ))}
      </div>
      <div className="row">
        <input
          placeholder="message…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
        />
        <button disabled={draft === "" || streaming} onClick={() => void send()}>send</button>
      </div>
    </section>
  );
}

function Usage(): JSX.Element {
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void jsonFetch<UsageRow[]>("/api/usage").then(setRows).catch((e) => setError(String(e)));
  }, []);
  const micros = (m: number): string => `$${(m / 1e6).toFixed(4)}`;
  return (
    <section>
      {error !== null && <div className="error">{error}</div>}
      <table>
        <thead><tr><th>bot</th><th>model</th><th>kind</th><th>input</th><th>output</th><th>cacheRead</th><th>cost</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.botId}</td><td className="dim">{r.model}</td><td>{r.kind}</td>
              <td>{r.input.toLocaleString()}</td><td>{r.output.toLocaleString()}</td>
              <td>{r.cacheRead.toLocaleString()}</td><td>{micros(r.costMicros)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

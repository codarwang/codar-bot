/**
 * api — typed fetch helpers + shared domain types for the M2-E three-zone
 * workstation (ui-design v1.3 §6 SSE mapping is implemented in App.tsx).
 */
export interface BotRecord {
  id: string;
  name: string;
  role: string;
  chief: boolean;
  model: { provider: string; modelId: string; thinkingLevel: string };
  sandbox: { mode: string };
  sessionPath: string | null;
  budget: Budget4;
}
export interface Budget4 {
  maxTokens: number;
  maxCostMicros: number;
  maxTurns: number;
  maxWallMs: number;
}
export interface RoomRecord {
  id: string;
  name: string;
  members: string[];
  admin: string;
  mode: string;
  status: "active" | "paused";
  pauseReason: "ping-pong" | "budget" | "manual" | null;
  pausedAt?: string | null;
  budget: Budget4;
}
export interface RuntimeStatus {
  botId: string;
  status: string;
  detail?: string;
  lastError?: string | null;
}
export interface Overview {
  bots: Array<BotRecord & { runtime?: RuntimeStatus }>;
  rooms: RoomRecord[];
}
export interface RoomMessage {
  seq: number;
  ts: string;
  room: string;
  from: { kind: "user" | "bot" | "system"; id?: string };
  text: string;
}
export interface WorkRecord {
  id: string;
  parent: string;
  child: string;
  requestId: string;
  status: "pending" | "working" | "done" | "failed" | "rejected";
  roomId: string | null;
  task: string;
}
export interface BudgetRow {
  scope: "bot" | "room";
  id: string;
  month: string;
  tokens: number;
  costMicros: number;
  budget: Budget4;
}
export interface ApprovalEvent {
  id: string;
  botId: string | null;
  title: string;
  message: string;
}
export interface MemoryFile {
  path: string;
  content: string;
}

export const jsonFetch = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
};

export const post = (path: string, body?: unknown): Promise<unknown> =>
  jsonFetch<unknown>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

export const put = (path: string, body: unknown): Promise<unknown> =>
  jsonFetch<unknown>(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const patch = (path: string, body: unknown): Promise<unknown> =>
  jsonFetch<unknown>(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Slot states straight from architecture §6.1 (turn strip + panel). */
export type SlotState = "waiting" | "speaking" | "posted" | "passed" | "working" | "failed" | "timed-out";
export interface TurnEvent {
  roomId: string;
  slots: Record<string, SlotState>;
  pausedReason: "ping-pong" | "budget" | "manual" | null;
}

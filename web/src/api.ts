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
  workDir: string;
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
  turns?: number;
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

/** Discovery surface (GET /api/providers): keys.json ∪ presets ∪ in-use,
 *  zero key material. models carry UI metadata only. */
export interface ProviderModelInfo {
  id: string;
  name?: string;
  badge?: string;
}
export interface ProviderInfo {
  id: string;
  label: string;
  configured: boolean;
  preset: boolean;
  api?: string;
  baseUrl?: string;
  models: ProviderModelInfo[];
}
export type ProvidersResponse = { providers: ProviderInfo[] };

/** Entry surface (GET /api/settings/providers, M3-3.7): the discovery report
 *  plus masked key / per-bot in-use lists — never key material. */
export interface ProviderSettingsUse {
  kind: "bot" | "review";
  id: string | null;
  name: string;
  modelId: string;
}
export interface ProviderSettingsEntry {
  id: string;
  label: string;
  preset: boolean;
  api?: string;
  baseUrl?: string;
  baseUrlCustom: boolean;
  apiCustom: boolean;
  configured: boolean;
  keyPresent: boolean;
  maskedKey: string | null;
  entryPresent: boolean;
  models: ProviderModelInfo[];
  inUse: ProviderSettingsUse[];
}
export type ProviderSettingsResponse = { providers: ProviderSettingsEntry[] };
export type ProviderPatch = { apiKey?: string | null; baseUrl?: string | null; api?: string | null };
export type ProviderTestResult =
  | { ok: true; models: string[] }
  | { ok: false; error: { code: "auth" | "not_found" | "timeout" | "network"; message: string } };

export const getSettingsProviders = (): Promise<ProviderSettingsResponse> =>
  jsonFetch<ProviderSettingsResponse>("/api/settings/providers");

export const putProvider = (id: string, patch: ProviderPatch): Promise<ProviderSettingsResponse> =>
  jsonFetch<ProviderSettingsResponse>(`/api/settings/providers/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });

export const deleteProvider = (id: string): Promise<ProviderSettingsResponse> =>
  jsonFetch<ProviderSettingsResponse>(`/api/settings/providers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

export const testProvider = (id: string): Promise<ProviderTestResult> =>
  jsonFetch<ProviderTestResult>(`/api/settings/providers/${encodeURIComponent(id)}/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Body intentionally empty: the endpoint composes stored entry ?? preset
    // values ONLY (R1-P1 — a body-supplied baseUrl must never pair with the
    // stored key).
    body: JSON.stringify({}),
  });

/** pi ThinkingLevel (7 values). One definition for both the create form and
 *  the detail editor — mirrors the host's THINKING_LEVELS validation. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** M3.4b Bearer token: ?token=<key> on first load → sessionStorage →
 *  Authorization header on every /api/* request. EventSource cannot send
 *  headers, so the token also rides as ?token= for SSE connections. */
function authHeaders(): Record<string, string> {
  const token = sessionStorage.getItem("codar.token");
  return token !== null ? { Authorization: `Bearer ${token}` } : {};
}

export function withToken(path: string): string {
  const token = sessionStorage.getItem("codar.token");
  if (token === null || !path.startsWith("/api/")) return path;
  return path.includes("?") ? `${path}&token=${encodeURIComponent(token)}` : `${path}?token=${encodeURIComponent(token)}`;
}

export function initToken(): void {
  const url = new URL(window.location.href);
  const t = url.searchParams.get("token");
  if (t !== null) {
    sessionStorage.setItem("codar.token", t);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.toString());
  }
}

export const jsonFetch = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(withToken(path), {
    ...init,
    headers: { ...init?.headers, ...authHeaders() },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    // The status rides on the Error so callers can distinguish "gone"
    // (404) from transient transport failures (M2-E R4 P2).
    throw Object.assign(new Error(body.error ?? `${res.status}`), { status: res.status });
  }
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

export const patchRoom = (roomId: string, body: { members?: string[]; name?: string }): Promise<RoomRecord> =>
  jsonFetch<RoomRecord>(`/api/rooms/${roomId}`, {
    method: "PATCH",
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

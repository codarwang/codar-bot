/**
 * HTTP API — REST + SSE (architecture §7), zero-dependency node:http.
 *
 * v1 contract is explicitly unstable (README: early development). The API
 * surface for M1: overview, bots CRUD + prompt/abort/messages, rooms CRUD,
 * usage totals, events SSE. SSE events: status | delta | message | failure |
 * aborted | hello.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { BotManager } from "./bot-manager.js";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute, sep, join } from "node:path";
import { ApiError } from "./http-error.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** UTC calendar-month start as a ledger `hour` string (§6.1a window). */
function monthStartHour(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 13);
}
/** Shared POST/PATCH model validation (R5: the PATCH copy had drifted out
 *  of existence — one validator, both routes). */
function validateModel(model: unknown): BotRecord["model"] {
  if (typeof model !== "object" || model === null || Array.isArray(model)) {
    throw new ApiError(400, "model must be an object");
  }
  const m = model as Record<string, unknown>;
  if (typeof m["provider"] !== "string" || !SAFE_ID.test(m["provider"]) ||
      typeof m["modelId"] !== "string" || !SAFE_ID.test(m["modelId"]) ||
      typeof m["thinkingLevel"] !== "string" || m["thinkingLevel"] === "") {
    throw new ApiError(400, "model needs string provider/modelId (charset [A-Za-z0-9._-]) /thinkingLevel");
  }
  return m as unknown as BotRecord["model"];
}
import type { Store, BotRecord } from "./store.js";
import { defaultBudget } from "./store.js";
import type { UsageLedger } from "./usage-ledger.js";
import type { RoomEngine } from "./room-engine.js";
import type { Handoff } from "./handoff.js";
import type { Budget } from "./budget.js";

export interface ApiDeps {
  store: Store;
  bots: BotManager;
  ledger: UsageLedger;
  rooms: RoomEngine;
  handoff: Handoff;
  budget: Budget;
  /** Built web UI dir (web/dist); absent ⇒ API-only mode. */
  webDir?: string;
}

interface SseClient {
  id: string;
  res: ServerResponse;
}

export class HttpApi {
  private server: Server | null = null;
  private readonly sseClients = new Set<SseClient>();

  constructor(private readonly deps: ApiDeps) {
    const { bots } = deps;
    bots.on("status", (e) => this.broadcast("status", e));
    bots.on("delta", (e) => this.broadcast("delta", e));
    bots.on("message", (e) => this.broadcast("message", e));
    bots.on("failure", (e) => this.broadcast("failure", e));
    bots.on("aborted", (e) => this.broadcast("aborted", e));
    const { rooms, handoff, budget } = deps;
    rooms.on("turn", (e) => this.broadcast("turn", e));
    rooms.on("system", (e) => this.broadcast("system", e));
    rooms.on("message", (e) => this.broadcast("roommessage", e));
    bots.on("tool", (e) => this.broadcast("tool", e));
    handoff.on("progress", (e) => this.broadcast("progress", e));
    handoff.on("work", (e) => this.broadcast("work", e));
    budget.on("budget", (e) => this.broadcast("budget", e));
  }

  /** Static serving of the built SPA (non-/api GET). Traversal-safe. */
  private serveStatic(res: ServerResponse, urlPath: string): void {
    const webDir = this.deps.webDir;
    if (webDir === undefined) {
      this.send(res, 404, { error: "no web UI built (API-only mode)" });
      return;
    }
    let rel: string;
    try {
      // Decode AFTER URL normalization — %2e%2e%2f re-introduces "../" here,
      // so the containment check below MUST be boundary-safe (R1 P1).
      rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\//, "");
    } catch {
      this.send(res, 400, { error: "malformed path encoding" });
      return;
    }
    const webRoot = resolve(webDir);
    const target = resolve(webRoot, rel);
    const inside = relative(webRoot, target);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      this.send(res, 404, { error: "not found" });
      return;
    }
    let served: string; // the file ACTUALLY served (fallback changes it)
    let body: Buffer;
    try {
      body = readFileSync(target);
      served = target;
    } catch {
      // SPA fallback: unknown non-asset paths get index.html; the content
      // type follows the SERVED file, not the requested path (R1 P2).
      if (!rel.startsWith("assets/")) {
        try {
          served = join(webRoot, "index.html");
          body = readFileSync(served);
        } catch { this.send(res, 404, { error: "not found" }); return; }
      } else {
        this.send(res, 404, { error: "not found" });
        return;
      }
    }
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
    };
    const ext = served.slice(served.lastIndexOf("."));
    res.writeHead(200, {
      "content-type": types[ext] ?? "application/octet-stream",
      // Hashed vite assets are immutable; everything else revalidates.
      ...(served.includes(`${sep}assets${sep}`) ? { "cache-control": "public, max-age=31536000, immutable" } : {}),
    });
    res.end(body);
  }

  async listen(port: number, host = "127.0.0.1"): Promise<number> {
    this.server = createServer((req, res) => this.dispatch(req, res));
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject); // EADDRINUSE must reject, not throw unhandled
      this.server!.listen(port, host, () => {
        const addr = this.server!.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : port);
      });
    });
  }

  async close(): Promise<void> {
    for (const c of this.sseClients) c.res.end();
    this.sseClients.clear();
    if (this.server === null) return;
    await new Promise((resolve) => this.server!.close(resolve));
    this.server = null;
  }

  private broadcast(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.sseClients) {
      try {
        c.res.write(frame);
      } catch {
        this.sseClients.delete(c);
      }
    }
  }

  private dispatch(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
    void this.route(req, res, url, parts).catch((e) => {
      if (res.headersSent) return; // late failures after SSE/headers: not res writable
      if (e instanceof ApiError) {
        this.send(res, e.statusCode, { error: String(e.message).slice(0, 400) });
        return;
      }
      this.send(res, 500, { error: String(e).slice(0, 400) });
    });
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    parts: string[]
  ): Promise<void> {
    if (req.method === "GET" && url.pathname === "/api/events") {
      this.attachSse(req, res);
      return;
    }
    if (parts[0] !== "api") {
      if (req.method === "GET") this.serveStatic(res, url.pathname);
      else this.send(res, 404, { error: "not found" });
      return;
    }
    const [, resource, id, action] = parts;

    if (resource === "overview" && req.method === "GET" && parts.length === 2) {
      this.send(res, 200, {
        bots: this.deps.store.state.bots.map((b) => ({
          ...b,
          runtime: this.deps.bots.statusOfAll().find((s) => s.botId === b.id) ?? { botId: b.id, status: "stopped", lastError: null },
        })),
        rooms: this.deps.store.state.rooms,
      });
      return;
    }

    if (parts.length > 4) {
      this.send(res, 404, { error: "no route (too many path segments)" });
      return;
    }
    if (resource === "bots") {
      if (req.method === "GET" && id === undefined) {
        this.send(res, 200, this.deps.store.state.bots);
        return;
      }
      if (req.method === "GET" && id !== undefined && action === undefined) {
        const bot = this.deps.store.bot(id);
        if (bot === undefined) return this.send(res, 404, { error: `no bot ${id}` });
        this.send(res, 200, bot);
        return;
      }
      if (req.method === "POST" && id === undefined) {
        const body = (await this.readJson(req)) as Partial<BotRecord>;
        const name = String(body.name ?? "").trim();
        if (name.length === 0) throw new ApiError(400, "name required");
        const workDir = String(body.workDir ?? "");
        if (!workDir.startsWith("/")) {
          throw new ApiError(400, "workDir must be an absolute path");
        }
        if (body.sandbox !== undefined && body.sandbox.mode !== "docker" && body.sandbox.mode !== "host-not-isolated") {
          throw new ApiError(400, "sandbox.mode must be docker | host-not-isolated");
        }
        if (body.sandbox?.mode === "docker" && workDir.includes(":")) {
          throw new ApiError(400, "workDir must not contain ':' (breaks docker -v mounts)");
        }
        const model = body.model === undefined
          ? { provider: "zai-coding-cn", modelId: "glm-5.3", thinkingLevel: "low" }
          : validateModel(body.model);
        const budget = body.budget ?? { maxTokens: 5_000_000, maxCostMicros: 20_000_000, maxTurns: 2_000, maxWallMs: 3_600_000 };
        for (const k of ["maxTokens", "maxCostMicros", "maxTurns", "maxWallMs"] as const) {
          if (typeof budget[k] !== "number" || !Number.isFinite(budget[k]) || budget[k] < 0) {
            throw new ApiError(400, `budget.${k} must be a non-negative number`);
          }
        }
        let bot;
        try {
          bot = this.deps.store.addBot({
            name, role: String(body.role ?? ""), chief: body.chief === true,
            model, workDir, sessionPath: null,
            // Requested mode honored (validated above) — never silently
            // downgraded to a bare process while claiming isolation.
            sandbox: body.sandbox?.mode === "docker" ? { mode: "docker" as const } : { mode: "host-not-isolated" as const },
            budget,
          });
        } catch (e) {
          throw new ApiError(409, String(e).slice(0, 200));
        }
        this.send(res, 201, bot);
        return;
      }
      if (req.method === "PATCH" && id !== undefined && action === undefined) {
        const body = (await this.readJson(req)) as Record<string, unknown>;
        // Field whitelist: id is immutable; chief flips go through the same
        // invariant as creation (single chief); names must stay unique.
        const patch: Partial<BotRecord> = {};
        if (typeof body["name"] === "string" && body["name"].trim().length > 0) patch.name = body["name"].trim();
        if (typeof body["role"] === "string") patch.role = body["role"];
        if (body["model"] !== undefined) patch.model = validateModel(body["model"]);
        const budget = body["budget"];
        if (budget !== undefined) {
          if (typeof budget !== "object" || budget === null || Array.isArray(budget)) {
            throw new ApiError(400, "budget must be an object");
          }
          for (const k of ["maxTokens", "maxCostMicros", "maxTurns", "maxWallMs"] as const) {
            const v = (budget as Record<string, unknown>)[k];
            if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
              throw new ApiError(400, `budget.${k} must be a non-negative number`);
            }
          }
          patch.budget = budget as BotRecord["budget"];
        }
        if (body["id"] !== undefined || body["sessionPath"] !== undefined || body["chief"] !== undefined) {
          throw new ApiError(400, "id/sessionPath/chief are immutable over PATCH");
        }
        if (Object.keys(patch).length === 0) throw new ApiError(400, "no patchable fields");
        const existing = this.deps.store.bot(id);
        if (existing === undefined) return this.send(res, 404, { error: `no bot ${id}` });
        if (patch.name !== undefined && patch.name !== existing.name &&
            this.deps.store.state.bots.some((b) => b.name === patch.name)) {
          throw new ApiError(409, `bot name "${patch.name}" already in use`);
        }
        this.send(res, 200, this.deps.store.updateBot(id, patch));
        return;
      }
      if (req.method === "POST" && id !== undefined && action === "start") {
        await this.deps.bots.start(id);
        this.send(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && id !== undefined && action === "stop") {
        await this.deps.bots.stop(id);
        this.send(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && id !== undefined && action === "prompt") {
        const body = (await this.readJson(req)) as { message?: string };
        if (typeof body.message !== "string" || body.message.length === 0) {
          throw new ApiError(400, "message required");
        }
        const text = await this.deps.bots.prompt(id, body.message);
        this.send(res, 200, { text });
        return;
      }
      if (req.method === "GET" && id !== undefined && action === "messages") {
        const messages = await this.deps.bots.messages(id);
        this.send(res, 200, { messages });
        return;
      }
      if (req.method === "POST" && id !== undefined && action === "abort") {
        await this.deps.bots.interrupt(id);
        this.send(res, 200, { ok: true });
        return;
      }
      if (req.method === "DELETE" && id !== undefined && action === undefined) {
        await this.deps.bots.stop(id);
        this.deps.store.removeBot(id);
        this.deps.bots.forget(id); // drop the runtime bookkeeping entry too
        this.send(res, 200, { ok: true });
        return;
      }
    }

    if (resource === "rooms") {
      if (req.method === "GET" && id === undefined) {
        this.send(res, 200, this.deps.store.state.rooms);
        return;
      }
      if (req.method === "GET" && id !== undefined && action === undefined) {
        const room = this.deps.store.room(id);
        if (room === undefined) return this.send(res, 404, { error: `no room ${id}` });
        this.send(res, 200, room);
        return;
      }
      if (req.method === "POST" && id === undefined) {
        const body = (await this.readJson(req)) as Record<string, unknown>;
        const name = String(body["name"] ?? "").trim();
        const members = Array.isArray(body["members"]) ? body["members"].filter((m): m is string => typeof m === "string") : [];
        const admin = String(body["admin"] ?? members[0] ?? "");
        if (name.length === 0 || members.length === 0 || admin === "") {
          throw new ApiError(400, "rooms need name, members[], admin");
        }
        if (this.deps.store.state.rooms.some((r) => r.name === name)) {
          throw new ApiError(409, `room name "${name}" already in use`);
        }
        const sharedDir = String(body["sharedDir"] ?? join(this.deps.store.statePath, "..", "shared"));
        if (!sharedDir.startsWith("/")) {
          throw new ApiError(400, "sharedDir must be an absolute path");
        }
        for (const m of members) {
          if (this.deps.store.bot(m) === undefined) throw new ApiError(400, `unknown member bot ${m}`);
        }
        if (this.deps.store.bot(admin) === undefined) {
          throw new ApiError(400, `unknown admin bot ${admin}`);
        }
        mkdirSync(sharedDir, { recursive: true }); // AFTER validation: rejects leave nothing behind
        const room = this.deps.store.addRoom({
          name, members, admin,
          mode: body["mode"] === "round-robin" ? "round-robin" : "admin-reply",
          sharedDir,
          budget: defaultBudget(),
          goal: null,
        });
        this.send(res, 201, room);
        return;
      }
      if (req.method === "GET" && id !== undefined && action === "messages") {
        const since = Number(url.searchParams.get("since") ?? "0");
        this.send(res, 200, { messages: this.deps.rooms.history(id, Number.isFinite(since) ? since : 0) });
        return;
      }
      if (req.method === "POST" && id !== undefined && action === "messages") {
        const body = (await this.readJson(req)) as { text?: unknown };
        if (typeof body.text !== "string" || body.text.trim().length === 0) {
          throw new ApiError(400, "text required");
        }
        const room = this.deps.store.room(id);
        if (room === undefined) throw new ApiError(404, `no room ${id}`);
        // Accepted-then-async (R1 P2-5): the HTTP call must not hang for the
        // whole turn (up to replyTimeoutMs × responders); results stream via
        // SSE roommessage/turn/system. Budget-pause still rejects 409.
        if (this.deps.rooms.pausedReason(id) === "budget") {
          // Entry-point rollover check (M2-C R2 P2-3): a stale-window pause
          // lifts itself here; a current-window one still 409s.
          this.deps.budget.rolloverIfStale(id);
          if (this.deps.rooms.pausedReason(id) === "budget") {
            throw new ApiError(409, `room ${id} is budget-paused — adjust the budget to resume`);
          }
        }
        void this.deps.rooms.userSay(id, body.text).catch((e: unknown) => {
          this.broadcast("system", { roomId: id, text: `turn failed: ${String(e).slice(0, 200)}` });
        });
        this.send(res, 202, { ok: true, accepted: true });
        return;
      }
    }

    if (resource === "budget") {
      if (req.method === "GET" && parts.length === 2) {
        // Collection: summarize every scope's current-month usage.
        const sinceHour = monthStartHour();
        const scopes: Array<Record<string, unknown>> = [];
        for (const b of this.deps.store.state.bots) {
          const totals = this.deps.ledger.totals({ botId: b.id, sinceHour });
          scopes.push(this.budgetRow("bot", b.id, totals, b.budget));
        }
        for (const r of this.deps.store.state.rooms) {
          let tokens = 0; let micros = 0;
          for (const m of r.members) {
            const totals = this.deps.ledger.totals({ botId: m, sinceHour });
            for (const row of totals) { tokens += row.input + row.output + row.cacheRead + row.cacheWrite; micros += row.costMicros; }
          }
          scopes.push({ scope: "room", id: r.id, month: sinceHour.slice(0, 7), tokens, costMicros: micros, budget: r.budget });
        }
        this.send(res, 200, scopes);
        return;
      }
      if (req.method === "GET" && id !== undefined && action === undefined) {
        const scope = id.startsWith("room_") ? "room" : "bot";
        const sinceHour = monthStartHour();
        const memberIds = scope === "room" ? (this.deps.store.room(id)?.members ?? []) : [id];
        let tokens = 0; let micros = 0;
        for (const m of memberIds) {
          const totals = this.deps.ledger.totals({ botId: m, sinceHour });
          for (const r of totals) { tokens += r.input + r.output + r.cacheRead + r.cacheWrite; micros += r.costMicros; }
        }
        const limit = scope === "bot"
          ? this.deps.store.bot(id)?.budget
          : this.deps.store.room(id)?.budget;
        this.send(res, 200, { scope, id, month: sinceHour.slice(0, 7), tokens, costMicros: micros, budget: limit ?? null });
        return;
      }
      if (req.method === "PUT" && id !== undefined && action === undefined) {
        const body = (await this.readJson(req)) as Record<string, unknown>;
        const patch: Partial<{ maxTokens: number; maxCostMicros: number; maxTurns: number; maxWallMs: number }> = {};
        for (const k of ["maxTokens", "maxCostMicros", "maxTurns", "maxWallMs"] as const) {
          const v = body[k];
          if (v !== undefined) {
            if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
              throw new ApiError(400, `${k} must be a non-negative number`);
            }
            patch[k] = v;
          }
        }
        if (Object.keys(patch).length === 0) throw new ApiError(400, "no budget fields");
        if (id.startsWith("room_")) {
          const room = this.deps.store.room(id);
          if (room === undefined) throw new ApiError(404, `no room ${id}`);
          const nextBudget = { ...room.budget, ...patch };
          this.deps.store.updateRoom(id, { budget: nextBudget });
          // A new limit re-arms the window's enforcement (M2-C R2 P2-2).
          this.deps.budget.rearm("room", id);
          // Resume ONLY when the new limit actually clears this month's usage
          // (M2-C R1 P2: an unconditional resume un-pauses a still-over room).
          if (room.status === "paused" && room.pauseReason === "budget") {
            const sinceHour = monthStartHour();
            let micros = 0; let tokens = 0;
            for (const m of room.members) {
              const totals = this.deps.ledger.totals({ botId: m, sinceHour });
              for (const row of totals) { tokens += row.input + row.output + row.cacheRead + row.cacheWrite; micros += row.costMicros; }
            }
            const clears =
              (nextBudget.maxTokens <= 0 || tokens < nextBudget.maxTokens) &&
              (nextBudget.maxCostMicros <= 0 || micros < nextBudget.maxCostMicros) &&
              // Turns dimension: this month's settles must sit below the new
              // limit too (M2-C R2 P2-2 — a turns-paused room with a raised
              // token limit stays paused otherwise).
              (nextBudget.maxTurns <= 0 || this.deps.budget.turnsThisMonth("room", id) < nextBudget.maxTurns);
            if (clears) {
              this.deps.rooms.resume(id, "budget adjusted — room resumed");
            }
          }
          this.send(res, 200, this.deps.store.room(id)!.budget);
          return;
        }
        const bot = this.deps.store.bot(id);
        if (bot === undefined) throw new ApiError(404, `no bot ${id}`);
        this.deps.store.updateBot(id, { budget: { ...bot.budget, ...patch } });
        this.deps.budget.rearm("bot", id);
        this.send(res, 200, this.deps.store.bot(id)!.budget);
        return;
      }
    }
    if (resource === "works") {
      if (req.method === "GET" && parts.length === 2) {
        this.send(res, 200, this.deps.handoff.works(url.searchParams.get("room") ?? undefined));
        return;
      }
    }
    if (resource === "usage" && req.method === "GET" && parts.length === 2) {
      this.send(res, 200, this.deps.ledger.totals({
        botId: url.searchParams.get("bot") ?? undefined,
        sinceHour: url.searchParams.get("since") ?? undefined,
      }));
      return;
    }

    this.send(res, 404, { error: `no route ${req.method} ${url.pathname}` });
  }

  private attachSse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const client: SseClient = { id: randomUUID(), res };
    this.sseClients.add(client);
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(ping);
      }
    }, 20_000);
    req.on("close", () => {
      clearInterval(ping);
      this.sseClients.delete(client);
    });
  }

  private budgetRow(scope: string, id: string, totals: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number; costMicros: number }>, budget: { maxTokens: number; maxCostMicros: number }): Record<string, unknown> {
    let tokens = 0; let micros = 0;
    for (const r of totals) { tokens += r.input + r.output + r.cacheRead + r.cacheWrite; micros += r.costMicros; }
    return { scope, id, month: monthStartHour().slice(0, 7), tokens, costMicros: micros, budget };
  }

  private readJson(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("error", () => reject(new ApiError(400, "request aborted")));
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 1_048_576) {
          reject(new ApiError(400, "body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try {
          const parsed = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            reject(new ApiError(400, "body must be a JSON object"));
            return;
          }
          resolve(parsed);
        } catch {
          reject(new ApiError(400, "body is not valid JSON"));
        }
      });
    });
  }

  private send(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }
}

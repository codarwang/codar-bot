/**
 * HTTP API — REST + SSE (architecture §7), zero-dependency node:http.
 *
 * v1 contract is explicitly unstable (README: early development). The API
 * surface for M1-A: overview, bots CRUD, per-bot prompt/abort, events SSE.
 * SSE events: status | delta | message | failure | system.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { BotManager } from "./bot-manager.js";
import type { Store, BotRecord } from "./store.js";
import type { UsageLedger } from "./usage-ledger.js";

export interface ApiDeps {
  store: Store;
  bots: BotManager;
  ledger: UsageLedger;
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
  }

  async listen(port: number, host = "127.0.0.1"): Promise<number> {
    this.server = createServer((req, res) => this.dispatch(req, res));
    return new Promise((resolve) => {
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
      this.send(res, 404, { error: "not found" });
      return;
    }
    const [, resource, id, action] = parts;

    if (resource === "overview" && req.method === "GET") {
      this.send(res, 200, {
        bots: this.deps.store.state.bots.map((b) => ({
          ...b,
          runtime: this.deps.bots.statusOfAll().find((s) => s.botId === b.id) ?? { botId: b.id, status: "stopped", lastError: null },
        })),
        rooms: this.deps.store.state.rooms,
      });
      return;
    }

    if (resource === "bots") {
      if (req.method === "GET" && id === undefined) {
        this.send(res, 200, this.deps.store.state.bots);
        return;
      }
      if (req.method === "GET" && id !== undefined) {
        const bot = this.deps.store.bot(id);
        if (bot === undefined) return this.send(res, 404, { error: `no bot ${id}` });
        this.send(res, 200, bot);
        return;
      }
      if (req.method === "POST" && id === undefined) {
        const body = (await this.readJson(req)) as Partial<BotRecord>;
        const bot = this.deps.store.addBot({
          name: String(body.name ?? "").trim(),
          role: String(body.role ?? ""),
          chief: body.chief === true,
          model: body.model ?? { provider: "zai-coding-cn", modelId: "glm-5.3", thinkingLevel: "low" },
          workDir: String(body.workDir ?? ""),
          sessionPath: null,
          sandbox: body.sandbox ?? { mode: "host-not-isolated" },
          budget: body.budget ?? { maxTokens: 5_000_000, maxCostMicros: 20_000_000, maxTurns: 2_000, maxWallMs: 3_600_000 },
        });
        this.send(res, 201, bot);
        return;
      }
      if (req.method === "PATCH" && id !== undefined) {
        const body = (await this.readJson(req)) as Partial<BotRecord>;
        this.send(res, 200, this.deps.store.updateBot(id, body));
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
          return this.send(res, 400, { error: "message required" });
        }
        const text = await this.deps.bots.prompt(id, body.message);
        this.send(res, 200, { text });
        return;
      }
      if (req.method === "POST" && id !== undefined && action === "abort") {
        await this.deps.bots.interrupt(id);
        this.send(res, 200, { ok: true });
        return;
      }
      if (req.method === "DELETE" && id !== undefined) {
        await this.deps.bots.stop(id);
        this.deps.store.removeBot(id);
        this.send(res, 200, { ok: true });
        return;
      }
    }

    if (resource === "usage" && req.method === "GET") {
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

  private readJson(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
    let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 1_048_576) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  private send(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }
}

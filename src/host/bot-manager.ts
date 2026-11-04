/**
 * bot-manager — per-Bot RpcClient supervision (architecture §2.4, §3).
 *
 * Lifecycle: stopped → starting → idle ⇄ working; crash → backoff restart
 * (≤ MAX_RESTARTS, then stopped + alert); stop() → stopped (no auto-restart).
 * Streams per-bot events (deltas, status, failures) onto an EventBus the API
 * layer projects to SSE. Usage from message_end lands in the ledger
 * (kind=chat for every M1 turn — tool/memory-review kinds arrive with M2).
 */
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { RpcClient, type AgentEvent, type UiRequest } from "../driver/rpc-client.js";
import type { BotRecord } from "./store.js";
import type { Store } from "./store.js";
import type { UsageLedger } from "./usage-ledger.js";
import { botPiConfDir } from "./paths.js";

export type BotStatus = "stopped" | "starting" | "idle" | "working" | "crashed";

export interface BotManagerEvents {
  status: { botId: string; status: BotStatus; detail?: string };
  delta: { botId: string; text: string };
  message: { botId: string; role: string; text: string };
  failure: { botId: string; reason: string };
}

export type UsageKind = "chat" | "tool" | "memory-review";

export interface SpawnOptions {
  /** bare mode: the pi binary (tests point this at the fake-pi fixture). */
  bin?: string;
  /** sandbox argv shim (docker run …) — presence selects sandboxed spawn. */
  sandboxArgv?: string[];
  env?: Record<string, string>;
  extensionPath?: string;
}

interface ManagedBot {
  botId: string;
  client: RpcClient | null;
  status: BotStatus;
  restarts: number;
  lastError: string | null;
}

const MAX_RESTARTS = 3;
const RESTART_BACKOFF_MS = 1_000;

interface UsageShape {
  input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
  cacheWrite1h?: number; totalTokens?: number;
  cost?: { total?: number };
}
const num = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const hourNow = (): string => new Date().toISOString().slice(0, 13);

export class BotManager extends EventEmitter {
  private readonly bots = new Map<string, ManagedBot>();
  private readonly spawnDefaults: SpawnOptions;

  constructor(
    private readonly store: Store,
    private readonly ledger: UsageLedger,
    private readonly dataRoot: string,
    spawnDefaults: SpawnOptions = {}
  ) {
    super();
    this.spawnDefaults = spawnDefaults;
  }

  status(botId: string): BotStatus {
    return this.bots.get(botId)?.status ?? "stopped";
  }

  statusOfAll(): Array<{ botId: string; status: BotStatus; lastError: string | null }> {
    return [...this.bots.values()].map((b) => ({ botId: b.botId, status: b.status, lastError: b.lastError }));
  }

  async start(botId: string, spawnOverride: SpawnOptions = {}): Promise<void> {
    const bot = this.store.bot(botId);
    if (bot === undefined) throw new Error(`no bot ${botId}`);
    let managed = this.bots.get(botId);
    if (managed?.client) throw new Error(`bot ${botId} already running`);
    if (managed === undefined) {
      managed = { botId, client: null, status: "stopped", restarts: 0, lastError: null };
      this.bots.set(botId, managed);
    }
    managed.status = "starting";
    this.emit("status", { botId, status: "starting" });

    const opts = { ...this.spawnDefaults, ...spawnOverride };
    const client = new RpcClient({
      bin: opts.bin,
      argvPrefix: opts.sandboxArgv,
      cwd: bot.workDir,
      env: { ...opts.env, CODAR_GATE_AUDIT: this.auditPathFor(bot) },
      idleTimeoutMs: 5 * 60_000,
      wallTimeoutMs: 24 * 60 * 60_000,
      onUiRequest: (req) => this.handleUi(bot, client, req),
    });
    managed.client = client;
    client.on("event", (e: AgentEvent) => this.onEvent(bot, client, e));
    client.on("error", (e: Error) => this.onChildFailure(bot, String(e)));
    client.on("bot_failed", (f) => {
      const reason = `stopReason=${String((f as { stopReason?: string }).stopReason ?? "?")} ${String((f as { errorMessage?: string }).errorMessage ?? "")}`.trim();
      this.emit("failure", { botId, reason });
    });
    client.on("exit", () => {
      if (this.bots.get(botId)?.client === client) {
        this.onChildFailure(bot, "rpc child exited");
      }
    });

    try {
      await client.start({
        extensionPath: opts.extensionPath,
        model: `${bot.model.provider}/${bot.model.modelId}`,
        thinking: bot.model.thinkingLevel,
        noSession: false,
      });
      // Session resume: host path → child path (bare mode: identical; the
      // sandbox translation hook lands with the docker runner).
      if (bot.sessionPath !== null) {
        await client.command(
          { type: "switch_session", sessionPath: bot.sessionPath } as Record<string, unknown>
        );
      }
    } catch (error) {
      managed.client = null;
      await this.maybeRestart(bot, String(error));
      throw error;
    }

    managed.status = "idle";
    managed.lastError = null;
    this.emit("status", { botId, status: "idle" });
  }

  async stop(botId: string): Promise<void> {
    const managed = this.bots.get(botId);
    if (managed === undefined || managed.client === null) return;
    const client = managed.client;
    managed.client = null;
    managed.status = "stopped";
    client.kill();
    this.emit("status", { botId, status: "stopped" });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.bots.keys()].map((id) => this.stop(id)));
  }

  /** Prompt a bot; resolves with the final assistant text when it settles. */
  async prompt(botId: string, message: string, kind: UsageKind = "chat"): Promise<string> {
    const managed = this.bots.get(botId);
    if (managed?.client === null || managed === undefined) throw new Error(`bot ${botId} is not running`);
    const client = managed.client!;
    const bot = this.store.bot(botId)!;
    managed.status = "working";
    this.emit("status", { botId, status: "working" });
    (client as unknown as { __usageKind?: UsageKind }).__usageKind = kind;
    const settle = this.waitForSettle(client);
    const pr = await client.prompt(message);
    if (!pr.success) {
      managed.status = "idle";
      this.emit("status", { botId, status: "idle", detail: "prompt rejected" });
      throw new Error(`prompt rejected: ${pr.error}`);
    }
    await settle;
    managed.status = "idle";
    this.emit("status", { botId, status: "idle" });
    // Persist the session path the child now reports (crash-safe resume).
    try {
      const state = await client.command({ type: "get_state" } as Record<string, unknown>);
      const sessionFile =
        state.success ? ((state.data as { sessionFile?: unknown } | null)?.sessionFile) : undefined;
      if (typeof sessionFile === "string" && sessionFile !== bot.sessionPath) {
        this.store.updateBot(botId, { sessionPath: sessionFile });
      }
    } catch {
      /* best-effort persistence; next successful prompt retries */
    }
    const last = await client.command({ type: "get_last_assistant_text" } as Record<string, unknown>);
    const text =
      last.success && typeof (last.data as { text?: unknown } | null)?.text === "string"
        ? (last.data as { text: string }).text
        : "";
    return text;
  }

  async interrupt(botId: string): Promise<void> {
    const managed = this.bots.get(botId);
    if (managed?.client == null) throw new Error(`bot ${botId} is not running`);
    await managed.client.abort();
  }

  private waitForSettle(client: RpcClient): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { client.off("settled", done); resolve(); };
      client.on("settled", done);
    });
  }

  private handleUi(bot: BotRecord, client: RpcClient, req: UiRequest): void {
    // M1-A slice: no approval surface yet. CODAR_M1_AUTOAPPROVE=1 (tests and
    // spikes only) auto-approves confirms; otherwise requests park until the
    // M1-C approval API answers them. Never silently deny — a parked call is
    // honest, a silent deny loses work.
    void bot;
    if (process.env.CODAR_M1_AUTOAPPROVE === "1" && req.method === "confirm") {
      client.replyUi({ type: "extension_ui_response", id: req.id, confirmed: true });
    }
  }

  private onEvent(bot: BotRecord, client: RpcClient, e: AgentEvent): void {
    if (e.type === "message_update") {
      const delta = (e as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
      if (delta?.type === "text_delta" && typeof delta.delta === "string") {
        this.emit("delta", { botId: bot.id, text: delta.delta });
      }
      return;
    }
    if (e.type === "message_end") {
      const message = (e as { message?: { role?: string; usage?: UsageShape; content?: Array<{ type?: string; text?: string }> } }).message;
      if (message?.role === "assistant" && message.usage) {
        const kind = (client as unknown as { __usageKind?: UsageKind }).__usageKind ?? "chat";
        const u = message.usage;
        this.ledger.record({
          hour: hourNow(),
          botId: bot.id,
          model: `${bot.model.provider}/${bot.model.modelId}`,
          kind,
          input: num(u.input), output: num(u.output),
          cacheRead: num(u.cacheRead), cacheWrite: num(u.cacheWrite),
          cacheWrite1h: num(u.cacheWrite1h),
          costMicros: Math.round(num(u.cost?.total) * 1e6),
        });
      }
      if (message?.role === "assistant") {
        const text = Array.isArray(message.content)
          ? message.content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join("")
          : "";
        this.emit("message", { botId: bot.id, role: "assistant", text });
      }
      return;
    }
  }

  private auditPathFor(bot: BotRecord): string {
    // Host-controlled audit location (§3.4 note: never inside the bot's
    // writable workDir) — pi-conf/<botId>/gate-audit.jsonl.
    return join(botPiConfDir(this.dataRoot, bot.id), "gate-audit.jsonl");
  }

  private async onChildFailure(bot: BotRecord, reason: string): Promise<void> {
    const managed = this.bots.get(bot.id);
    if (managed === undefined || managed.client === null) return; // stopped on purpose
    managed.client = null;
    managed.status = "crashed";
    managed.lastError = reason;
    this.emit("status", { botId: bot.id, status: "crashed", detail: reason });
    this.emit("failure", { botId: bot.id, reason });
    await this.maybeRestart(bot, reason);
  }

  private async maybeRestart(bot: BotRecord, reason: string): Promise<void> {
    const managed = this.bots.get(bot.id);
    if (managed === undefined) return;
    if (managed.restarts >= MAX_RESTARTS) {
      managed.status = "stopped";
      this.emit("status", { botId: bot.id, status: "stopped", detail: `restart budget exhausted (${reason})` });
      return;
    }
    managed.restarts += 1;
    await new Promise((r) => setTimeout(r, RESTART_BACKOFF_MS * managed!.restarts));
    try {
      await this.start(bot.id);
      managed.restarts = 0;
    } catch {
      await this.maybeRestart(bot, reason);
    }
  }
}

/**
 * bot-manager — per-Bot RpcClient supervision (architecture §2.4, §3).
 *
 * Lifecycle: stopped → starting → idle ⇄ working; crash → SINGLE-FLIGHT
 * exponential-backoff restart (≤ MAX_RESTARTS, then stopped + alert);
 * stop() sets a stop-intent sentinel honored by every async path (a stop
 * during starting/working never resurrects the bot).
 *
 * All lifecycle transitions append to the host audit log (§2.4). Usage from
 * message_end lands in the ledger (kind=chat for M1 turns; tool and
 * memory-review kinds arrive with M2).
 */
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync } from "node:fs";
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
  /** stop intent: once set, no async path may spawn this bot again. */
  stopRequested: boolean;
  /** single-flight restart guard (review R1: dual-chain race). */
  restarting: boolean;
  /** lifecycle generation: bumped by every start(); a recovery chain only
   *  acts while its snapshot equals the current epoch — a superseded chain
   *  (manual stop→start, or a newer chain) exits without status writes
   *  (review R2: stale chain used to mark a live bot "stopped"). */
  epoch: number;
}

const MAX_RESTARTS = 3;
const RESTART_BASE_MS = 1_000; // exponential: base * 2^(n-1) ⇒ 1s/2s/4s

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

  private audit(kind: string, body: Record<string, unknown>): void {
    try {
      appendFileSync(
        join(this.dataRoot, "audit.jsonl"),
        `${JSON.stringify({ kind, ts: new Date().toISOString(), ...body })}\n`,
        "utf8"
      );
    } catch (error) {
      // Audit failure must not take the host down; the in-memory event bus
      // still carries the transition. (§5 audit is best-effort at this layer.)
      console.error(`[audit] append failed: ${String(error).slice(0, 160)}`);
    }
  }

  private managed(botId: string): ManagedBot {
    let m = this.bots.get(botId);
    if (m === undefined) {
      m = { botId, client: null, status: "stopped", restarts: 0, lastError: null, stopRequested: false, restarting: false, epoch: 0 };
      this.bots.set(botId, m);
    }
    return m;
  }

  private setStatus(m: ManagedBot, status: BotStatus, detail?: string): void {
    const from = m.status;
    m.status = status;
    this.audit("lifecycle", { botId: m.botId, from, to: status, detail });
    this.emit("status", { botId: m.botId, status, detail });
  }

  async start(botId: string, spawnOverride: SpawnOptions = {}): Promise<void> {
    const bot = this.store.bot(botId);
    if (bot === undefined) throw new Error(`no bot ${botId}`);
    const m = this.managed(botId);
    if (m.client !== null) throw new Error(`bot ${botId} already running`);
    m.epoch += 1; // supersedes any in-flight recovery chain for this bot
    m.stopRequested = false;
    this.setStatus(m, "starting");

    // Host-controlled dirs must exist before the child starts (the gate's
    // audit appendFileSync fails closed on ENOENT).
    mkdirSync(botPiConfDir(this.dataRoot, botId), { recursive: true });
    mkdirSync(bot.workDir, { recursive: true });

    const opts = { ...this.spawnDefaults, ...spawnOverride };
    const client = new RpcClient({
      bin: opts.bin,
      argvPrefix: opts.sandboxArgv,
      cwd: bot.workDir,
      env: { ...opts.env, CODAR_GATE_AUDIT: join(botPiConfDir(this.dataRoot, botId), "gate-audit.jsonl") },
      idleTimeoutMs: 5 * 60_000,
      wallTimeoutMs: 24 * 60 * 60_000,
      onUiRequest: (req) => this.handleUi(client, req),
    });
    m.client = client;
    client.on("event", (e: AgentEvent) => this.onEvent(bot, client, e));
    client.on("error", (e: Error) => void this.onChildFailure(bot, client, String(e)));
    client.on("bot_failed", (f) => {
      if ((f as { aborted?: boolean }).aborted === true) return; // user abort, not a failure
      const reason = `stopReason=${String((f as { stopReason?: string }).stopReason ?? "?")} ${String((f as { errorMessage?: string }).errorMessage ?? "")}`.trim();
      this.emit("failure", { botId, reason });
      this.audit("bot_failed", { botId, reason });
    });
    client.on("exit", () => void this.onChildFailure(bot, client, "rpc child exited"));

    try {
      const ready = await client.start({
        extensionPath: opts.extensionPath,
        model: `${bot.model.provider}/${bot.model.modelId}`,
        thinking: bot.model.thinkingLevel,
        noSession: false,
      });
      void ready;
      if (m.stopRequested) {
        // stop() raced the ready probe: honor it, do not surface idle.
        this.dropClient(m, client);
        this.setStatus(m, "stopped", "stop honored during startup");
        return;
      }
      if (bot.sessionPath !== null) {
        const sw = await client.command(
          { type: "switch_session", sessionPath: bot.sessionPath } as Record<string, unknown>
        );
        if (!sw.success) {
          throw new Error(`switch_session rejected: ${sw.error ?? "?"} (stale sessionPath?)`);
        }
      }
    } catch (error) {
      this.dropClient(m, client);
      // Recovery runs detached — the caller learns about THIS failure now,
      // not after the whole backoff ladder (R2: ~90s 500s).
      void this.recoverFromFailure(bot, client, String(error)).catch(() => undefined);
      throw error;
    }

    m.restarts = 0;
    m.lastError = null;
    this.setStatus(m, "idle");
  }

  private dropClient(m: ManagedBot, client: RpcClient): void {
    if (m.client === client) m.client = null;
    client.kill();
  }

  async stop(botId: string): Promise<void> {
    const m = this.bots.get(botId);
    if (m === undefined) return;
    m.stopRequested = true; // sentinel: no async path may respawn (R1 P1-2)
    if (m.client === null) {
      if (m.status !== "stopped") this.setStatus(m, "stopped");
      return;
    }
    this.dropClient(m, m.client);
    this.setStatus(m, "stopped");
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.bots.keys()].map((id) => this.stop(id)));
  }

  /** Prompt a bot; resolves with the final assistant text when it settles.
   *  Rejections carry honest reasons (handled/queued disposition, child
   *  death, stop) — never hangs (R1 P1-1: settled/error/exit race). */
  async prompt(botId: string, message: string, kind: UsageKind = "chat"): Promise<string> {
    const m = this.bots.get(botId);
    if (m === undefined || m.client === null) throw new Error(`bot ${botId} is not running`);
    if (m.status === "working") throw new Error(`bot ${botId} is already working on a prompt`);
    if (m.status !== "idle") throw new Error(`bot ${botId} is ${m.status} (wait for idle)`);
    const client = m.client;
    const bot = this.store.bot(botId)!;
    this.setStatus(m, "working");
    (client as unknown as { __usageKind?: UsageKind }).__usageKind = kind;

    // settle race: settled vs error vs exit — first wins, listeners detach
    // on settlement (no leak across rejected prompts; R1 P1-1).
    let detach: () => void = () => {};
    const settleRace = new Promise<void>((resolve, reject) => {
      const onSettled = (): void => resolve();
      const onError = (e: Error): void => reject(new Error(`bot process failed: ${String(e)}`));
      const onExit = (): void => reject(new Error(`bot process exited mid-prompt${m.stopRequested ? " (stopped)" : ""}`));
      client.once("settled", onSettled);
      client.once("error", onError);
      client.once("exit", onExit);
      detach = () => {
        client.off("settled", onSettled);
        client.off("error", onError);
        client.off("exit", onExit);
      };
    });
    void settleRace.then(detach, detach);

    try {
      const pr = await client.prompt(message);
      if (!pr.success) throw new Error(`prompt rejected: ${pr.error}`);
      const disposition = (pr.data as { disposition?: string } | null)?.disposition;
      if (disposition !== "started") {
        // "handled" (extension command) / "queued": no run will settle.
        throw new Error(`prompt ${disposition} (no agent run — try a plain message)`);
      }
      await settleRace;
      if (m.client !== client) {
        throw new Error(m.stopRequested ? "bot stopped mid-prompt" : "bot replaced mid-prompt");
      }
    } catch (error) {
      detach(); // rejected prompts must not linger listeners (R2 P3-1)
      // setStatus("working") inside this function defeats TS's property
      // narrowing — re-widen deliberately.
      if (m.client === client && (m.status as BotStatus) === "working") {
        this.setStatus(m, "idle", "prompt failed");
      }
      throw error;
    }

    this.setStatus(m, "idle");
    // Persist the session path the child now reports (crash-safe resume).
    try {
      const state = await client.command({ type: "get_state" } as Record<string, unknown>);
      const sessionFile =
        state.success ? ((state.data as { sessionFile?: unknown } | null)?.sessionFile) : undefined;
      if (typeof sessionFile === "string" && sessionFile !== bot.sessionPath && sessionFile !== "") {
        this.store.updateBot(botId, { sessionPath: sessionFile });
      }
    } catch {
      /* best-effort persistence; next successful prompt retries */
    }
    const last = await client.command({ type: "get_last_assistant_text" } as Record<string, unknown>);
    return last.success && typeof (last.data as { text?: unknown } | null)?.text === "string"
      ? (last.data as { text: string }).text
      : "";
  }

  async interrupt(botId: string): Promise<void> {
    const m = this.bots.get(botId);
    if (m?.client == null) throw new Error(`bot ${botId} is not running`);
    await m.client.abort();
  }

  private handleUi(client: RpcClient, req: UiRequest): void {
    // M1-A slice: no approval surface yet. CODAR_M1_AUTOAPPROVE=1 (tests and
    // spikes only) auto-approves confirms; otherwise requests park until the
    // M1-C approval API answers them. Never silently deny — a parked call is
    // honest, a silent deny loses work.
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
      const message = (e as { message?: { role?: string; usage?: UsageShape; content?: Array<{ type?: string; text?: string }>; stopReason?: string } }).message;
      if (message?.role === "assistant" && message.usage && message.stopReason !== "error") {
        // Errored message_end carries an all-zero usage object (M0-S3) —
        // excluded from the ledger by the stopReason guard plus the all-zero
        // natural no-op.
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

  /** Single failure-recovery funnel (R1 P1-4: exit/error handlers and the
   *  start() catch path used to race). Only the CURRENT client's failure
   *  may trigger recovery; a superseded client's late events are ignored. */
  private async onChildFailure(bot: BotRecord, client: RpcClient, reason: string): Promise<void> {
    const m = this.bots.get(bot.id);
    if (m === undefined || m.client !== client) return; // superseded or stopped
    m.client = null;
    m.lastError = reason;
    this.setStatus(m, "crashed", reason);
    this.emit("failure", { botId: bot.id, reason });
    client.kill();
    await this.recoverFromFailure(bot, client, reason);
  }

  private async recoverFromFailure(bot: BotRecord, deadClient: RpcClient, reason: string): Promise<void> {
    const m = this.bots.get(bot.id);
    if (m === undefined) return;
    if (m.client === deadClient) m.client = null;
    if (m.stopRequested) {
      if (m.status !== "stopped") this.setStatus(m, "stopped", `stop honored after failure: ${reason}`);
      return;
    }
    if (m.restarting) return; // single-flight: one chain owns recovery
    if (m.restarts >= MAX_RESTARTS) {
      this.setStatus(m, "stopped", `restart budget exhausted (${reason})`);
      return;
    }
    m.restarting = true;
    const myEpoch = m.epoch; // superseded chains exit silently (R2 P2)
    try {
      while (m.restarts < MAX_RESTARTS && !m.stopRequested && m.epoch === myEpoch) {
        m.restarts += 1;
        const backoff = RESTART_BASE_MS * 2 ** (m.restarts - 1);
        await new Promise((r) => setTimeout(r, backoff));
        if (m.stopRequested || m.epoch !== myEpoch) break;
        try {
          await this.start(bot.id); // bumps epoch on success path; owns status
          return;
        } catch {
          /* retry loop continues while this chain still owns the lifecycle */
        }
      }
      if (!m.stopRequested && m.epoch === myEpoch && m.client === null) {
        this.setStatus(m, "stopped", `restart budget exhausted (${reason})`);
      }
    } finally {
      if (m.epoch === myEpoch) m.restarting = false;
    }
  }
}

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
import { buildSpawnConfig, materializePiConf, type BotSpawnConfig, type KeysDoc } from "./provider-config.js";

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
  /** lifecycle generation: bumped by EXTERNAL start() calls only (the
   *  recovery chain re-enters via {internal:true} and keeps its epoch). A
   *  chain only acts while its snapshot equals the current epoch — a
   *  superseded chain exits without status writes (R2: stale chains used to
   *  mark live bots "stopped"; R3: chain-internal starts must not self-
   *  supersede or the single-flight flag latches forever). */
  epoch: number;
  /** A failure that arrived while the single-flight flag was held by a
   *  superseded chain — the exiting chain re-funnels it (R4 P2: new-
   *  generation failures used to be silently dropped → permanent crashed). */
  pendingFailure: string | null;
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
    spawnDefaults: SpawnOptions = {},
    /** §3.3 provider chain: keys.json → per-bot env + pi-conf/models.json. */
    private readonly keys: KeysDoc = { providers: {} }
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
      m = { botId, client: null, status: "stopped", restarts: 0, lastError: null, stopRequested: false, restarting: false, epoch: 0, pendingFailure: null };
      this.bots.set(botId, m);
    }
    return m;
  }

  private setStatus(m: ManagedBot, status: BotStatus, detail?: string): void {
    const from = m.status;
    if (from === status) {
      // Same-state transitions are no-ops: handover re-funnels used to
      // double-write "exhausted → stopped" (R6 P3). No event, no audit line.
      return;
    }
    m.status = status;
    this.audit("lifecycle", { botId: m.botId, from, to: status, detail });
    this.emit("status", { botId: m.botId, status, detail });
  }

  async start(
    botId: string,
    spawnOverride: SpawnOptions = {},
    opts: { internal?: boolean } = {}
  ): Promise<void> {
    const bot = this.store.bot(botId);
    if (bot === undefined) throw new Error(`no bot ${botId}`);
    const m = this.managed(botId);
    if (m.client !== null) throw new Error(`bot ${botId} already running`);
    if (opts.internal !== true) m.epoch += 1; // external start supersedes chains
    m.stopRequested = false;
    m.pendingFailure = null;
    this.setStatus(m, "starting");

    const spawn = { ...this.spawnDefaults, ...spawnOverride };
    // §3.3: standard providers inject their env var; custom providers get a
    // models.json with $CODAR_BOT_KEY interpolation (secret never on disk).
    const cfg: BotSpawnConfig = buildSpawnConfig(this.keys, this.dataRoot, botId, bot.model.provider);
    materializePiConf(cfg);
    spawn.env = { ...cfg.env, ...spawn.env, PI_CODING_AGENT_DIR: cfg.piConfDir };
    // Everything that can fail — including BEFORE the client exists (mkdir
    // ENOENT etc.) — lives inside this try: pre-client failures must re-enter
    // the recovery funnel, not strand a parked baton (R5 P3-2).
    let client: RpcClient;
    try {
      mkdirSync(botPiConfDir(this.dataRoot, botId), { recursive: true });
      mkdirSync(bot.workDir, { recursive: true });
      client = new RpcClient({
        bin: spawn.bin,
        argvPrefix: spawn.sandboxArgv,
        cwd: bot.workDir,
        env: { ...spawn.env, CODAR_GATE_AUDIT: join(botPiConfDir(this.dataRoot, botId), "gate-audit.jsonl") },
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
      client.on("aborted", () => this.emit("aborted", { botId }));

      const ready = await client.start({
        extensionPath: spawn.extensionPath,
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
      if (m.client !== null) this.dropClient(m, m.client);
      // Recovery runs detached — the caller learns about THIS failure now,
      // not after the whole backoff ladder (R2: ~90s 500s).
      void this.recoverFromFailure(bot, null, String(error)).catch(() => undefined);
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

  /** Drop runtime bookkeeping for a deleted bot (must be stopped first). */
  forget(botId: string): void {
    this.bots.delete(botId);
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

  /** Chat transcript for the UI: the live child's message history. */
  async messages(botId: string): Promise<Array<{ role: string; text: string }>> {
    const m = this.bots.get(botId);
    if (m?.client == null) throw new Error(`bot ${botId} is not running`);
    const res = await m.client.command({ type: "get_messages" } as Record<string, unknown>);
    if (!res.success) throw new Error(`get_messages failed: ${res.error}`);
    const messages = (res.data as { messages?: Array<Record<string, unknown>> } | null)?.messages ?? [];
    return messages.flatMap((msg) => {
      const role = typeof msg["role"] === "string" ? msg["role"] : "unknown";
      const content = msg["content"];
      if (typeof content === "string") return [{ role, text: content }];
      if (Array.isArray(content)) {
        const text = content
          .filter((c): c is { type?: string; text?: string } => typeof c === "object" && c !== null)
          .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : ""))
          .join("");
        return text.length > 0 ? [{ role, text }] : [];
      }
      return [];
    });
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

  private async recoverFromFailure(bot: BotRecord, deadClient: RpcClient | null, reason: string): Promise<void> {
    const m = this.bots.get(bot.id);
    if (m === undefined) return;
    if (m.client === deadClient) m.client = null;
    if (m.stopRequested) {
      if (m.status !== "stopped") this.setStatus(m, "stopped", `stop honored after failure: ${reason}`);
      return;
    }
    if (m.restarting) {
      // Another chain holds the flag. If it is a zombie (older epoch), it
      // will exit without owning THIS failure — park it for the handover.
      m.pendingFailure = reason;
      return;
    }
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
          // internal: does NOT bump the epoch — the chain keeps ownership
          // across its own retry ladder (R3 P1 fix).
          await this.start(bot.id, {}, { internal: true });
          return;
        } catch {
          /* retry loop continues while this chain still owns the lifecycle */
        }
      }
      if (!m.stopRequested && m.epoch === myEpoch && m.client === null && m.status !== "stopped") {
        this.setStatus(m, "stopped", `restart budget exhausted (${reason})`);
      }
    } finally {
      // Unconditional: while this chain held the flag no other chain could
      // enter (atomic check-and-set above), so clearing is always ours.
      m.restarting = false;
      // Handover (R4 P2): a failure that arrived while we (a zombie) held
      // the flag must be re-funneled by someone — that someone is us.
      const pending = m.pendingFailure;
      if (pending !== null && !m.stopRequested && m.client === null && m.epoch === myEpoch) {
        m.pendingFailure = null;
        void this.recoverFromFailure(bot, null, pending).catch(() => undefined);
      } else if (pending !== null && m.epoch !== myEpoch) {
        // We were superseded; the CURRENT generation needs the baton too.
        m.pendingFailure = null;
        void this.recoverFromFailure(bot, null, pending).catch(() => undefined);
      } else {
        m.pendingFailure = null;
      }
    }
  }
}

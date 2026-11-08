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
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { RpcClient, type AgentEvent, type UiRequest } from "../driver/rpc-client.js";
import type { BotRecord } from "./store.js";
import type { Store } from "./store.js";
import type { UsageLedger } from "./usage-ledger.js";
import { botPiConfDir } from "./paths.js";
import { buildSpawnConfig, materializePiConf, loadKeys, type BotSpawnConfig } from "./provider-config.js";
import { ApiError } from "./http-error.js";
import { GATE_EXTENSION_ENTRY,  buildDockerArgv, DEFAULT_SANDBOX_IMAGE } from "./sandbox.js";
import type { RulesManager } from "./rules-manager.js";
import { paths } from "./paths.js";

export type BotStatus = "stopped" | "starting" | "idle" | "working" | "crashed";

export interface BotManagerEvents {
  status: { botId: string; status: BotStatus; detail?: string };
  delta: { botId: string; text: string };
  message: { botId: string; role: string; text: string };
  failure: { botId: string; reason: string };
  aborted: { botId: string };
  /** A tool started executing on a bot (ping-pong guard input, §6.1). */
  tool: { botId: string; toolName: string };
}

export type UsageKind = "chat" | "tool" | "memory-review";

/** Session bloat ceiling: above this, start fresh (pi auto-compaction is
 *  the primary control; this is the belt for sessions that pre-date it or
 *  grew during a single long turn). ~1MB JSONL ≈ 100K+ prompt tokens. */
const SESSION_MAX_BYTES = 1_200_000;

export interface SpawnOptions {
  /** bare mode: the pi binary (tests point this at the fake-pi fixture). */
  bin?: string;
  /** sandbox argv shim (docker run …) — presence selects sandboxed spawn. */
  sandboxArgv?: string[];
  env?: Record<string, string>;
  extensionPath?: string;
  /** rpc idle-watchdog override (tests shrink the 5-minute default). */
  idleTimeoutMs?: number;
  /** docker sandbox image override (§3.4; default codar-bot-sandbox:0.1). */
  sandboxImage?: string;
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
  /** Parked confirm requests awaiting a Web approval card (M2-E §3.5);
   *  host id → { client, child-side request id }. */
  private readonly parkedApprovals = new Map<string, { client: RpcClient; reqId: string }>();

  /** M3.1b: rules manager (late-bound by Host to avoid a ctor cycle). */
  rules: RulesManager | null = null;
  private readonly spawnDefaults: SpawnOptions;

  constructor(
    private readonly store: Store,
    private readonly ledger: UsageLedger,
    private readonly dataRoot: string,
    spawnDefaults: SpawnOptions = {},
    /** keys.json path — re-read on EVERY start so `codar init`-added
     *  providers apply without a host restart (R1 P2-3). */
    private readonly keysPath: string | null = null,
    /** Host dir containing the codar extension tree (docker mount source). */
    private readonly extensionsDir: string = join(dataRoot, "extensions")
  ) {
    super();
    this.spawnDefaults = spawnDefaults;
  }

  /** M2-B: the handoff dispatcher — late-bound by Host after construction
   *  (Handoff's ctor takes this manager; late binding breaks the cycle). */
  handoff: {
    dispatch(req: {
      fromBot: string; toBot: string; task: string; requestId: string; roomId: string | null;
    }): Promise<{ workId: string; duplicate: boolean }>;
  } | null = null;

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
    // `from` rides the event so consumers can distinguish real turn settles
    // (working→idle) from starts/restarts (starting→idle) — maxTurns counts
    // only the former (M2-C R2 P2-1).
    this.emit("status", { botId: m.botId, status, detail, from });
  }

  async start(
    botId: string,
    spawnOverride: SpawnOptions = {},
    opts: { internal?: boolean } = {}
  ): Promise<void> {
    const bot = this.store.bot(botId);
    if (bot === undefined) throw new ApiError(404, `no bot ${botId}`);
    const m = this.managed(botId);
    if (m.client !== null) throw new ApiError(409, `bot ${botId} already running`);
    if (opts.internal !== true) m.epoch += 1; // external start supersedes chains
    m.stopRequested = false;
    m.pendingFailure = null;
    this.setStatus(m, "starting");

    // env merges DEEPLY; the provider chain is spread LAST (highest
    // priority): keys.json is the tracked source of credentials and must not
    // be silently shadowed by spawn env (R2 P3).
    const spawn = {
      ...this.spawnDefaults,
      ...spawnOverride,
      env: { ...this.spawnDefaults.env, ...spawnOverride.env },
    };
    // Everything that can fail — including BEFORE the client exists (keys
    // load, mkdir, models.json writes) — lives inside this try: pre-client
    // failures must re-enter the recovery funnel, not strand a parked baton
    // (R1 P2-1 / R5 P3-2).
    let client: RpcClient;
    try {
      // §3.3 chain (inside the funnel): keys re-read per start; standard
      // providers inject their env var; custom providers get a models.json
      // with $CODAR_BOT_KEY interpolation (secret never on disk).
      const keys = this.keysPath !== null ? loadKeys(this.keysPath) : { providers: {} };
      const cfg: BotSpawnConfig = buildSpawnConfig(keys, this.dataRoot, botId, bot.model.provider, bot.model.modelId);
      materializePiConf(cfg);
      mkdirSync(bot.workDir, { recursive: true });
      let bin = spawn.bin;
      let argvPrefix = spawn.sandboxArgv;
      let childEnv: Record<string, string> = { ...spawn.env, ...cfg.env, PI_CODING_AGENT_DIR: cfg.piConfDir };
      // M3.1b: inject the rules path HERE — before the docker/bare branch.
      // Bare mode: flows into RpcClient opts.env (what spawn reads).
      // Docker mode: the -e spread inside buildDockerArgv reads this key.
      // R3 P1: the injection used to sit inside the docker block (bare bots
      // never reached it) or after the block (the -e read was undefined).
      if (this.rules !== null) {
        try {
          this.rules.refreshBot(botId);
          childEnv.CODAR_GATE_RULES = this.rules.gateRulesPath(botId, bot.sandbox.mode);
        } catch { /* shutting down */ }
      }
      if (bot.sandbox.mode === "docker") {
        // §3.4 sandboxed spawn: env rides explicit -e flags (containers do
        // not inherit spawn env), the entrypoint is pi itself. The shim
        // guards test the PER-CALL override, NOT the merged defaults: a
        // host-level extensionPath default (the repo gate, dogfood D2 P1)
        // is legitimate — docker bots ignore the host path and load the
        // in-container copy below.
        // bin/sandboxArgv test the MERGED values (host defaults like
        // CODAR_PI_BIN must not leak a real container into an offline run);
        // extensionPath tests the PER-CALL override only — the repo-gate
        // host default is legitimate and docker ignores the host path.
        if (spawn.sandboxArgv !== undefined) {
          throw new Error("sandboxArgv is for the bare-process test shim; docker bots configure sandbox.image");
        }
        if (spawn.bin !== undefined) {
          throw new Error("spawn bin is a bare-process shim; docker bots run the sandbox image entrypoint");
        }
        if (spawnOverride.extensionPath !== undefined) {
          throw new Error("spawn extensionPath is a bare-process shim; docker bots load the in-container extension");
        }
        // Loud pre-spawn validation (D2 R2 P1): a missing gate entry inside
        // extensionsDir surfaces as an opaque "rpc child exited early" after
        // the container start — name it BEFORE spawning.
        {
          const entry = join(this.extensionsDir, GATE_EXTENSION_ENTRY);
          if (!existsSync(entry)) {
            throw new Error(
              `docker bot needs the gate extension at ${entry} (mounted at /opt/codar-ext) — set CODAR_EXTENSIONS_DIR to a directory containing codar-gate/codar-gate.ts`
            );
          }
        }
        const extraEnv = { ...this.spawnDefaults.env, ...spawnOverride.env };
        if (Object.keys(extraEnv).length > 0) {
          // Same honesty as the sandboxArgv guard: a silently-swallowed env
          // is a debugging trap. Route extra env through keys.json instead.
          throw new Error("spawn env is not forwarded into docker bots; use keys.json or sandbox.image");
        }
        const image = spawn.sandboxImage ?? process.env.CODAR_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
        bin = "docker";
        argvPrefix = buildDockerArgv({
          image,
          workDir: bot.workDir,
          piConfDir: cfg.piConfDir,
          extensionsDir: this.extensionsDir,
          extensionEntry: GATE_EXTENSION_ENTRY,
          env: {
            ...cfg.env,
            PI_CODING_AGENT_DIR: "/state/pi-conf",
            // The gate audit path MUST cross the boundary — without it the
            // gate falls back to a bot-writable cwd file (S4 §3.4 note).
            CODAR_GATE_AUDIT: "/state/pi-conf/gate-audit.jsonl",
            ...(childEnv.CODAR_GATE_RULES !== undefined
              ? { CODAR_GATE_RULES: childEnv.CODAR_GATE_RULES }
              : {}),
          },
        });
        // The docker CLI process still inherits the host env (RpcClient
        // always merges process.env); it carries no secrets the host lacks.
        // The container sees ONLY the -e list above.
        childEnv = {};
      }
      // M3.1b: bare bots get the rules via RpcClient opts.env (the injection
      // above flows through — bare never clears childEnv); docker bots get
      // it via the -e list inside buildDockerArgv (the -e spread reads the
      // same childEnv key). Both paths converge at the gate.
      client = new RpcClient({
        bin,
        argvPrefix,
        cwd: bot.workDir,
        env: {
          ...childEnv,
          CODAR_GATE_AUDIT:
            bot.sandbox.mode === "docker"
              ? "/state/pi-conf/gate-audit.jsonl"
              : join(botPiConfDir(this.dataRoot, botId), "gate-audit.jsonl"),
        },
        idleTimeoutMs: spawn.idleTimeoutMs ?? 5 * 60_000,
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

      // Auto-compaction (dogfood D3 investigation): pi can compact its own
      // session when the context grows — without it, tool-result
      // accumulation re-feeds ~186K tokens per call and first-token latency
      // grows linearly (94s measured, 4.5s after a manual reset).
      try {
        await client.command({ type: "set_auto_compaction", enabled: true } as Record<string, unknown>);
      } catch {
        /* older pi without the toggle: manual reset-session remains the lever */
      }
      // Session-size guard: a pre-existing session over SESSION_MAX_BYTES
      // starts FRESH instead of dragging its bloat into every call (the
      // memory snapshot preserves durable knowledge — the session is
      // working memory, not the record).
      if (bot.sessionPath !== null) {
        try {
          const { statSync } = await import("node:fs");
          if (statSync(bot.sessionPath).size > SESSION_MAX_BYTES) {
            this.store.updateBot(botId, { sessionPath: null });
            bot.sessionPath = null;
            this.audit("session-auto-reset", { botId, reason: `session ${(statSync(bot.sessionPath ?? "").size / 1e6).toFixed(1)}MB > ${SESSION_MAX_BYTES / 1e6}MB` });
          }
        } catch {
          /* stat race — the switch_session path below reports honestly */
        }
      }
      const ready = await client.start({
        extensionPath:
          bot.sandbox.mode === "docker"
            ? "/opt/codar-ext/codar-gate/codar-gate.ts" // mirrors sandbox.ts extensionEntry
            : spawn.extensionPath,
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
        const childSession = this.toChildSessionPath(bot, bot.sessionPath);
        if (childSession === null) {
          throw new Error(`switch_session unmappable path (stale sessionPath after a data-root or workDir move?): ${bot.sessionPath}`);
        }
        const sw = await client.command(
          { type: "switch_session", sessionPath: childSession } as Record<string, unknown>
        );
        if (!sw.success) {
          throw new Error(`switch_session rejected: ${sw.error ?? "?"} (stale sessionPath?)`);
        }
      }
    } catch (error) {
      if (m.client !== null) this.dropClient(m, m.client);
      // Observability parity with runtime failures (R3 P3-4): the start
      // path reports lastError/failure/audit too (the funnel owns STATUS).
      const reason = String(error);
      m.lastError = reason;
      this.emit("failure", { botId, reason });
      this.audit("start_failed", { botId, reason: reason.slice(0, 200) });
      // Recovery runs detached — the caller learns about THIS failure now,
      // not after the whole backoff ladder (R2: ~90s 500s).
      void this.recoverFromFailure(bot, null, reason).catch(() => undefined);
      throw error;
    }

    m.restarts = 0;
    m.lastError = null;
    this.setStatus(m, "idle");
  }

  private dropClient(m: ManagedBot, client: RpcClient): void {
    if (m.client === client) m.client = null;
    this.purgeApprovalsOf(client);
    client.kill();
  }

  /** dropClient covers stop/start-failure; CRASHES land here — the parked
   *  cards must go stale too or a later Allow would no-op the reply on a
   *  dead child and still claim "allowed ✓" (M2-E R2 P1). */
  private crashDropClient(client: RpcClient): void {
    this.purgeApprovalsOf(client);
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

  /** §3.4 path rule: the store keeps HOST-absolute paths; the child sees
   *  its own mount namespace. Both directions live here so persist and
   *  resume can never drift apart (R2: resume used to ship host paths into
   *  the container — docker resume was 100% broken). */
  private toHostSessionPath(bot: BotRecord, childPath: string): string | null {
    if (bot.sandbox.mode !== "docker") return childPath;
    if (childPath.startsWith("/state/pi-conf/")) {
      return join(botPiConfDir(this.dataRoot, bot.id), childPath.slice("/state/pi-conf/".length));
    }
    if (childPath.startsWith("/home/bot/work/")) {
      return join(bot.workDir, childPath.slice("/home/bot/work/".length));
    }
    // Unknown namespace: NEVER persist a container path into the store
    // (§3.4 hard rule) — refuse and leave the previous value in place.
    this.audit("session_path_unmappable", { botId: bot.id, childPath: childPath.slice(0, 200) });
    return null;
  }

  private toChildSessionPath(bot: BotRecord, hostPath: string): string | null {
    if (bot.sandbox.mode !== "docker") return hostPath;
    const confDir = botPiConfDir(this.dataRoot, bot.id);
    if (hostPath.length > confDir.length && hostPath.startsWith(`${confDir}/`)) {
      return `/state/pi-conf/${hostPath.slice(confDir.length + 1)}`;
    }
    if (hostPath.length > bot.workDir.length && hostPath.startsWith(`${bot.workDir}/`)) {
      return `/home/bot/work/${hostPath.slice(bot.workDir.length + 1)}`;
    }
    // Outside both mounts: the container cannot see this path; resume would
    // be a lie. Refuse loudly (start() throws with the stale-path hint).
    this.audit("session_path_unmappable", { botId: bot.id, hostPath: hostPath.slice(0, 200) });
    return null;
  }

  /** Prompt a bot; resolves with the final assistant text when it settles.
   *  Rejections carry honest reasons (handled/queued disposition, child
   *  death, stop) — never hangs (R1 P1-1: settled/error/exit race). */
  async prompt(botId: string, message: string, kind: UsageKind = "chat", roomId: string | null = null): Promise<string> {
    if (this.store.bot(botId) === undefined) throw new ApiError(404, `no bot ${botId}`);
    const m = this.bots.get(botId);
    if (m === undefined || m.client === null) throw new ApiError(409, `bot ${botId} is not running`);
    if (m.status === "working") throw new ApiError(409, `bot ${botId} is already working on a prompt`);
    if (m.status !== "idle") throw new ApiError(409, `bot ${botId} is ${m.status} (wait for idle)`);
    const client = m.client;
    const bot = this.store.bot(botId)!;
    this.setStatus(m, "working");
    (client as unknown as { __usageKind?: UsageKind }).__usageKind = kind;
    // Room attribution (dogfood D3): the ROOM budget meters spend that
    // happened IN the room — not the member's global month total.
    (client as unknown as { __usageRoom?: string | null }).__usageRoom = roomId;

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

    // Persist the session path the child now reports (crash-safe resume).
    try {
      const state = await client.command({ type: "get_state" } as Record<string, unknown>);
      const rawSession =
        state.success ? ((state.data as { sessionFile?: unknown } | null)?.sessionFile) : undefined;
      if (typeof rawSession === "string" && rawSession !== "") {
        const sessionFile = this.toHostSessionPath(bot, rawSession);
        if (sessionFile !== null && sessionFile !== bot.sessionPath) {
          this.store.updateBot(botId, { sessionPath: sessionFile });
        }
      }
    } catch {
      /* best-effort persistence; next successful prompt retries */
    }
    let text: string | null = null;
    try {
      // Harvest FIRST, flip idle LAST (M2-B R1 P1-1): no concurrent prompt
      // can start a turn in this window and overwrite the lastText we read.
      // null = the harvest did NOT succeed (command failed or bad shape) —
      // distinct from a genuinely empty "" reply, so the idle flip below can
      // report "harvest failure" honestly (M2-C R3 P3: the check was dead).
      const last = await client.command({ type: "get_last_assistant_text" } as Record<string, unknown>);
      if (last.success && typeof (last.data as { text?: unknown } | null)?.text === "string") {
        text = (last.data as { text: string }).text;
      }
    } finally {
      // The harvest await can reject on a LIVE child (command timeout / stdin
      // failure) — without this guard the bot stays "working" forever and the
      // idle-driven pending-work retry starves (M2-B R2 P1-a). The client
      // guard keeps stop/crash paths from resurrecting an idle status. The
      // detail is only honest on the failure path (R3 P3: success flips
      // plain, not "harvest failure").
      if (m.client === client && (m.status as BotStatus) === "working") {
        const failedHarvest = text === null;
        this.setStatus(m, "idle", failedHarvest ? "harvest failure" : undefined);
      }
    }
    return text ?? "";
  }

  /** Start over with a FRESH pi session (dogfood D3): stop the bot, drop
   *  sessionPath. The room watermarks stay at the tail (no backlog
   *  re-injection), and the frozen memory snapshot is still injected every
   *  turn — durable knowledge survives, the accumulated tool-result bloat
   *  does not. A dispatcher session that grew to 165K input tokens took
   *  2+ minutes to first token. */
  async resetSession(botId: string): Promise<void> {
    const bot = this.store.bot(botId);
    if (bot === undefined) throw new ApiError(404, `no bot ${botId}`);
    await this.stop(botId);
    this.store.updateBot(botId, { sessionPath: null });
    this.forget(botId);
  }

  /** Chat transcript for the UI: the live child's message history. */
  async messages(botId: string): Promise<Array<{ role: string; text: string }>> {
    if (this.store.bot(botId) === undefined) throw new ApiError(404, `no bot ${botId}`);
    const m = this.bots.get(botId);
    if (m?.client == null) throw new ApiError(409, `bot ${botId} is not running`);
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
    if (this.store.bot(botId) === undefined) throw new ApiError(404, `no bot ${botId}`);
    const m = this.bots.get(botId);
    if (m?.client == null) throw new ApiError(409, `bot ${botId} is not running`);
    await m.client.abort();
  }

  private handleUi(client: RpcClient, req: UiRequest): void {
    // M2-B: message_bot dispatches ride the ui bridge as input dialogs with
    // the codar: prefix (the D1 channel S2 proved).
    if (req.method === "input" && req.title === "codar:message_bot") {
      const botId = this.botIdOf(client);
      void this.dispatchMessageBot(client, req, botId);
      return;
    }
    // M2-E approval bridge (§5.4 M1/M2 档): a confirm request parks and is
    // surfaced as an SSE approval event; the Web card resolves it via
    // resolveApproval(). CODAR_M1_AUTOAPPROVE=1 (tests/spikes only) still
    // short-circuits. Never silently deny — a parked call is honest, a
    // silent deny loses work.
    if (req.method === "confirm") {
      if (process.env.CODAR_M1_AUTOAPPROVE === "1") {
        client.replyUi({ type: "extension_ui_response", id: req.id, confirmed: true });
        return;
      }
      // HOST-generated approval id (M2-E R1 P1-3): the child-supplied req.id
      // has no uniqueness guarantee across children (fake-pi emits park-1
      // from every process — a real collision orphaned the earlier park).
      // The host id keys the map; the child id rides along for the reply.
      const botId = this.botIdOf(client);
      const approvalId = `apr_${randomUUID().slice(0, 8)}`;
      this.parkedApprovals.set(approvalId, { client, reqId: req.id });
      this.emit("approval", {
        id: approvalId,
        botId,
        title: req.title,
        message: (req as { message?: unknown }).message ?? "",
      });
    }
  }

  /** Resolve a parked approval from the Web approval card (§3.5 M2 简版). */
  resolveApproval(id: string, confirmed: boolean | { decision: "allow_once" | "deny" | "allow_rule"; ruleSpec?: unknown }): boolean {
    const parked = this.parkedApprovals.get(id);
    if (parked === undefined) return false;
    // Liveness belt: if the parking client is no longer ANY bot's live
    // client (crashed and purged late, superseded), the reply can never
    // land — resolve STALE instead of lying "allowed" (M2-E R2 P1).
    const stillLive = [...this.bots.values()].some((m) => m.client === parked.client);
    this.parkedApprovals.delete(id);
    if (!stillLive) {
      this.emit("approvalResolved", { id, confirmed: false, stale: true });
      return false;
    }
    // M3.1c: structured decision from the keyboard shortcuts — allow_rule
    // creates a global rule then confirms (the gate's mtime hot reload
    // makes it live on the next tool_call).
    if (typeof confirmed === "object" && confirmed !== null) {
      if (confirmed.decision === "allow_rule" && this.rules !== null && confirmed.ruleSpec !== undefined) {
        try {
          this.rules.createShortcutRule("global", null, confirmed.ruleSpec as never);
          this.audit("rule_created", { approvalId: id, ruleSpec: JSON.stringify(confirmed.ruleSpec).slice(0, 200) });
        } catch { /* rule creation failure must not block the approval */ }
      }
      const isAllowed = confirmed.decision !== "deny";
      parked.client.replyUi({ type: "extension_ui_response", id: parked.reqId, confirmed: isAllowed });
      // M3.1c P2-2: the approval OUTCOME lands in host audit — the
      // resolvedAs five-value enum is the audit page's approval dimension.
      const approvalBot = this.botIdOf(parked.client);
      // M3 P3: audit the rule that was actually CREATED, not the client's
      // spec (the spec is Omit<...,"id"> — its id field is always stripped).
      let createdRuleId = "";
      if (confirmed.decision === "allow_rule" && this.rules !== null && typeof confirmed.ruleSpec === "object" && confirmed.ruleSpec !== null) {
        // createShortcutRule runs inside resolveApproval; the audit captures
        // the spec so the created rule is traceable even if creation fails.
        createdRuleId = JSON.stringify(confirmed.ruleSpec).slice(0, 120);
      }
      this.audit("approval", {
        approvalId: id,
        botId: approvalBot,
        resolvedAs: confirmed.decision,
        ...(createdRuleId !== "" ? { ruleSpec: createdRuleId } : {}),
      });
      this.emit("approvalResolved", { id, confirmed: isAllowed, resolvedAs: confirmed.decision });
      return true;
    }
    parked.client.replyUi({ type: "extension_ui_response", id: parked.reqId, confirmed });
    this.audit("approval", {
      approvalId: id,
      botId: this.botIdOf(parked.client),
      resolvedAs: confirmed ? "allow_once" : "deny",
    });
    this.emit("approvalResolved", { id, confirmed });
    return true;
  }

  /** Drop every approval parked on a dying client — the card must not sit
   *  clickable forever promising a resolve that can never land (R1 P1-3). */
  private purgeApprovalsOf(client: RpcClient): void {
    for (const [id, parked] of [...this.parkedApprovals]) {
      if (parked.client !== client) continue;
      this.parkedApprovals.delete(id);
      this.emit("approvalResolved", { id, confirmed: false, stale: true });
    }
  }

  private botIdOf(client: RpcClient): string | null {
    for (const [botId, m] of this.bots) {
      if (m.client === client) return botId;
    }
    return null;
  }

  private async dispatchMessageBot(client: RpcClient, req: UiRequest, botId: string | null): Promise<void> {
    const reply = (status: "ok" | "error", extra: Record<string, string>): void => {
      client.replyUi({
        type: "extension_ui_response",
        id: req.id,
        value: JSON.stringify({ status, ...extra }),
      });
    };
    if (this.handoff === null || botId === null) {
      reply("error", { error: "host dispatch unavailable" });
      return;
    }
    let parsed: { to?: string; task?: string; request_id?: string; call_id?: string };
    try {
      parsed = JSON.parse(req.placeholder ?? "{}") as typeof parsed;
    } catch {
      reply("error", { error: "malformed message_bot payload" });
      return;
    }
    if (typeof parsed.to !== "string" || typeof parsed.task !== "string") {
      reply("error", { error: "to/task must be strings" });
      return;
    }
    const task = parsed.task.trim();
    if (task.length === 0 || task.length > 4096) {
      reply("error", { error: "task must be 1..4096 bytes" });
      return;
    }
    // The model addresses bots by NAME; the work tree keys on id.
    const toName = parsed.to ?? "";
    const target =
      this.store.state.bots.find((b) => b.name.toLowerCase() === toName.toLowerCase())?.id ?? toName;
    // Idempotency (M2-B R1 P1-3): explicit request_id wins (namespaced by
    // the SENDER so two bots can't claim each other's key); the default key
    // is the tool CALL id — a retried call = same work, two legitimate
    // identical tasks (different calls) = different works.
    const requestId =
      typeof parsed.request_id === "string" && parsed.request_id.trim() !== ""
        ? `req:${botId}:${parsed.request_id.trim()}`
        : typeof parsed.call_id === "string" && parsed.call_id !== ""
          // Sender-namespaced: deterministic call ids (sequential providers)
          // must not collide across bots (M2-B R2 P3).
          ? `call:${botId}:${parsed.call_id}`
          : `rand:${randomUUID()}`;
    try {
      const { workId } = await this.handoff.dispatch({
        fromBot: botId,
        toBot: target,
        task,
        requestId,
        roomId: this.roomOf(botId),
      });
      reply("ok", { workId });
    } catch (error) {
      reply("error", { error: String(error).slice(0, 200) });
    }
  }

  /** The (single) room a bot belongs to — M2 bots join one room; the handoff
   *  result line lands there. */
  private roomOf(botId: string): string | null {
    const room = this.store.state.rooms.find((r) => r.members.includes(botId));
    return room?.id ?? null;
  }

  private onEvent(bot: BotRecord, client: RpcClient, e: AgentEvent): void {
    if (e.type === "tool_execution_start") {
      const toolName = String((e as { toolName?: unknown }).toolName ?? "?");
      // Args preview (dogfood D3): "⚙ bash" alone tells the user nothing
      // about WHAT is running — surface the command/path gist so a
      // minute-long agent loop reads as progress instead of a hang.
      const rawArgs = (e as { args?: unknown }).args;
      let argsPreview = "";
      if (typeof rawArgs === "string") {
        argsPreview = rawArgs;
      } else if (rawArgs !== null && typeof rawArgs === "object") {
        const a = rawArgs as Record<string, unknown>;
        argsPreview = String(a.command ?? a.cmd ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.input ?? "");
      }
      argsPreview = argsPreview.replace(/\s+/g, " ").trim().slice(0, 80);
      this.emit("tool", { botId: bot.id, toolName, argsPreview });
      return;
    }
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
        const roomId = (client as unknown as { __usageRoom?: string | null }).__usageRoom ?? null;
        const u = message.usage;
        this.ledger.record({
          hour: hourNow(),
          botId: bot.id,
          model: `${bot.model.provider}/${bot.model.modelId}`,
          kind,
          roomId,
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
    this.crashDropClient(client); // also purges this client's parked approvals (R2 P1)
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
      } else if (pending !== null && m.epoch !== myEpoch && m.client === null) {
        // We were superseded; the CURRENT generation needs the baton too —
        // but only when nobody is live (a live client means the parked
        // failure refers to OUR dead generation; re-funneling would burn
        // the restart budget against "already running" (R3 P3-5)).
        m.pendingFailure = null;
        void this.recoverFromFailure(bot, null, pending).catch(() => undefined);
      } else {
        m.pendingFailure = null;
      }
    }
  }
}

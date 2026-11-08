/**
 * Host assembly — store + ledger + bot-manager + HTTP API (architecture §3).
 * `codar start` boots this; PID/port land in host.json for CLI discovery.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { UsageLedger } from "./usage-ledger.js";
import { BotManager } from "./bot-manager.js";
import { RoomEngine } from "./room-engine.js";
import { Handoff } from "./handoff.js";
import { Budget } from "./budget.js";
import { MemoryEngine } from "./memory.js";
import { RulesManager } from "./rules-manager.js";
import { AuditQuery } from "./audit-query.js";
import { HttpApi } from "./http-api.js";
import { paths, type HostPaths } from "./paths.js";
import { loadKeys } from "./provider-config.js";

export interface HostOptions {
  dataRoot?: string;
  /** bare-process spawn (tests: fake-pi; dev: real pi). */
  bin?: string;
  /** argv between bin and the rpc flags (tests: the fake-pi fixture path). */
  argv?: string[];
  extensionPath?: string;
  env?: Record<string, string>;
  /** Host dir containing the extension tree (docker mount source, §3.4). */
  extensionsDir?: string;
  /** Built web UI dir; default ~/.codar-bot/web-dist when present. */
  webDir?: string;
}

export class Host {
  readonly p: HostPaths;
  readonly store: Store;
  readonly ledger: UsageLedger;
  readonly bots: BotManager;
  readonly api: HttpApi;
  private port: number | null = null;
  private running = false;

  private constructor(
    opts: HostOptions,
    store: Store,
    ledger: UsageLedger,
    bots: BotManager,
    api: HttpApi
  ) {
    this.p = paths(opts.dataRoot);
    this.store = store;
    this.ledger = ledger;
    this.bots = bots;
    this.api = api;
  }

  static boot(opts: HostOptions = {}): Host {
    const p = paths(opts.dataRoot);
    if (p.root.includes(":")) {
      throw new Error("data root must not contain ':' (breaks docker -v mounts)");
    }
    for (const dir of [p.root, p.piConfRoot, p.memoryRoot, p.logs]) {
      mkdirSync(dir, { recursive: true });
    }
    // M3.4a: ensure the gate extension exists in dataRoot.
    {
      const dataExtDir = join(p.root, "extensions", "codar-gate");
      const gateFile = join(dataExtDir, "codar-gate.ts");
      if (!existsSync(gateFile)) {
        const thisDir = dirname(fileURLToPath(import.meta.url));
        const candidates = [
          resolve(thisDir, "..", "..", "extensions", "codar-gate"),
          resolve(thisDir, "..", "..", "..", "extensions", "codar-gate"),
        ];
        for (const src of candidates) {
          try {
            mkdirSync(dataExtDir, { recursive: true });
            for (const f of ["codar-gate.ts", "rules.ts", "audit.ts"]) {
              writeFileSync(join(dataExtDir, f), readFileSync(join(src, f)));
            }
            break;
          } catch { /* try next */ }
        }
      }
    }
    const store = Store.openExclusive(p.state, { create: true });
    const ledger = new UsageLedger(p.ledger);
    loadKeys(p.keys); // fail fast on malformed keys.json at boot
    const bots = new BotManager(store, ledger, p.root, {
      bin: opts.bin,
      sandboxArgv: opts.argv,
      extensionPath: opts.extensionPath,
      env: opts.env,
    }, p.keys, opts.extensionsDir);
    // Legacy ghost sweep (dogfood-D1 R2 P3): rooms persisted before the
    // DELETE sweep may reference deleted bots — drop those ids, promote an
    // orphaned admin, drop rooms left empty. Heals dogfood-era state at
    // every boot; a no-op on clean stores.
    for (const room of [...store.state.rooms]) {
      const members = room.members.filter((m) => store.bot(m) !== undefined);
      if (members.length === room.members.length) continue;
      if (members.length === 0) {
        store.removeRoom(room.id);
        continue;
      }
      store.updateRoom(room.id, {
        members,
        admin: store.bot(room.admin) === undefined ? members[0]! : room.admin,
      });
    }
    const rooms = new RoomEngine(store, bots, p.roomsRoot);
    const handoff = new Handoff(store, bots, rooms);
    bots.handoff = handoff; // late bind (M2-B D1 bridge)
    const rules = new RulesManager(p.root, store);
    const auditQuery = new AuditQuery(p.root);
    bots.rules = rules; // late bind (M3.1b rules injection)
    const budget = new Budget(store, ledger, bots, rooms, p.root);
    const memory = new MemoryEngine(store, ledger, p.root, {
      bin: opts.bin, sandboxArgv: opts.argv, env: opts.env ?? {},
    });
    rooms.deadlineMs = (botId: string) => budget.wallDeadlineMs(botId); // §6.1a
    handoff.deadlineMs = (botId: string) => budget.wallDeadlineMs(botId); // §6.1a
    handoff.stalePauseCheck = (roomId) => budget.rolloverIfStale(roomId); // §5.3 entry-point rollover test
    // Memory wiring (§3 memory module, §5.1a tail injection): every REAL
    // settle feeds the bot/room/team scopes; reviews run single-flight per
    // scope (team batches at TEAM_REVIEW_THRESHOLD); the frozen snapshot
    // rides the prompt tail.
    const memoryTurn = (speakerRoomId: string | null, botId: string, text: string): void => {
      const botName = store.bot(botId)?.name ?? botId;
      const roomName = speakerRoomId !== null ? (store.room(speakerRoomId)?.name ?? speakerRoomId) : null;
      const turn = { ts: new Date().toISOString(), speaker: botName, text: text.slice(0, 4_000) };
      memory.ingestTurn("bot", botId, turn);
      if (speakerRoomId !== null) memory.ingestTurn("room", speakerRoomId, turn);
      memory.ingestTurn("team", "team", { ...turn, speaker: roomName !== null ? `${roomName}/${botName}` : botName });
      memory.schedule("bot", botId);
      if (speakerRoomId !== null) memory.schedule("room", speakerRoomId);
      memory.schedule("team", "team");
    };
    rooms.onTurnSettled = (roomId, botId, reply) => memoryTurn(roomId, botId, reply);
    rooms.memoryTail = (botId, roomId) => {
      const parts = [
        memory.snapshot("bot", botId),
        memory.snapshot("room", roomId),
        memory.snapshot("team", "team"),
      ].filter((t) => t.length > 0);
      return parts.length > 0 ? parts.join("\n\n") : null;
    };
    handoff.onWorkDone = (work, result) => {
      const taskText = handoff.work(work.id)?.task ?? "";
      memoryTurn(work.roomId, work.child, `task: ${taskText.slice(0, 500)}\nresult: ${result.slice(0, 1_000)}`);
    };
    handoff.memoryTail = (botId) => memory.snapshot("bot", botId) || null;
    const api = new HttpApi({
      store, bots, ledger, rooms, handoff, budget, memory, auditQuery,
      webDir: opts.webDir ?? (existsSync(join(p.root, "web-dist")) ? join(p.root, "web-dist") : undefined),
    });
    return new Host(opts, store, ledger, bots, api);
  }

  get httpPort(): number | null {
    return this.port;
  }

  async start(): Promise<number> {
    if (this.running) throw new Error("host already running");
    this.running = true;
    const envPort = Number(process.env.CODAR_BOT_PORT);
    this.port = await this.api.listen(Number.isInteger(envPort) && envPort >= 0 ? envPort : 7600);
    writeFileSync(this.p.hostRuntime, JSON.stringify(
      { pid: process.pid, port: this.port, startedAt: new Date().toISOString() }, null, 2));
    return this.port;
  }

  async shutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.bots.stopAll();
    await this.api.close();
    this.ledger.close();
    this.store.close();
    if (existsSync(this.p.hostRuntime)) rmSync(this.p.hostRuntime);
  }
}

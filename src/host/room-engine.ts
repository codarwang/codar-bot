/**
 * room-engine — group orchestration over the pure turn-engine (§3, §5.1/5.1a).
 *
 * Owns, per room:
 *  - messages.jsonl (sole writer, §3) — append-only {seq, ts, from, text}
 *  - incremental per-bot injection watermarks (§5.1a: only OTHER members'
 *    messages are injected; own history lives in the bot's pi session)
 *  - the responder loop: pick → render context → BotManager.prompt → append
 *  - guards: first-token reply timeout (§6.1) and the ping-pong pause
 *    (PRD 3.3-1) with the §5.3 resume policy (user message lifts a ping-pong
 *    pause; a budget pause stays until explicitly resumed)
 *
 * Runtime state is in-memory; messages.jsonl is the durable log (seq resumes
 * from the file tail on boot; watermarks start at tail — restart notes in
 * the header of injectContextFor).
 */

import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store, RoomRecord } from "./store.js";
import type { BotManager } from "./bot-manager.js";
import {
  afterBotTurn,
  nextRRPointer,
  onUserTurn,
  parseMentions,
  pickResponder,
  slotsSnapshot,
  type PingPongState,
  type SlotState,
} from "./turn-engine.js";

export interface RoomMessage {
  seq: number;
  ts: string;
  room: string;
  from: { kind: "user" | "bot" | "system"; id?: string };
  text: string;
  meta?: Record<string, unknown>;
}

export interface RoomRuntime {
  lastSeq: number;
  rrPointer: number;
  pingPong: PingPongState;
  /** botId → highest seq already injected into that bot's session. */
  watermark: Map<string, number>;
  slots: Record<string, SlotState>;
  pausedReason: "ping-pong" | "budget" | "manual" | null;
  /** botId → tool calls observed in the CURRENT turn (ping-pong input). */
  turnTools: Map<string, number>;
}

function messagesPath(roomsRoot: string, roomId: string): string {
  return join(roomsRoot, roomId, "messages.jsonl");
}

export class RoomEngine extends EventEmitter {
  private readonly runtimes = new Map<string, RoomRuntime>();

  constructor(
    private readonly store: Store,
    private readonly bots: BotManager,
    private readonly roomsRoot: string
  ) {
    super();
    mkdirSync(roomsRoot, { recursive: true });
    // Tool-call signal for the ping-pong guard (§6.1): any tool execution
    // during a bot's turn makes the turn "real work".
    bots.on("tool", (e: { botId: string; toolName: string }) => {
      for (const rt of this.runtimes.values()) {
        const n = rt.turnTools.get(e.botId);
        if (n !== undefined) rt.turnTools.set(e.botId, n + 1);
      }
    });
  }

  // --- public API -------------------------------------------------------------

  /** Runtime slot snapshot for the UI turn bar / context panel. */
  slots(roomId: string): Record<string, SlotState> {
    const room = this.store.room(roomId);
    const rt = this.runtimes.get(roomId);
    if (room === undefined) return {};
    return slotsSnapshot(room.members, rt?.slots ?? {});
  }

  pausedReason(roomId: string): RoomRuntime["pausedReason"] {
    return this.runtimes.get(roomId)?.pausedReason ?? null;
  }

  /** Durable history for the UI (since = exclusive lower seq bound). */
  history(roomId: string, since = 0): RoomMessage[] {
    return this.readAll(roomId).filter((m) => m.seq > since);
  }

  /**
   * A human message entered the room. Appends, lifts a ping-pong pause,
   * picks responder(s) per policy, and drives the turn to completion.
   * Resolves when every responder has settled (or been timed out).
   */
  async userSay(roomId: string, text: string): Promise<{ responders: string[] }> {
    const room = this.store.room(roomId);
    if (room === undefined) throw new Error(`no room ${roomId}`);
    const rt = this.runtime(roomId, room);

    if (rt.pausedReason === "budget") {
      throw new Error(`room ${roomId} is budget-paused (§5.3) — adjust the budget to resume`);
    }
    if (rt.pausedReason !== null) {
      // ping-pong / manual pause: a user message is the awaited signal.
      rt.pausedReason = null;
      this.store.updateRoom(roomId, { status: "active" });
      this.systemLine(roomId, rt, "pause lifted by user message");
    }

    rt.pingPong = onUserTurn();
    this.append(roomId, rt, { kind: "user" }, text);

    const members = room.members.map((id) => ({
      id,
      name: this.store.bot(id)?.name ?? id,
    }));
    const mentions = parseMentions(text, members);
    const decision = pickResponder(
      { admin: room.admin, mode: room.mode, members: room.members },
      mentions,
      rt.rrPointer,
      rt.pausedReason !== null
    );

    for (const botId of decision.responders) {
      if (this.store.bot(botId) === undefined) continue;
      await this.runTurn(roomId, room, rt, botId);
    }
    if (room.mode === "round-robin" && decision.responders.length > 0) {
      rt.rrPointer = nextRRPointer(
        { admin: room.admin, mode: room.mode, members: room.members },
        rt.rrPointer
      );
    }
    return { responders: decision.responders };
  }

  /** Explicit pause/resume (budget stop lands here with reason "budget"). */
  pause(roomId: string, reason: RoomRuntime["pausedReason"], note: string): void {
    const room = this.store.room(roomId);
    if (room === undefined) throw new Error(`no room ${roomId}`);
    const rt = this.runtime(roomId, room);
    rt.pausedReason = reason;
    this.store.updateRoom(roomId, { status: "paused" });
    this.systemLine(roomId, rt, note);
  }

  resume(roomId: string, note: string): void {
    const room = this.store.room(roomId);
    if (room === undefined) throw new Error(`no room ${roomId}`);
    const rt = this.runtime(roomId, room);
    rt.pausedReason = null;
    this.store.updateRoom(roomId, { status: "active" });
    this.systemLine(roomId, rt, note);
  }

  // --- turn loop ----------------------------------------------------------------

  private async runTurn(
    roomId: string,
    room: RoomRecord,
    rt: RoomRuntime,
    botId: string
  ): Promise<void> {
    const guards = room.guards;
    rt.turnTools.set(botId, 0);
    rt.slots[botId] = "speaking";
    this.emitTurn(roomId, room);

    const context = this.renderContext(room, rt, botId);

    // First-token watchdog (§6.1): no delta within replyTimeoutMs ⇒ interrupt
    // and mark the slot timed-out. Deltas arrive via BotManager events.
    let sawFirstToken = false;
    const onDelta = (e: { botId: string; text: string }): void => {
      if (e.botId === botId) sawFirstToken = true;
    };
    this.bots.on("delta", onDelta);
    const watchdog = setTimeout(() => {
      if (!sawFirstToken) {
        rt.slots[botId] = "timed-out";
        this.emitTurn(roomId, room);
        void this.bots.interrupt(botId).catch(() => undefined);
      }
    }, guards.replyTimeoutMs);

    let reply: string;
    try {
      reply = await this.bots.prompt(botId, context, "chat");
      rt.slots[botId] = sawFirstToken ? "posted" : "failed";
    } catch (error) {
      // The watchdog may have flipped the slot to timed-out before the
      // interrupt landed; keep that verdict, otherwise the turn failed.
      const slotNow = rt.slots[botId] as SlotState | undefined;
      rt.slots[botId] = slotNow === "timed-out" ? "timed-out" : "failed";
      this.systemLine(roomId, rt, `${this.botName(botId)} turn failed: ${String(error).slice(0, 160)}`);
      this.emitTurn(roomId, room);
      clearTimeout(watchdog);
      this.bots.off("delta", onDelta);
      rt.turnTools.delete(botId);
      return;
    }
    clearTimeout(watchdog);
    this.bots.off("delta", onDelta);

    if (reply.trim().length > 0) {
      this.append(roomId, rt, { kind: "bot", id: botId }, reply);
    }

    // Ping-pong evaluation on turn completion.
    const toolCalls = rt.turnTools.get(botId) ?? 0;
    rt.turnTools.delete(botId);
    const verdict = afterBotTurn(guards, rt.pingPong, toolCalls);
    rt.pingPong = verdict.state;
    if (verdict.pauseNow) {
      rt.pausedReason = "ping-pong";
      this.store.updateRoom(roomId, { status: "paused" });
      this.systemLine(
        roomId,
        rt,
        `paused — ${verdict.state.consecutivePure} idle replies in a row (guard N=${guards.pingPongN}), waiting for you`
      );
    }
    this.emitTurn(roomId, room);
  }

  // --- context rendering (§5.1a) -------------------------------------------------

  /**
   * Render the prompt for one bot's turn: system header + only the messages
   * it has NOT yet been injected (others' messages; own history lives in its
   * pi session). The watermark then advances to the room tail.
   */
  private renderContext(room: RoomRecord, rt: RoomRuntime, botId: string): string {
    const members = room.members
      .map((id) => this.store.bot(id)?.name ?? id)
      .join(", ");
    const header = [
      `You are ${this.botName(botId)} in team room "${room.name}". Members: ${members}.`,
      `Currently working: ${this.workingLine(room, rt)}`,
      `Shared files live in ~/shared (prefix your writes with your name).`,
    ].join("\n");

    // Watermark fallback 0: a member with no watermark (joined after runtime
    // creation) sees the full backlog on its first turn.
    const since = rt.watermark.get(botId) ?? 0;
    const pending = this.readAll(room.id).filter(
      (m) => m.seq > since && !(m.from.kind === "bot" && m.from.id === botId)
    );
    const dialogue = pending.map((m) => this.formatForInjection(m)).join("\n");
    rt.watermark.set(botId, rt.lastSeq);
    return dialogue.length > 0 ? `${header}\n\n${dialogue}` : header;
  }

  private workingLine(room: RoomRecord, rt: RoomRuntime): string {
    const working = room.members.filter((m) => rt.slots[m] === "working" || rt.slots[m] === "speaking");
    return working.length > 0
      ? working.map((m) => this.botName(m)).join(", ")
      : "nobody";
  }

  private formatForInjection(m: RoomMessage): string {
    if (m.from.kind === "user") return `[user] ${m.text}`;
    if (m.from.kind === "system") return `[system] ${m.text}`;
    return `[${this.botName(m.from.id ?? "")}] ${m.text}`;
  }

  // --- messages.jsonl (sole writer §3) --------------------------------------------

  private append(
    roomId: string,
    rt: RoomRuntime,
    from: RoomMessage["from"],
    text: string,
    meta?: Record<string, unknown>
  ): RoomMessage {
    const msg: RoomMessage = {
      seq: ++rt.lastSeq,
      ts: new Date().toISOString(),
      room: roomId,
      from,
      text,
      ...(meta !== undefined ? { meta } : {}),
    };
    mkdirSync(join(this.roomsRoot, roomId), { recursive: true });
    appendFileSync(messagesPath(this.roomsRoot, roomId), `${JSON.stringify(msg)}\n`, "utf8");
    this.emit("message", msg);
    return msg;
  }

  private systemLine(roomId: string, rt: RoomRuntime, text: string): void {
    this.append(roomId, rt, { kind: "system" }, text);
    this.emit("system", { roomId, text });
  }

  private emitTurn(roomId: string, room: RoomRecord): void {
    this.emit("turn", {
      roomId,
      slots: slotsSnapshot(room.members, this.runtimes.get(roomId)?.slots ?? {}),
      pausedReason: this.runtimes.get(roomId)?.pausedReason ?? null,
    });
  }

  private readAll(roomId: string): RoomMessage[] {
    const p = messagesPath(this.roomsRoot, roomId);
    if (!existsSync(p)) return [];
    const out: RoomMessage[] = [];
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        out.push(JSON.parse(line) as RoomMessage);
      } catch {
        /* torn tail line — skip (append-only log) */
      }
    }
    return out;
  }

  private runtime(roomId: string, room: RoomRecord): RoomRuntime {
    let rt = this.runtimes.get(roomId);
    if (rt !== undefined) return rt;
    const tail = this.readAll(roomId);
    const lastSeq = tail.length > 0 ? (tail[tail.length - 1]!.seq as number) : 0;
    // Restart semantics: every CURRENT member's pi session already contains
    // everything injected before the host restart, so their watermarks start
    // at the disk tail (no re-injection/duplication). Members joining later
    // (or a fresh room) fall back to 0 in renderContext — full backlog.
    const watermark = new Map<string, number>(room.members.map((m) => [m, lastSeq]));
    rt = {
      lastSeq,
      rrPointer: 0,
      pingPong: { consecutivePure: 0 },
      watermark,
      slots: {},
      pausedReason: null,
      turnTools: new Map(),
    };
    this.runtimes.set(roomId, rt);
    return rt;
  }

  private botName(botId: string): string {
    return this.store.bot(botId)?.name ?? botId;
  }
}

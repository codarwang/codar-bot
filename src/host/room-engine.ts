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
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
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
  /** Per-room FIFO turn batches (R1 P1-1: concurrent userSays serialize). */
  private readonly queues = new Map<string, Promise<unknown>>();

  /** Per-task wall-clock provider (Budget.wallDeadlineMs); null = uncapped. */
  deadlineMs: ((botId: string) => number | null) | null = null;

  /** Real-turn-settled hook (memory ingest, §5.1a); set by Host. Fires ONLY
   *  for completed turns with a recorded reply — not timeouts/errors. */
  onTurnSettled: ((roomId: string, botId: string, reply: string) => void) | null = null;

  /** Frozen memory snapshot for the speaking bot's prompt tail (§5.1a 注入于
   *  系统段尾部); set by Host. Null/"" = no memory yet, nothing injected. */
  memoryTail: ((botId: string, roomId: string) => string | null) | null = null;

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
    const rt = this.runtimes.get(roomId);
    if (rt !== undefined) return rt.pausedReason;
    // Cold runtime (post-restart, no turn yet): the persisted store is the
    // truth — a budget-paused room must 409 on the FIRST post, not after
    // the queue builds a runtime (R2 P2-3).
    const room = this.store.room(roomId);
    if (room === undefined) return null;
    return room.status === "paused" ? (room.pauseReason ?? "budget") : null;
  }

  /** Durable history for the UI (since = exclusive lower seq bound). */
  history(roomId: string, since = 0): RoomMessage[] {
    return this.readAll(roomId).filter((m) => m.seq > since);
  }

  /**
   * A human message entered the room. Serializes per room (concurrent HTTP
   * POSTs queue instead of stomping watermarks/slots — review R1 P1-1),
   * appends, lifts a liftable pause, picks responder(s), drives the turn(s).
   */
  async userSay(roomId: string, text: string): Promise<{ responders: string[]; selected?: string[] }> {
    // ACCEPT PHASE (synchronous, outside the FIFO): budget-pause rejects,
    // liftable pauses lift, the user line lands in the log NOW. A message
    // accepted while another turn batch runs used to sit INVISIBLE inside
    // the queue for the whole batch — the user saw the composer clear and
    // nothing else (dogfood QA ISSUE-001). Only the TURN part queues.
    const room = this.store.room(roomId);
    if (room === undefined) throw new Error(`no room ${roomId}`);
    const rt = this.runtime(roomId, room);
    if (rt.pausedReason === "budget") {
      throw new Error(`room ${roomId} is budget-paused (§5.3) — adjust the budget to resume`);
    }
    if (rt.pausedReason !== null) {
      rt.pausedReason = null;
      this.store.updateRoom(roomId, { status: "active", pauseReason: null, pausedAt: null });
      this.systemLine(roomId, rt, "pause lifted by user message");
    }
    rt.pingPong = onUserTurn();
    this.append(roomId, rt, { kind: "user" }, text);
    // Mention honesty ALSO at accept time — the second parse against all
    // bots does not depend on the queued turn (moved from userSayInner).
    {
      const members = room.members.map((id) => ({ id, name: this.store.bot(id)?.name ?? id }));
      const mentions = parseMentions(text, members);
      const allBots = this.store.state.bots.map((b) => ({ id: b.id, name: b.name }));
      const anyMentions = parseMentions(text, allBots);
      const nonMembers = anyMentions.botIds.filter((id) => !room.members.includes(id));
      if (nonMembers.length > 0) {
        const names = nonMembers.map((id) => this.botName(id)).join(", ");
        this.systemLine(roomId, rt, `@${names} is not a member of this room — not pinged (add them via the room header)`);
      }
    }
    return this.enqueue(roomId, () => this.userSayTurns(roomId, text));
  }

  /** Membership changed via PATCH: when a runtime already exists the
   *  watermark fallback delivers the backlog, so the persisted zeroMark is
   *  consumed HERE — leaving it would re-inject the whole backlog after the
   *  next restart (dogfood-D1 R2 P3). */
  membersChanged(roomId: string): void {
    if (this.runtimes.get(roomId) === undefined) return;
    const room = this.store.room(roomId);
    if (room !== undefined && (room.zeroMark ?? []).length > 0) {
      try { this.store.updateRoom(roomId, { zeroMark: [] }); } catch { /* shutting down */ }
    }
  }

  /** Explicit pause/resume (budget stop lands here with reason "budget"). */
  pause(roomId: string, reason: RoomRuntime["pausedReason"], note: string): void {
    const room = this.store.room(roomId);
    if (room === undefined) throw new Error(`no room ${roomId}`);
    const rt = this.runtime(roomId, room);
    rt.pausedReason = reason;
    this.store.updateRoom(roomId, { status: "paused", pauseReason: reason, pausedAt: new Date().toISOString() });
    this.systemLine(roomId, rt, note);
  }

  resume(roomId: string, note: string): void {
    const room = this.store.room(roomId);
    if (room === undefined) throw new Error(`no room ${roomId}`);
    const rt = this.runtime(roomId, room);
    rt.pausedReason = null;
    this.store.updateRoom(roomId, { status: "active", pauseReason: null, pausedAt: null });
    this.systemLine(roomId, rt, note);
  }

  private async userSayTurns(roomId: string, text: string): Promise<{ responders: string[]; selected: string[] }> {
    // TURN PHASE (queued): responder selection + turns. The user line and
    // pause handling already landed at accept time (userSay).
    const room = this.store.room(roomId);
    if (room === undefined) throw new Error(`no room ${roomId}`);
    const rt = this.runtime(roomId, room);

    const members = room.members.map((id) => ({
      id,
      name: this.store.bot(id)?.name ?? id,
    }));
    const mentions = parseMentions(text, members);
    const decision = pickResponder(
      { admin: room.admin, mode: room.mode, members: room.members },
      mentions,
      rt.rrPointer,
      rt.pausedReason !== null,
      { kind: "user" } // @all is user/admin-only (§5); bot senders arrive M2-B
    );

    // (Non-member mention honesty moved to the accept phase — userSay.)

    const spoke: string[] = [];
    for (const botId of decision.responders) {
      if (this.store.bot(botId) === undefined) continue;
      // Header-only turns (D3 review P2-2): the accept-phase split means a
      // mid-batch message can be consumed by an EARLIER responder's render
      // (watermark committed past it) — running this responder against an
      // empty dialogue is a metered no-op turn. Skip honestly.
      {
        const ctx = this.renderContextUncommitted(room, rt, botId);
        const hasDialogue = ctx.text.includes("\n\n");
        if (!hasDialogue) {
          rt.slots[botId] = "passed";
          continue;
        }
      }
      // A pause triggered mid-fan-out (ping-pong) stops the rest (§3.3-1).
      if (rt.pausedReason !== null) break;
      await this.runTurn(roomId, room, rt, botId);
      const slot = rt.slots[botId];
      if (slot === "posted") spoke.push(botId);
    }
    if (room.mode === "round-robin" && decision.responders.length > 0) {
      rt.rrPointer = nextRRPointer(
        { admin: room.admin, mode: room.mode, members: room.members },
        rt.rrPointer
      );
    }
    return { responders: spoke, selected: decision.responders };
  }

  /** Per-room FIFO: one turn batch at a time. */
  private enqueue<T>(roomId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(roomId) ?? Promise.resolve();
    const next = prev.then(op, op);
    this.queues.set(roomId, next.catch(() => undefined));
    return next;
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
    // New turn: everyone who is not about to speak resets to waiting —
    // "posted" is a per-turn verdict, not a sticky identity.
    for (const m of room.members) if (m !== botId && rt.slots[m] !== "timed-out") rt.slots[m] = "waiting";
    rt.slots[botId] = "speaking";
    this.emitTurn(roomId, room);

    const context = this.renderContextUncommitted(room, rt, botId);

    // Turn-outcome correlation (R2 P2-2): a settled prompt is not a
    // successful one — an errored/aborted settle leaves
    // get_last_assistant_text pointing at a PREVIOUS turn's text; appending
    // it would phantom-write stale content into the room log.
    let turnErrored = false;
    // NOTE: BotManager emits "failure" (its public surface) — NOT the
    // driver-level "bot_failed"; the wrong name left provider errors feeding
    // phantom replies through here (review R3 P1).
    const onFailure = (e: { botId: string; reason: string }): void => {
      if (e.botId === botId) turnErrored = true;
    };
    const onAborted = (e: { botId: string }): void => { if (e.botId === botId) turnErrored = true; };
    this.bots.on("failure", onFailure);
    this.bots.on("aborted", onAborted);

    // First-token watchdog (§6.1): no delta within replyTimeoutMs ⇒ interrupt
    // and mark the slot timed-out (verdict is STICKY for this turn — the
    // success path must not overwrite it, review R1 P1-2).
    let sawFirstToken = false;
    let timedOut = false;
    const onDelta = (e: { botId: string; text: string }): void => {
      if (e.botId === botId) sawFirstToken = true;
    };
    this.bots.on("delta", onDelta);
    const watchdog = setTimeout(() => {
      if (!sawFirstToken) {
        timedOut = true;
        rt.slots[botId] = "timed-out";
        this.emitTurn(roomId, room);
        void this.bots.interrupt(botId).catch(() => undefined);
      }
    }, guards.replyTimeoutMs);
    // Per-task wall clock (§6.1a maxWallMs): budget.deadlineMs(botId) caps
    // the WHOLE turn; hitting it aborts and marks the slot timed-out (the
    // same honest verdict as the first-token watchdog).
    let wallClock: NodeJS.Timeout | null = null;
    const cleanup = (): void => {
      clearTimeout(watchdog);
      if (wallClock !== null) clearTimeout(wallClock);
      this.bots.off("delta", onDelta);
      this.bots.off("failure", onFailure);
      this.bots.off("aborted", onAborted);
    };

    const wallMs = this.deadlineMs?.(botId) ?? null;
    if (wallMs !== null && wallMs > 0) {
      wallClock = setTimeout(() => {
        timedOut = true;
        rt.slots[botId] = "timed-out";
        this.emitTurn(roomId, room);
        void this.bots.interrupt(botId).catch(() => undefined);
      }, wallMs);
    }
    let reply: string;
    try {
      reply = await this.bots.prompt(botId, context.text, "chat", roomId);
    } catch (error) {
      cleanup();
      rt.slots[botId] = timedOut ? "timed-out" : "failed";
      this.systemLine(
        roomId,
        rt,
        timedOut
          ? `${this.botName(botId)} timed out after ${guards.replyTimeoutMs}ms with no first token`
          : `${this.botName(botId)} turn failed: ${String(error).slice(0, 160)}`
      );
      rt.turnTools.delete(botId);
      this.emitTurn(roomId, room);
      // Watermark untouched: prompt never accepted ⇒ the message stays
      // injectable next turn (review R1 P1-1).
      return;
    }
    cleanup();
    rt.slots[botId] = timedOut ? "timed-out" : turnErrored ? "failed" : sawFirstToken ? "posted" : "failed";
    if (timedOut) {
      this.systemLine(roomId, rt, `${this.botName(botId)} timed out after ${guards.replyTimeoutMs}ms with no first token`);
    } else if (turnErrored) {
      this.systemLine(roomId, rt, `${this.botName(botId)} turn errored (provider/abort) — no reply recorded`);
    } else if (!sawFirstToken) {
      // P3-2: explain a failed-without-delta settle symmetric to the reject path.
      this.systemLine(roomId, rt, `${this.botName(botId)} turn produced no output`);
    }

    if (!timedOut && !turnErrored && reply.trim().length > 0) {
      this.append(roomId, rt, { kind: "bot", id: botId }, reply);
      try {
        this.onTurnSettled?.(roomId, botId, reply);
      } catch {
        /* memory ingest must never break the turn loop */
      }
    }
    // Prompt accepted and settled ⇒ commit the watermark (the injected
    // context is now durably in the bot's session; R1 P1-1).
    rt.watermark.set(botId, context.seq);

    // Ping-pong evaluation ONLY on real completed turns: timed-out AND
    // errored turns produced nothing and must not feed the guard.
    if (!timedOut && !turnErrored) {
      const toolCalls = rt.turnTools.get(botId) ?? 0;
      const verdict = afterBotTurn(guards, rt.pingPong, toolCalls);
      rt.pingPong = verdict.state;
      if (verdict.pauseNow && rt.pausedReason === null) {
        // Priority merge: never downgrade a budget pause (review R1 P2-3).
        rt.pausedReason = "ping-pong";
        this.store.updateRoom(roomId, { status: "paused", pauseReason: "ping-pong" });
        this.systemLine(
          roomId,
          rt,
          `paused — ${verdict.state.consecutivePure} idle replies in a row (guard N=${guards.pingPongN}), waiting for you`
        );
      }
    }
    rt.turnTools.delete(botId);
    this.emitTurn(roomId, room);
  }

  // --- context rendering (§5.1a) -------------------------------------------------

  /**
   * Render the prompt for one bot's turn WITHOUT advancing the watermark:
   * the caller commits `seq` only after the prompt was accepted and settled
   * (a rejected prompt leaves the messages injectable next turn — R1 P1-1).
   */
  private renderContextUncommitted(room: RoomRecord, rt: RoomRuntime, botId: string): { text: string; seq: number } {
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
    // Frozen memory snapshot at the tail of the system-ish header (§5.1a):
    // byte-stable between reviews (snapshot freeze), "" while no memory.
    const tail = (() => {
      try {
        return this.memoryTail?.(botId, room.id) ?? "";
      } catch {
        return "";
      }
    })();
    const head = tail.length > 0 ? `${header}\n\n${tail}` : header;
    const dialogue = pending.map((m) => this.formatForInjection(m)).join("\n");
    return {
      text: dialogue.length > 0 ? `${head}\n\n${dialogue}` : head,
      seq: rt.lastSeq,
    };
  }

  /** The exact prompt text the next turn for this bot would render
   *  (debug/UI; advances nothing — watermarks untouched). */
  previewContext(roomId: string, botId: string): string {
    const room = this.store.room(roomId);
    if (room === undefined) throw new Error(`no room ${roomId}`);
    return this.renderContextUncommitted(room, this.runtime(roomId, room), botId).text;
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

  /** Room lines from outside the turn loop (handoff results, §5.2). */
  appendBot(roomId: string, botId: string, text: string): void {
    const room = this.store.room(roomId);
    if (room === undefined) throw new Error(`no room ${roomId}`);
    const rt = this.runtime(roomId, room);
    this.append(roomId, rt, { kind: "bot", id: botId }, text);
  }

  appendSystem(roomId: string, text: string): void {
    const room = this.store.room(roomId);
    if (room === undefined) throw new Error(`no room ${roomId}`);
    const rt = this.runtime(roomId, room);
    this.systemLine(roomId, rt, text);
  }

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
    // fsync per line (R1 P2-4): the room log must not lag the bot sessions
    // that already consumed the message — a lost tail would desync them.
    const fd = openSync(messagesPath(this.roomsRoot, roomId), "a");
    try {
      writeSync(fd, `${JSON.stringify(msg)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
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
    // at the disk tail (no re-injection/duplication). EXCEPT members the
    // members-PATCH marked zeroMark: they were ADDED after that tail (e.g.
    // while no runtime existed) and must see the full backlog — the mark is
    // consumed here so it applies exactly once (dogfood D1 review P3).
    const zero = new Set(room.zeroMark ?? []);
    const watermark = new Map<string, number>(
      room.members.map((m) => [m, zero.has(m) ? 0 : lastSeq])
    );
    if (zero.size > 0) {
      try { this.store.updateRoom(roomId, { zeroMark: [] }); } catch { /* shutting down */ }
    }
    rt = {
      lastSeq,
      rrPointer: 0,
      pingPong: { consecutivePure: 0 },
      watermark,
      slots: {},
      // Restart honesty (R1 P1-3): a persisted pause stays a pause; an
      // unknown reason is treated as budget (the un-liftable kind) —
      // conservative beats resuming spend by accident.
      pausedReason:
        room.status === "paused" ? (room.pauseReason ?? "budget") : null,
      turnTools: new Map(),
    };
    this.runtimes.set(roomId, rt);
    return rt;
  }

  private botName(botId: string): string {
    return this.store.bot(botId)?.name ?? botId;
  }
}

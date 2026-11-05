/**
 * handoff — the task-dispatch work tree (architecture §3.1 step 3-4, §6.2).
 *
 * The mechanism (M0-S2 criterion ② proved the channel): a bot calls the
 * `message_bot` extension tool → the extension parks on the ui bridge →
 * BotManager surfaces it as an extension_ui_request with a codar: prefix →
 * THIS module dispatches (work tree, anti-cycle, request_id idempotency),
 * runs the child turn out-of-band, and the result flows back to the room
 * and wakes the caller.
 *
 * Cycle prevention (§6.2): you may NOT send a message to a bot that is
 * waiting on YOUR result. Implementation: DFS over the pending parent chain
 * — if the target is an ancestor of the sender in the pending work tree,
 * reject.
 */

import { EventEmitter } from "node:events";
import type { Store, WorkRecord } from "./store.js";
import type { RoomEngine } from "./room-engine.js";
import type { BotManager } from "./bot-manager.js";

export const MESSAGE_BOT_TITLE_PREFIX = "codar:message_bot";
export const MESSAGE_BOT_TOOL = "message_bot";

export interface HandoffRequest {
  fromBot: string;
  toBot: string;
  task: string;
  roomId: string | null;
  /** Idempotency key: same requestId dispatches the SAME work (no re-run). */
  requestId: string;
}

export interface HandoffEvents {
  work: { workId: string; status: WorkRecord["status"]; parent: string; child: string };
  progress: { workId: string; botId: string; oneLiner: string; status: WorkRecord["status"] };
}

export class Handoff extends EventEmitter {
  /** Per-task wall cap provider (Budget.wallDeadlineMs); set by Host
   *  (§6.1a maxWallMs — M2-C R2 P2-4). */
  deadlineMs: ((botId: string) => number | null) | null = null;

  /** Stale-pause test (Budget.rolloverIfStale); set by Host. Both budget
   *  gates run it BEFORE refusing — the established entry-point pattern
   *  ("whoever is about to reject activity performs the rollover test
   *  first"): a next-month pause left undated in memory by a restart must
   *  lift here, not block honest work (M2-C R5 P2-2). */
  stalePauseCheck: ((roomId: string) => void) | null = null;

  /** Is this room under an ACTIVE budget pause? Runs the stale test first. */
  private budgetPaused(roomId: string): boolean {
    if (this.stalePauseCheck !== null) {
      try { this.stalePauseCheck(roomId); } catch { /* shutting down */ }
    }
    const room = this.store.room(roomId);
    return room?.status === "paused" && (room.pauseReason ?? "budget") === "budget";
  }

  /** Results for busy callers, delivered when the caller goes idle.
   *  Multi-slot per parent: a busy window can produce SEVERAL results —
   *  each gets its own wake prompt, none overwritten (M2-B R2 P2-a). */
  private readonly wakeQueue = new Map<string, string[]>();

  constructor(
    private readonly store: Store,
    private readonly bots: BotManager,
    private readonly rooms: RoomEngine
  ) {
    super();
    // Idle transitions retry pending works and drain the wake queue —
    // "queued" is never a black hole (M2-B R1 P1-2).
    bots.on("status", (e: { botId: string; status: string }) => {
      if (e.status !== "idle") return;
      const wakes = this.wakeQueue.get(e.botId);
      if (wakes !== undefined && wakes.length > 0) {
        // Deliver one wake per idle slot (ordered); the rest follow on the
        // next idle transition so each result keeps its own causal frame.
        const wake = wakes.shift()!;
        if (wakes.length === 0) this.wakeQueue.delete(e.botId);
        void this.bots.prompt(e.botId, wake, "chat").catch((err: unknown) => {
          // A failed wake is surfaced on the room log when possible — never
          // silently swallowed (M2-B R2 P2-a note).
          {
            const roomId = this.store.state.rooms.find((r) => r.members.includes(e.botId))?.id;
            if (roomId !== undefined) {
              try { this.rooms.appendSystem(roomId, `wake delivery to ${this.botName(e.botId)} failed: ${String(err).slice(0, 140)}`); } catch { /* shutdown */ }
            }
          }
        });
        return;
      }
      const pendingFor = this.store.state.works.find(
        (w) => w.child === e.botId && w.status === "pending"
      );
      if (pendingFor !== undefined) {
        void this.runChild(pendingFor, pendingFor.task).catch(() => undefined);
      }
    });
  }

  /**
   * A bot asked to message/dispatch another bot. Returns the work id (or the
   * existing work for a duplicate requestId). Throws on cycle or unknown
   * target — the bridge converts the throw into the tool's error result so
   * the calling bot SEES the rejection instead of hanging.
   */
  async dispatch(req: HandoffRequest): Promise<{ workId: string; duplicate: boolean }> {
    if (this.store.bot(req.toBot) === undefined) {
      throw new Error(`message_bot: unknown bot "${req.toBot}"`);
    }
    if (req.toBot === req.fromBot) {
      throw new Error(`message_bot: cannot dispatch to yourself ("${req.toBot}")`);
    }

    // request_id idempotency (§6.2): same key = same work, never re-run —
    // but ONLY over works that ran or are still live: a FAILED/REJECTED work
    // answering "ok, duplicate" would promise an execution that never
    // happens (M2-B R2 P2-b).
    const existing = this.store.state.works.find(
      (w) => w.requestId === req.requestId &&
        (w.status === "pending" || w.status === "working" || w.status === "done")
    );
    if (existing !== undefined) {
      return { workId: existing.id, duplicate: true };
    }
    // Terminal (failed/rejected) works release the key implicitly: the
    // find above skipped them, so a retry proceeds to a NEW work (honest
    // restart semantics — M2-B R2 P2-b).

    // Budget gate (M2-C R4): dispatch INTO a budget-paused room's member is
    // rejected up front — the caller bot SEES the refusal instead of getting
    // a work that never runs. §5.3 group-stop semantics: the pause already
    // aborted the members' in-flight work; new runs must not sidestep it.
    // ANY member room under an active pause refuses (multi-room members are
    // legal state; first-match found the wrong room in R5 review).
    // budgetPaused() runs the stale-pause test first (R5 P2-2).
    for (const r of this.store.state.rooms) {
      if (r.members.includes(req.toBot) && this.budgetPaused(r.id)) {
        throw new Error(`message_bot: ${this.botName(req.toBot)}'s room is budget-paused (§5.3) — adjust the budget to resume`);
      }
    }

    // Anti-cycle: the target must not be a pending ancestor of the sender.
    this.assertNoCycle(req.fromBot, req.toBot);

    const work: WorkRecord = {
      id: `work_${crypto.randomUUID().slice(0, 8)}`,
      parent: req.fromBot,
      child: req.toBot,
      requestId: req.requestId,
      status: "pending",
      roomId: req.roomId,
      task: req.task,
    };
    this.store.addWork(work);
    this.emit("work", { workId: work.id, status: "pending", parent: work.parent, child: work.child });

    // Out-of-band execution: the room turn is NOT blocked (§5.2); the child
    // runs as its own turn and the result flows back when it settles.
    void this.runChild(work, req.task).catch(() => undefined);
    return { workId: work.id, duplicate: false };
  }

  works(roomId?: string): WorkRecord[] {
    const all = this.store.state.works;
    return roomId === undefined ? all : all.filter((w) => w.roomId === roomId);
  }

  work(workId: string): WorkRecord | undefined {
    return this.store.state.works.find((w) => w.id === workId);
  }

  // --- internals ---------------------------------------------------------------

  private async runChild(work: WorkRecord, task: string): Promise<void> {
    // If the child bot is idle we can prompt directly; if it's mid-turn the
    // dispatch is queued as pending and picked up on its next turn — M2-B
    // keeps that simple: prompt if idle, else leave pending (honest).
    if (this.bots.status(work.child) !== "idle") {
      this.emit("progress", {
        workId: work.id, botId: work.child,
        oneLiner: `queued — ${this.botName(work.child)} is busy`,
        status: "pending",
      });
      return;
    }
    // Budget gate, run-side twin of the dispatch gate (M2-C R4): a work that
    // queued as pending may reach an idle child AFTER its room got
    // budget-paused. Honest failure, key released for a post-resume retry.
    // ANY member room under an active pause refuses; budgetPaused() runs the
    // stale-pause test first (R5 P2-2).
    const childPaused = this.store.state.rooms.some((r) => r.members.includes(work.child) && this.budgetPaused(r.id));
    if (childPaused) {
      this.store.updateWork(work.id, { status: "failed" });
      this.emit("work", { workId: work.id, status: "failed", parent: work.parent, child: work.child });
      // Notify where the interrupted path notifies (R5 P3-1): the
      // REQUESTER's room, or the parent directly for room-less works — a
      // cross-room dispatch must not leave the caller unnotified.
      if (work.roomId !== null) {
        try {
          this.rooms.appendSystem(work.roomId, `task ${work.id} → ${this.botName(work.child)} not started — room budget paused (§5.3)`);
        } catch { /* shutdown */ }
      } else {
        this.deliverWake(work.parent, `[task ${work.id}: not started — ${this.botName(work.child)}'s room is budget-paused (§5.3)]`);
      }
      return;
    }
    this.store.updateWork(work.id, { status: "working" });
    this.emit("work", { workId: work.id, status: "working", parent: work.parent, child: work.child });
    this.emit("progress", {
      workId: work.id, botId: work.child,
      oneLiner: "starting…",
      status: "working",
    });

    // The child's context = its own session + the task text (injected like a
    // room message from the parent, §5.1a format).
    const injected = `[${this.botName(work.parent)} → you] ${task}`;
    const lastProgress = { oneLiner: "" };
    const onTool = (e: { botId: string; toolName: string }): void => {
      if (e.botId !== work.child) return;
      lastProgress.oneLiner = `${e.toolName}…`;
      this.emit("progress", { workId: work.id, botId: work.child, oneLiner: lastProgress.oneLiner, status: "working" });
    };
    this.bots.on("tool", onTool);
    // Turn-outcome correlation (M2-C R4 P1 — the same guard room-engine
    // runTurn has had since M2-A R3): a SETTLED prompt is not a SUCCESSFUL
    // one. After an interrupt (per-task wall clock / API abort / room
    // budget stop) the harvest's get_last_assistant_text points at the
    // child's PREVIOUS turn's text — pi 1.5.0 only skips aborted messages
    // with EMPTY content. Without this guard an interrupted task delivers
    // the child's stale old answer to the room and the caller (proven in
    // R4), or dies silently marked "done".
    let turnInterrupted = false;
    const onAborted = (e: { botId: string }): void => { if (e.botId === work.child) turnInterrupted = true; };
    const onFailure = (e: { botId: string; reason: string }): void => { if (e.botId === work.child) turnInterrupted = true; };
    this.bots.on("aborted", onAborted);
    this.bots.on("failure", onFailure);
    let wallClock: NodeJS.Timeout | null = null;
    try {
      // Per-task wall clock (§6.1a maxWallMs — M2-C R3 P2-4). Armed inside
      // the try so a throwing deadline provider cannot strand the work in
      // "working" or leak the listeners (R4 P3); cleared once, in finally.
      const wallMs = this.deadlineMs?.(work.child) ?? null;
      if (wallMs !== null && wallMs > 0) {
        wallClock = setTimeout(() => {
          void this.bots.interrupt(work.child).catch(() => undefined);
        }, wallMs);
      }
      const result = await this.bots.prompt(work.child, injected, "tool");
      if (turnInterrupted) {
        // Interrupted ⇒ failed, NEVER a silent "done": the cut lands where
        // it is observable (§5.3), and NO stale result is delivered.
        try { this.store.updateWork(work.id, { status: "failed" }); } catch { /* shutdown */ }
        this.emit("work", { workId: work.id, status: "failed", parent: work.parent, child: work.child });
        if (work.roomId !== null) {
          try {
            this.rooms.appendSystem(work.roomId, `task ${work.id} → ${this.botName(work.child)} interrupted — no result delivered`);
          } catch { /* shutdown */ }
        } else {
          this.deliverWake(work.parent, `[task ${work.id} result: INTERRUPTED — no result delivered]`);
        }
        return;
      }
      this.store.updateWork(work.id, { status: "done" });
      this.emit("work", { workId: work.id, status: "done", parent: work.parent, child: work.child });
      // Result flows back: room line (if room-scoped) + caller wake prompt.
      await this.returnResult(work, result, lastProgress.oneLiner);
    } catch (error) {
      // Best-effort failure bookkeeping: the host may be shutting down (store
      // closed, dirs removed) — a throwing catch-path would surface as an
      // unhandled rejection (suite-level test failure), so guard each step.
      try { this.store.updateWork(work.id, { status: "failed" }); } catch { /* shutdown */ }
      this.emit("work", { workId: work.id, status: "failed", parent: work.parent, child: work.child });
      if (work.roomId !== null) {
        try {
          this.rooms.appendSystem(work.roomId, `task ${work.id} → ${this.botName(work.child)} failed: ${String(error).slice(0, 160)}`);
        } catch { /* shutdown */ }
      }
    } finally {
      if (wallClock !== null) clearTimeout(wallClock);
      this.bots.off("tool", onTool);
      this.bots.off("aborted", onAborted);
      this.bots.off("failure", onFailure);
    }
  }

  private async returnResult(work: WorkRecord, result: string, progressLiner: string): Promise<void> {
    if (work.roomId !== null && result.trim().length > 0) {
      try {
        this.rooms.appendBot(work.roomId, work.child, result);
      } catch { /* shutdown race */ }
    }
    this.emit("progress", {
      workId: work.id, botId: work.child,
      oneLiner: progressLiner || "done",
      status: "done",
    });
    // Caller wake (§5.2 step 4): the parent gets the result as a new prompt
    // when idle; a BUSY parent queues (never dropped — M2-B R1 P2). Results
    // for room-scoped works also arrive via room injection next turn.
    if (result.trim().length > 0) {
      this.deliverWake(work.parent, `[${this.botName(work.child)} → you, task ${work.id} result]\n${result}`);
    }
  }

  /** Deliver a wake prompt to a bot: now when idle, queued when busy
   *  (never dropped — M2-B R1 P2). */
  private deliverWake(botId: string, text: string): void {
    if (this.bots.status(botId) === "idle") {
      void this.bots.prompt(botId, text, "chat").catch(() => undefined);
    } else {
      const q = this.wakeQueue.get(botId) ?? [];
      q.push(text);
      this.wakeQueue.set(botId, q);
    }
  }

  /** BFS over pending parent SETS: is `target` reachable as an ancestor of
   *  `from` through pending/working works? (M2-B R1 P2: one child may have
   *  SEVERAL pending parents — a single-parent chain misses real cycles.) */
  private assertNoCycle(from: string, target: string): void {
    const pending = this.store.state.works.filter((w) => w.status === "pending" || w.status === "working");
    const parentsOf = new Map<string, Set<string>>();
    for (const w of pending) {
      const set = parentsOf.get(w.child) ?? new Set<string>();
      set.add(w.parent);
      parentsOf.set(w.child, set);
    }
    const queue = [from];
    const seen = new Set<string>([from]);
    const chain = new Map<string, string>();
    while (queue.length > 0) {
      const cursor = queue.shift()!;
      const parents = parentsOf.get(cursor);
      if (parents === undefined) continue;
      for (const p of parents) {
        if (seen.has(p)) continue;
        seen.add(p);
        chain.set(p, cursor);
        if (p === target) {
          // Reconstruct the chain target → … → from for the error message.
          const path: string[] = [p];
          let step = cursor;
          while (step !== from) { path.push(step); step = chain.get(step) ?? from; }
          path.push(from);
          throw new Error(
            `message_bot: cycle — ${this.botName(target)} is waiting on your result (pending chain ${path.map((x) => this.botName(x)).join(" → ")})`
          );
        }
        queue.push(p);
      }
    }
  }

  private botName(botId: string): string {
    return this.store.bot(botId)?.name ?? botId;
  }
}

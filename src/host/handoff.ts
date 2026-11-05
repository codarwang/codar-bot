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
  /** Results for busy callers, delivered when the caller goes idle. */
  private readonly wakeQueue = new Map<string, string>();

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
      const wake = this.wakeQueue.get(e.botId);
      if (wake !== undefined) {
        this.wakeQueue.delete(e.botId);
        void this.bots.prompt(e.botId, wake, "chat").catch(() => undefined);
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

    // request_id idempotency (§6.2): same key = same work, never re-run.
    const existing = this.store.state.works.find((w) => w.requestId === req.requestId);
    if (existing !== undefined) {
      return { workId: existing.id, duplicate: true };
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
    try {
      const result = await this.bots.prompt(work.child, injected, "tool");
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
      this.bots.off("tool", onTool);
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
      const wake = `[${this.botName(work.child)} → you, task ${work.id} result]\n${result}`;
      if (this.bots.status(work.parent) === "idle") {
        void this.bots.prompt(work.parent, wake, "chat").catch(() => undefined);
      } else {
        this.wakeQueue.set(work.parent, wake);
      }
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

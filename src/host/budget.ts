/**
 * budget — usage enforcement (architecture §5.3, §6.1a; PRD G-4 / M2-2.5).
 *
 * The metering side already lands every model call in the ledger (M1-1.5,
 * M0-S3-verified zero-drift). This module adds the STOP side:
 *  - per-bot AND per-room monthly windows (UTC calendar month, §6.1a)
 *  - check after every ledger write; over-limit ⇒ driver abort+stop (bot)
 *    or room pause (room) + room broadcast + audit — never silent
 *  - four dimensions: maxTokens / maxCostMicros / maxTurns / maxWallMs(per-task)
 *  - 80% warning line
 *  - unpriced providers degrade to token budgets (catalog-currency note, §4)
 */

import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Store, BotBudget } from "./store.js";
import type { UsageLedger } from "./usage-ledger.js";
import type { BotManager } from "./bot-manager.js";
import type { RoomEngine } from "./room-engine.js";

export interface BudgetEvents {
  budget: {
    scope: "bot" | "room";
    id: string;
    dimension: "tokens" | "cost" | "turns";
    used: number;
    limit: number;
    pct: number;
    level: "warn" | "stop";
  };
}

/** UTC calendar-month key, e.g. "2026-11" (§6.1a window semantics). */
export function monthKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

const WARN_PCT = 80;

/** Per-scope monthly enforcement state (window bookkeeping + sticky). */
interface ScopeState {
  /** Turns settled this month (§6.1a maxTurns). */
  turns: number;
  /** Already stopped/paused this window (sticky — §5.3). */
  stopped: boolean;
  /** The month these counters belong to (rollover resets). */
  month: string;
}

export class Budget extends EventEmitter {
  private readonly auditPath: string;
  /** month × scope already warned at (one warn per window per scope). */
  private readonly warned = new Set<string>();
  private readonly scopes = new Map<string, ScopeState>();

  constructor(
    private readonly store: Store,
    private readonly ledger: UsageLedger,
    private readonly bots: BotManager,
    private readonly rooms: RoomEngine,
    dataRoot: string
  ) {
    super();
    this.auditPath = join(dataRoot, "audit.jsonl");
    // Hook: after every usage write, check the writing bot's windows. A
    // failed check is AUDITED, never swallowed (M2-C R1 P2-6).
    ledger.onRecord = (botId: string) => {
      this.checkBot(botId).catch((error: unknown) => {
        this.audit({ kind: "budget-check-error", botId, error: String(error).slice(0, 200) });
      });
    };
    // Turns dimension: every settle counts (bot + its rooms).
    bots.on("status", (e: { botId: string; status: string; detail?: string }) => {
      if (e.status !== "idle" || e.detail === "prompt failed" || e.detail === "harvest failure") return;
      this.onSettled(e.botId);
    });
  }

  /** A bot turn settled (idle transition from a working state). */
  private onSettled(botId: string): void {
    const bot = this.store.bot(botId);
    if (bot === undefined) return;
    const st = this.scope(`bot:${botId}`);
    st.turns += 1;
    this.checkTurns("bot", botId, st.turns, bot.budget.maxTurns);
    for (const room of this.store.state.rooms) {
      if (!room.members.includes(botId)) continue;
      const rs = this.scope(`room:${room.id}`);
      rs.turns += 1;
      this.checkTurns("room", room.id, rs.turns, room.budget.maxTurns);
    }
  }

  private scope(key: string): ScopeState {
    const month = monthKey();
    let st = this.scopes.get(key);
    if (st === undefined || st.month !== month) {
      // Month rollover: fresh window resets counters AND the sticky stop
      // (§5.3 "次月自动恢复") and re-arms the warn line.
      st = { turns: 0, stopped: false, month };
      this.scopes.set(key, st);
      for (const w of [...this.warned]) {
        if (w.endsWith(`:${key.split(":")[1]}`) === false) continue;
      }
      // Re-arm warns whose scope matches this key.
      for (const w of [...this.warned]) {
        const parts = w.split(":");
        if (parts[1] === key.split(":")[0] && parts[2] === key.split(":")[1]) this.warned.delete(w);
      }
      // Resume a budget-paused room on rollover.
      if (key.startsWith("room:")) {
        const roomId = key.slice(5);
        const room = this.store.room(roomId);
        if (room?.status === "paused" && room.pauseReason === "budget") {
          try { this.rooms.resume(roomId, "new month — budget window reset"); } catch { /* shutting down */ }
        }
      }
    }
    return st;
  }

  /** Per-task wall clock (§6.1a maxWallMs): returns a stop-at deadline for
   *  the caller (room-engine / handoff) to enforce on their turn. */
  wallDeadlineMs(botId: string): number | null {
    const bot = this.store.bot(botId);
    if (bot === undefined || bot.budget.maxWallMs <= 0) return null;
    return bot.budget.maxWallMs;
  }

  /**
   * Check a bot's own budget + every room it belongs to. Over-limit ⇒
   * abort+stop the bot (§5.3) or pause the room — each at most once per
   * window (stop is sticky until the next window or a limit change).
   */
  async checkBot(botId: string): Promise<void> {
    const bot = this.store.bot(botId);
    if (bot === undefined) return;
    const month = monthKey();
    const totals = this.ledger.totals({ botId, sinceHour: `${month}-01T00` });
    const usedTokens = totals.reduce((a, r) => a + r.input + r.output + r.cacheRead + r.cacheWrite, 0);
    const usedMicros = totals.reduce((a, r) => a + r.costMicros, 0);

    this.evaluate("bot", botId, bot.budget, usedTokens, usedMicros);

    // Room windows: every room this bot feeds.
    for (const room of this.store.state.rooms) {
      if (!room.members.includes(botId)) continue;
      await this.checkRoom(room.id);
    }
  }

  async checkRoom(roomId: string): Promise<void> {
    const room = this.store.room(roomId);
    if (room === undefined) return;
    const month = monthKey();
    let tokens = 0; let micros = 0;
    for (const m of room.members) {
      const totals = this.ledger.totals({ botId: m, sinceHour: `${month}-01T00` });
      for (const r of totals) { tokens += r.input + r.output + r.cacheRead + r.cacheWrite; micros += r.costMicros; }
    }
    this.evaluate("room", roomId, room.budget, tokens, micros);
  }

  /** Turn-dimension check: called per agent_settled (§6.1a maxTurns). */
  checkTurns(scope: "bot" | "room", id: string, turns: number, limit: number): void {
    if (limit <= 0) return;
    const st = this.scope(`${scope}:${id}`);
    const pct = Math.round((turns / limit) * 100);
    if (pct >= 100) {
      if (!st.stopped) {
        this.emit("budget", { scope, id, dimension: "turns", used: turns, limit, pct, level: "stop" });
        this.stopFor(scope, id, "turns", turns, limit);
      }
    } else if (pct >= WARN_PCT) {
      this.warnOnce(scope, id, "turns", turns, limit, pct);
    }
  }

  // --- internals -----------------------------------------------------------------

  private evaluate(
    scope: "bot" | "room",
    id: string,
    budget: BotBudget,
    usedTokens: number,
    usedMicros: number
  ): void {
    const st = this.scope(`${scope}:${id}`);
    // Token dimension.
    if (budget.maxTokens > 0) {
      const pct = Math.round((usedTokens / budget.maxTokens) * 100);
      if (pct >= 100) {
        if (!st.stopped) {
          this.emit("budget", { scope, id, dimension: "tokens", used: usedTokens, limit: budget.maxTokens, pct, level: "stop" });
          this.stopFor(scope, id, "tokens", usedTokens, budget.maxTokens);
        }
      } else if (pct >= WARN_PCT) {
        this.warnOnce(scope, id, "tokens", usedTokens, budget.maxTokens, pct);
      }
    }
    // Cost dimension.
    if (budget.maxCostMicros > 0) {
      const pct = Math.round((usedMicros / budget.maxCostMicros) * 100);
      if (pct >= 100) {
        if (!st.stopped) {
          this.emit("budget", { scope, id, dimension: "cost", used: usedMicros, limit: budget.maxCostMicros, pct, level: "stop" });
          this.stopFor(scope, id, "cost", usedMicros, budget.maxCostMicros);
        }
      } else if (pct >= WARN_PCT) {
        this.warnOnce(scope, id, "cost", usedMicros, budget.maxCostMicros, pct);
      }
    }
  }

  private warnOnce(
    scope: "bot" | "room", id: string, dim: string,
    used: number, limit: number, pct: number
  ): void {
    const key = `${monthKey()}:${scope}:${id}:${dim}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.emit("budget", { scope: scope as "bot" | "room", id, dimension: dim as "tokens", used, limit, pct, level: "warn" });
    this.broadcast(scope, id, `budget ${pct}% — ${dim} ${used}/${limit} this month`);
    this.audit({ kind: "budget-warn", scope, id, dimension: dim, used, limit, pct });
  }

  private stopFor(scope: "bot" | "room", id: string, dim: string, used: number, limit: number): void {
    const st = this.scope(`${scope}:${id}`);
    st.stopped = true; // sticky within the window (M2-C R1 P2-4)
    if (scope === "bot") {
      // A failed stop is AUDITED as a failure — the audit never lies
      // (M2-C R1 P2-6).
      this.bots.stop(id)
        .then(() => {
          this.audit({ kind: "budget-stop", scope, id, dimension: dim, used, limit, stopResult: "stopped" });
        })
        .catch((error: unknown) => {
          this.audit({ kind: "budget-stop", scope, id, dimension: dim, used, limit, stopResult: "stop-failed", error: String(error).slice(0, 160) });
        });
      this.broadcast("bot", id, `⛔ BUDGET STOPPED — ${this.nameOf("bot", id)}: ${dim} ${used}/${limit} this month, bot stopped (§5.3)`);
    } else {
      // §5.3 group stop: abort every WORKING member, then pause the room.
      for (const m of this.store.room(id)?.members ?? []) {
        const status = this.bots.status(m);
        if (status === "working" || status === "starting") {
          void this.bots.interrupt(m).catch(() => undefined);
        }
      }
      try {
        this.rooms.pause(id, "budget", `⛔ ROOM PAUSED — budget exhausted (${dim} ${used}/${limit} this month)`);
        this.audit({ kind: "budget-stop", scope, id, dimension: dim, used, limit, stopResult: "paused" });
      } catch (error) {
        this.audit({ kind: "budget-stop", scope, id, dimension: dim, used, limit, stopResult: "pause-failed", error: String(error).slice(0, 160) });
      }
    }
  }

  private broadcast(scope: "bot" | "room", id: string, text: string): void {
    // Bot-scope stops land in the bot's (single) room; room-scope already
    // wrote via rooms.pause.
    if (scope === "bot") {
      const room = this.store.state.rooms.find((r) => r.members.includes(id));
      if (room !== undefined) {
        try { this.rooms.appendSystem(room.id, text); } catch { /* shutdown */ }
      }
    }
  }

  private nameOf(scope: "bot" | "room", id: string): string {
    return scope === "bot"
      ? (this.store.bot(id)?.name ?? id)
      : (this.store.room(id)?.name ?? id);
  }

  private audit(entry: Record<string, unknown>): void {
    try {
      appendFileSync(this.auditPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf8");
    } catch {
      /* best-effort; the ledger + room log carry the durable record */
    }
  }
}

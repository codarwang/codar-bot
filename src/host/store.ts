/**
 * state.json store — the single writer for roster/rooms/works
 * (architecture §3/§4).
 *
 * - Atomic persistence: write to a temp file in the same directory, fsync,
 *   rename over the target (crash never leaves a torn state).
 * - Cross-process lock: O_EXCL lockfile carrying pid+ts; stale after
 *   LOCK_STALE_MS (pid not alive ⇒ breakable). Single-writer discipline is
 *   primarily in-process (the host); the lock guards external editors and
 *   double-started hosts.
 * - schemaVersion + migrations: forward-only, each step a pure function.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const SCHEMA_VERSION = 1;

export interface BotModelRef {
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

export interface BotBudget {
  maxTokens: number;
  maxCostMicros: number;
  maxTurns: number;
  maxWallMs: number;
}

export interface BotRecord {
  id: string;
  name: string;
  role: string;
  chief: boolean;
  model: BotModelRef;
  workDir: string;
  sessionPath: string | null;
  sandbox: { mode: "docker" | "host-not-isolated" };
  budget: BotBudget;
}

export interface RoomRecord {
  id: string;
  name: string;
  members: string[];
  admin: string;
  mode: "admin-reply" | "round-robin";
  sharedDir: string;
  budget: BotBudget;
  goal: string | null;
  guards: { pingPongN: number; replyTimeoutMs: number };
  status: "active" | "paused";
  /** Why a paused room is paused (persisted so a restart keeps budget stops
   *  un-liftable by user messages, §5.3). Absent = unknown/none. */
  pauseReason?: "ping-pong" | "budget" | "manual" | null;
  /** When the current pause started (ISO). Durable month stamp for the
   *  §5.3 next-month auto-resume — survives host restarts (M2-C R4 P3). */
  pausedAt?: string | null;
}

export interface WorkRecord {
  id: string;
  parent: string;
  child: string;
  requestId: string;
  status: "pending" | "working" | "done" | "failed" | "rejected";
  /** null = not room-scoped; "" is never used (M2-B R1 P3 sentinel cleanup). */
  roomId: string | null;
  /** The task text — persisted so pending works are retryable across
   *  restarts and idle-transitions (M2-B R1 P1-2). */
  task: string;
}

export interface StateDoc {
  schemaVersion: number;
  bots: BotRecord[];
  rooms: RoomRecord[];
  works: WorkRecord[];
  reviewModel: BotModelRef | null;
}

export function emptyState(): StateDoc {
  return {
    schemaVersion: SCHEMA_VERSION,
    bots: [],
    rooms: [],
    works: [],
    reviewModel: null,
  };
}

export function defaultBudget(): BotBudget {
  return { maxTokens: 5_000_000, maxCostMicros: 20_000_000, maxTurns: 2_000, maxWallMs: 3_600_000 };
}

// --- migrations (forward-only; SCHEMA_VERSION is the target) ----------------

type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;
const MIGRATIONS: Record<number, Migration> = {
  // 0→1: nothing yet — v1 is the birth schema. The machinery stays so the
  // first real migration is a one-entry change, not new plumbing.
};

function migrate(doc: Record<string, unknown>): { doc: StateDoc; migrated: boolean } {
  let current = doc;
  let migrated = false;
  let from = typeof current["schemaVersion"] === "number" ? (current["schemaVersion"] as number) : 0;
  if (from > SCHEMA_VERSION) {
    throw new Error(`state.json schemaVersion ${from} is newer than this host knows (${SCHEMA_VERSION}) — upgrade codar-bot first`);
  }
  while (from < SCHEMA_VERSION) {
    const step = MIGRATIONS[from];
    current = step ? step(current) : current;
    from += 1;
    migrated = true;
  }
  return { doc: current as unknown as StateDoc, migrated };
}

// --- lock --------------------------------------------------------------------

interface LockHandle {
  release(): void;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireLock(lockPath: string): LockHandle {
  mkdirSync(dirname(lockPath), { recursive: true });
  const tryCreate = (): boolean => {
    try {
      // Payload written through the SAME wx fd — no TOCTOU window between
      // create and write for a concurrent breaker to observe/clobber.
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, `${JSON.stringify({ pid: process.pid, ts: Date.now() })}\n`);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  };
  const release = (): void => {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  };
  if (tryCreate()) return { release };
  // Existing lock: breakable ONLY when the owning pid is provably dead (or
  // the lock is unreadable garbage). A LIVE pid holds the lock regardless of
  // age — hosts are long-lived daemons; wall time proves nothing (R1 fix).
  let info: { pid?: number; ts?: number } = {};
  try {
    info = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number; ts?: number };
  } catch {
    /* unreadable — breakable */
  }
  if (typeof info.pid === "number" && isPidAlive(info.pid)) {
    throw new Error(`state.json is locked by live pid ${info.pid}`);
  }
  try {
    unlinkSync(lockPath);
  } catch {
    /* racing another breaker — the wx create below arbitrates */
  }
  if (!tryCreate()) {
    throw new Error("state.json lock race lost to another writer");
  }
  // Unlink-after-recreate guard (R2 P3-3): if a concurrent breaker's unlink
  // removed OUR just-created lock, the re-read mismatches — refuse rather
  // than run split-brained.
  try {
    const verify = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
    if (verify.pid !== process.pid) {
      throw new Error("state.json lock was stolen mid-acquisition");
    }
  } catch (error) {
    try { unlinkSync(lockPath); } catch { /* gone */ }
    if (error instanceof Error && error.message.includes("stolen")) throw error;
    throw new Error("state.json lock verification failed");
  }
  return { release };
}

// --- store -------------------------------------------------------------------

export class Store {
  private doc: StateDoc;
  private readonly lock: LockHandle | null;

  private constructor(
    public readonly statePath: string,
    doc: StateDoc,
    lock: LockHandle | null
  ) {
    this.doc = doc;
    this.lock = lock;
  }

  static open(statePath: string, opts: { create?: boolean } = {}): Store {
    mkdirSync(dirname(statePath), { recursive: true });
    let raw: Record<string, unknown> | null = null;
    if (existsSync(statePath)) {
      try {
        raw = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      } catch (error) {
        throw new Error(`state at ${statePath} is not valid JSON (${String(error).slice(0, 120)})`);
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`state at ${statePath} is not a JSON object`);
      }
    } else if (opts.create !== true) {
      throw new Error(`no state at ${statePath} (call open(..., {create:true}) to initialize)`);
    }
    const { doc, migrated } = raw ? migrate(raw) : { doc: emptyState(), migrated: false };
    // §5.5 restart sweep: pending/working works cannot survive a host
    // restart (their runners died) — mark failed, never guess (M2-B R1 P1-2).
    // A sweep that changed anything persists immediately (disk never keeps a
    // zombie "working" — M2-B R2 P3).
    let swept = false;
    for (const w of doc.works) {
      if (w.status === "pending" || w.status === "working") { w.status = "failed"; swept = true; }
    }
    const store = new Store(statePath, doc, null);
    if (!raw || migrated || swept) store.persist();
    return store;
  }

  /** Exclusive-writer open: one process owns mutations. */
  static openExclusive(statePath: string, opts: { create?: boolean } = {}): Store {
    const store = Store.open(statePath, opts);
    const lock = acquireLock(`${statePath}.lock`);
    return new Store(statePath, store.doc, lock);
  }

  get state(): StateDoc {
    return this.doc;
  }

  bot(id: string): BotRecord | undefined {
    return this.doc.bots.find((b) => b.id === id);
  }

  room(id: string): RoomRecord | undefined {
    return this.doc.rooms.find((r) => r.id === id);
  }

  chief(): BotRecord | undefined {
    return this.doc.bots.find((b) => b.chief);
  }

  addBot(bot: Omit<BotRecord, "id"> & { id?: string }): BotRecord {
    if (bot.chief && this.chief() !== undefined) {
      throw new Error("a chief bot already exists (single-chief invariant)");
    }
    const record: BotRecord = { ...bot, id: bot.id ?? `bot_${randomUUID().slice(0, 8)}` };
    if (this.doc.bots.some((b) => b.name === record.name)) {
      throw new Error(`bot name "${record.name}" already in use`);
    }
    this.doc.bots.push(record);
    this.persist();
    return record;
  }

  updateBot(id: string, patch: Partial<Omit<BotRecord, "id">>): BotRecord {
    const idx = this.doc.bots.findIndex((b) => b.id === id);
    if (idx === -1) throw new Error(`no bot ${id}`);
    this.doc.bots[idx] = { ...this.doc.bots[idx]!, ...patch };
    this.persist();
    return this.doc.bots[idx]!;
  }

  addWork(work: Omit<WorkRecord, never> & { id: string }): WorkRecord {
    this.doc.works.push(work);
    this.persist();
    return work;
  }

  updateWork(id: string, patch: Partial<Omit<WorkRecord, "id">>): WorkRecord | undefined {
    const idx = this.doc.works.findIndex((w) => w.id === id);
    if (idx === -1) return undefined;
    this.doc.works[idx] = { ...this.doc.works[idx]!, ...patch };
    this.persist();
    return this.doc.works[idx];
  }

  removeBot(id: string): void {
    this.doc.bots = this.doc.bots.filter((b) => b.id !== id);
    this.persist();
  }

  addRoom(room: Omit<RoomRecord, "id" | "guards" | "status"> & Partial<Pick<RoomRecord, "guards" | "status">>): RoomRecord {
    const record: RoomRecord = {
      guards: { pingPongN: 4, replyTimeoutMs: 180_000 }, // D4 factory defaults
      status: "active",
      ...room,
      id: `room_${randomUUID().slice(0, 8)}`,
    };
    this.doc.rooms.push(record);
    this.persist();
    return record;
  }

  updateRoom(id: string, patch: Partial<Omit<RoomRecord, "id">>): RoomRecord {
    const idx = this.doc.rooms.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error(`no room ${id}`);
    this.doc.rooms[idx] = { ...this.doc.rooms[idx]!, ...patch };
    this.persist();
    return this.doc.rooms[idx]!;
  }

  /** Atomic persistence: tmp file → fsync → chmod 0600 → rename (§3/§8). */
  persist(): void {
    const tmp = `${this.statePath}.tmp-${process.pid}-${randomUUID().slice(0, 6)}`;
    const payload = JSON.stringify(this.doc, null, 2);
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, payload + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.statePath);
  }

  close(): void {
    this.lock?.release();
  }
}

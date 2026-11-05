/**
 * memory — three-scope auto-reviewed memory (architecture §3 memory module,
 * §4 memory/ layout, §5.1a tail injection; PRD 2.3 / M2-2.3).
 *
 * Scopes: bot (private) / room (shared by members) / team (global). Each
 * scope is a fixed-shape Markdown tree on disk:
 *
 *   memory/bots/<botId>/{entry.md, main.md, topics/*.md, pending.jsonl, reviews.log}
 *   memory/rooms/<roomId>/…
 *   team/…
 *
 * Lifecycle per real turn settle:
 *   ingestTurn()  → the turn lands in pending.jsonl (durable; a restart keeps
 *                   un-reviewed turns — degradation, never corruption)
 *   schedule()    → single-flight review per scope (turns arriving mid-review
 *                   just accumulate; the next pass consumes them)
 *   review()      → a SHORT-LIVED review child (reviewModel, fallback = the
 *                   scope owner's own model) rewrites the files from
 *                   (current files + pending turns); output is parsed in a
 *                   strict <<<FILE path>>> format, size-capped, all-or-nothing
 *                   written; usage lands in the ledger under the scope id with
 *                   kind=memory-review (§4 台账).
 *
 * Snapshot freeze (§5.1a): snapshot() returns the on-disk files verbatim and
 * is byte-stable between reviews — files are the frozen snapshot; only a
 * completed review (or a manual API edit) changes them, so injected prompts
 * stay prefix-cache-friendly.
 *
 * Fail-safe: a malformed/oversized review output keeps the old files AND the
 * pending turns (the next review retries), audited as memory-review-rejected
 * — memory never regresses on a bad model day.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Store, BotModelRef } from "./store.js";
import type { UsageLedger } from "./usage-ledger.js";
import { RpcClient } from "../driver/rpc-client.js";
import { buildSpawnConfig, materializePiConf, loadKeys } from "./provider-config.js";

export type MemoryScope = "bot" | "room" | "team";

/** Fixed layer size discipline (§4 固定尺寸分层) — prompt-declared, and
 *  enforced as a hard reject at 2× (a file double its budget means the model
 *  ignored the format; keep the old tree rather than accept bloat). */
const LIMITS = {
  "entry.md": 2_000,
  "main.md": 20_000,
  topic: 8_000,
  topicsMax: 8,
} as const;

/** Team-scope reviews batch: team turns are low-signal per-room events, so
 *  the team review fires only when this many turns are pending. */
const TEAM_REVIEW_THRESHOLD = 5;

/** Review child wall clock: a review that cannot finish in 3 minutes is
 *  aborted and retried on the next settle (pending is kept). */
const REVIEW_WALL_MS = 3 * 60_000;

const HOUR_NOW = (): string => new Date().toISOString().slice(0, 13);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export interface TurnRecord {
  ts: string;
  speaker: string;
  text: string;
}

export interface MemoryFile {
  path: string; // "entry.md" | "main.md" | "topics/<slug>.md"
  content: string;
}

interface SpawnDefaults {
  bin?: string;
  sandboxArgv?: string[];
  env: Record<string, string>;
}

/** Atomic write: tmp → fsync → rename (store.ts 同款纪律). */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${randomUUID().slice(0, 6)}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export class MemoryEngine {
  private readonly root: string;
  private readonly keysPath: string;
  /** Byte-stable snapshot cache — invalidated on ANY write (freeze). */
  private readonly snapshotCache = new Map<string, string>();
  /** Single-flight review per scope key. */
  private readonly reviewing = new Set<string>();
  private readonly auditPath: string;

  constructor(
    private readonly store: Store,
    private readonly ledger: UsageLedger,
    dataRoot: string,
    private readonly spawn: SpawnDefaults
  ) {
    this.root = join(dataRoot, "memory");
    this.keysPath = join(dataRoot, "keys.json");
    this.auditPath = join(dataRoot, "audit.jsonl");
    mkdirSync(this.root, { recursive: true });
  }

  // --- paths ----------------------------------------------------------------------

  scopeDir(scope: MemoryScope, id: string): string {
    // `id` is ignored for the global team scope.
    return scope === "team" ? join(this.root, "team") : join(this.root, `${scope}s`, id);
  }

  private scopeKey(scope: MemoryScope, id: string): string {
    return `${scope}:${id}`;
  }

  private scopeLabel(scope: MemoryScope, id: string): string {
    if (scope === "bot") return this.store.bot(id)?.name ?? id;
    if (scope === "room") return `room ${this.store.room(id)?.name ?? id}`;
    return "team";
  }

  private pendingPath(scope: MemoryScope, id: string): string {
    return join(this.scopeDir(scope, id), "pending.jsonl");
  }

  // --- snapshot (§5.1a frozen injection) -------------------------------------------

  /**
   * The frozen memory snapshot for injection — the on-disk files rendered
   * verbatim, "" when the scope has no memory yet (nothing injected). The
   * cache guarantees byte-stability between mutations.
   */
  snapshot(scope: MemoryScope, id: string): string {
    const key = this.scopeKey(scope, id);
    const cached = this.snapshotCache.get(key);
    if (cached !== undefined) return cached;
    const parts: string[] = [];
    const dir = this.scopeDir(scope, id);
    for (const rel of this.listFiles(scope, id)) {
      let content = "";
      try {
        content = readFileSync(join(dir, rel), "utf8");
      } catch {
        continue; // raced a review rewrite; treat as absent this call
      }
      if (content.trim().length === 0) continue;
      parts.push(rel === "entry.md" ? "#### entry" : rel === "main.md" ? "#### main" : `#### ${rel}`);
      parts.push(content.trimEnd());
    }
    const text = parts.length > 0 ? `### Memory — ${this.scopeLabel(scope, id)}\n${parts.join("\n\n")}` : "";
    this.snapshotCache.set(key, text);
    return text;
  }

  private listFiles(scope: MemoryScope, id: string): string[] {
    const dir = this.scopeDir(scope, id);
    const out: string[] = [];
    for (const rel of ["entry.md", "main.md"] as const) {
      if (existsSync(join(dir, rel))) out.push(rel);
    }
    const topicsDir = join(dir, "topics");
    if (existsSync(topicsDir)) {
      for (const f of readdirSync(topicsDir).sort()) {
        if (f.endsWith(".md")) out.push(`topics/${f}`);
      }
    }
    return out;
  }

  /** All files with contents (API surface for the UI, PRD 2.3 可管理). */
  files(scope: MemoryScope, id: string): MemoryFile[] {
    const dir = this.scopeDir(scope, id);
    return this.listFiles(scope, id).map((path) => {
      let content = "";
      try {
        content = readFileSync(join(dir, path), "utf8");
      } catch {
        /* raced a review; report what we read */
      }
      return { path, content };
    });
  }

  /** Manual edit (API): whitelisted path only; invalidates the freeze cache. */
  writeFile(scope: MemoryScope, id: string, path: string, content: string): void {
    if (!isValidMemoryPath(path)) throw new Error(`invalid memory path "${path}"`);
    const abs = join(this.scopeDir(scope, id), path);
    mkdirSync(dirname(abs), { recursive: true });
    atomicWrite(abs, content.endsWith("\n") ? content : `${content}\n`);
    this.snapshotCache.delete(this.scopeKey(scope, id));
  }

  // --- ingest + scheduling ----------------------------------------------------------

  /** Record a settled turn for later review (durable across restarts). */
  ingestTurn(scope: MemoryScope, id: string, turn: TurnRecord): void {
    const dir = this.scopeDir(scope, id);
    mkdirSync(dir, { recursive: true });
    appendFileSync(this.pendingPath(scope, id), `${JSON.stringify(turn)}\n`, "utf8");
  }

  pendingCount(scope: MemoryScope, id: string): number {
    try {
      return readFileSync(this.pendingPath(scope, id), "utf8").split("\n").filter((l) => l.trim().length > 0).length;
    } catch {
      return 0;
    }
  }

  /**
   * Schedule a review for a scope if one is not already running. Policy:
   * bot/room review per settle; team reviews batch at TEAM_REVIEW_THRESHOLD.
   * A budget-paused room does not review (no spend while §5.5-held).
   */
  schedule(scope: MemoryScope, id: string): void {
    const key = this.scopeKey(scope, id);
    if (this.reviewing.has(key)) return;
    if (this.reviewBlocked(scope, id)) return;
    if (scope === "team" && this.pendingCount(scope, id) < TEAM_REVIEW_THRESHOLD) return;
    if (this.pendingCount(scope, id) === 0) return;
    this.reviewing.add(key);
    void this.review(scope, id)
      .catch(() => undefined) // review() audits its own failures
      .finally(() => {
        this.reviewing.delete(key);
      });
  }

  private reviewBlocked(scope: MemoryScope, id: string): boolean {
    if (scope === "room") {
      const room = this.store.room(id);
      return room?.status === "paused" && (room.pauseReason ?? "budget") === "budget";
    }
    if (scope === "bot") return this.store.bot(id) === undefined;
    return false;
  }

  // --- review ----------------------------------------------------------------------

  /** Which model reviews this scope: the global reviewModel slot (D3) or,
   *  unconfigured, the scope OWNER's own model (bot → itself; room → admin;
   *  team → chief). No owner and no slot ⇒ null (review audited as skipped). */
  resolveReviewModel(scope: MemoryScope, id: string): BotModelRef | null {
    const global = this.store.state.reviewModel;
    if (global !== null && global.modelId !== "") return global;
    if (scope === "bot") return this.store.bot(id)?.model ?? null;
    if (scope === "room") {
      const admin = this.store.room(id)?.admin;
      return admin !== undefined ? (this.store.bot(admin)?.model ?? null) : null;
    }
    const chief = this.store.state.bots.find((b) => b.chief);
    return chief?.model ?? null;
  }

  /**
   * Run one review pass for a scope. All-or-nothing: files are written only
   * when the parsed output fully validates; pending is cleared only on
   * success. Failure paths audit and keep everything for the next pass.
   */
  async review(scope: MemoryScope, id: string): Promise<"reviewed" | "skipped" | "rejected" | "failed"> {
    const key = this.scopeKey(scope, id);
    const pending = this.readPending(scope, id);
    if (pending.length === 0) return "skipped";

    const model = this.resolveReviewModel(scope, id);
    if (model === null) {
      this.audit({ kind: "memory-review-skipped", scope, id, reason: "no review model configured" });
      return "skipped";
    }

    const dir = this.scopeDir(scope, id);
    mkdirSync(dir, { recursive: true });
    const prompt = this.renderReviewPrompt(scope, id, this.files(scope, id), pending);
    const outcome = await this.runReviewChild(scope, id, model, prompt);

    if (outcome.text === null) {
      this.audit({ kind: "memory-review-failed", scope, id, error: outcome.error ?? "no output" });
      return "failed";
    }
    const update = parseReviewOutput(outcome.text);
    if (update === null) {
      this.audit({ kind: "memory-review-rejected", scope, id, reason: "unparseable output" });
      return "rejected";
    }
    const err = validateUpdate(update);
    if (err !== null) {
      this.audit({ kind: "memory-review-rejected", scope, id, reason: err });
      return "rejected";
    }

    // All-or-nothing apply: writes first (atomic each), then pending clear,
    // then the durable review log.
    for (const f of update.files) this.writeFile(scope, id, f.path, f.content);
    for (const p of update.deletes) {
      try {
        unlinkSync(join(dir, p));
        this.snapshotCache.delete(key);
      } catch {
        /* already gone — the review log still records the intent */
      }
    }
    atomicWrite(this.pendingPath(scope, id), "");
    appendFileSync(join(dir, "reviews.log"), `${new Date().toISOString()} turns=${pending.length} files=${update.files.length} deletes=${update.deletes.length}\n`, "utf8");
    this.audit({ kind: "memory-review", scope, id, turns: pending.length, files: update.files.length });
    return "reviewed";
  }

  private readPending(scope: MemoryScope, id: string): TurnRecord[] {
    try {
      return readFileSync(this.pendingPath(scope, id), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as TurnRecord);
    } catch {
      return [];
    }
  }

  private renderReviewPrompt(scope: MemoryScope, id: string, files: MemoryFile[], pending: TurnRecord[]): string {
    const label = this.scopeLabel(scope, id);
    const filesBlock = files.length > 0
      ? files.map((f) => `--- ${f.path} ---\n${f.content.trim() || "(empty)"}`).join("\n\n")
      : "(no files yet — this is the first review)";
    const turns = pending.map((t) => `[${t.ts}] ${t.speaker}: ${t.text}`.slice(0, 2_000)).join("\n");
    return [
      "[codar memory review]",
      `You are the memory reviewer for ${label}. Update the memory files from the new turns below.`,
      "",
      "Output rules — follow EXACTLY:",
      "<<<FILE entry.md>>>",
      "(new full content)",
      "<<<FILE main.md>>>",
      "(new full content)",
      "<<<FILE topics/<slug>.md>>>",
      "(new full content; slug = lowercase a-z0-9-; max 8 topic files)",
      "To remove a topic file output a line: <<<DELETE topics/<slug>.md>>>",
      "Files you do not mention stay unchanged. End with <<<END>>>.",
      "Size limits: entry.md <= 2000 chars (durable identity/preferences/facts, compact),",
      "main.md <= 20000 chars (running narrative summary), each topic <= 8000 chars (stable subject files).",
      "Preserve the content's language (Chinese stays Chinese). Output ONLY the blocks.",
      "",
      "Current files:",
      filesBlock,
      "",
      `New turns since last review (${pending.length}):`,
      turns,
    ].join("\n");
  }

  /** One-shot review child: bare host-side pi run, no session, wall-clocked;
   *  usage rows land in the ledger under the SCOPE id (kind=memory-review). */
  private async runReviewChild(
    scope: MemoryScope,
    id: string,
    model: BotModelRef,
    prompt: string
  ): Promise<{ text: string | null; error?: string }> {
    const keys = loadKeys(this.keysPath);
    const cfg = buildSpawnConfig(keys, dirname(this.root), "memory-review", model.provider, model.modelId);
    materializePiConf(cfg);
    const usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; costTotal: number } = {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costTotal: 0,
    };
    let client: RpcClient | null = null;
    const timer = setTimeout(() => {
      void client?.abort().catch(() => undefined);
    }, REVIEW_WALL_MS);
    try {
      client = new RpcClient({
        bin: this.spawn.bin,
        argvPrefix: this.spawn.sandboxArgv,
        cwd: this.root,
        env: { ...this.spawn.env, ...cfg.env, PI_CODING_AGENT_DIR: cfg.piConfDir },
        idleTimeoutMs: REVIEW_WALL_MS,
        wallTimeoutMs: REVIEW_WALL_MS,
      });
      client.on("event", (e) => {
        if ((e as { type?: string }).type !== "message_end") return;
        const message = (e as { message?: { role?: string; usage?: Record<string, unknown>; stopReason?: string } }).message;
        if (message?.role === "assistant" && message.usage && message.stopReason !== "error") {
          const u = message.usage;
          usage.input += num(u.input);
          usage.output += num(u.output);
          usage.cacheRead += num(u.cacheRead);
          usage.cacheWrite += num(u.cacheWrite);
          usage.cacheWrite1h += num(u.cacheWrite1h);
          usage.costTotal += num((u.cost as { total?: unknown } | undefined)?.total);
        }
      });
      await client.start({
        model: `${model.provider}/${model.modelId}`,
        thinking: model.thinkingLevel,
        noSession: true,
      });
      const res = await client.command({ type: "prompt", message: prompt } as Record<string, unknown>);
      if (!res.success) return { text: null, error: `prompt rejected: ${String(res.error).slice(0, 160)}` };
      const last = await client.command({ type: "get_last_assistant_text" } as Record<string, unknown>);
      const text =
        last.success && typeof (last.data as { text?: unknown } | null)?.text === "string"
          ? (last.data as { text: string }).text
          : null;
      if (text !== null && text.trim().length > 0 && (usage.input > 0 || usage.output > 0)) {
        this.ledger.record({
          hour: HOUR_NOW(),
          botId: id, // scope id — bot_xxx / room_xxx / team (§4 台账 id 风格)
          model: `${model.provider}/${model.modelId}`,
          kind: "memory-review",
          input: usage.input, output: usage.output,
          cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cacheWrite1h: usage.cacheWrite1h,
          costMicros: Math.round(usage.costTotal * 1e6),
        });
      }
      return text !== null && text.trim().length > 0 ? { text } : { text: null, error: "empty review output" };
    } catch (error) {
      return { text: null, error: String(error).slice(0, 200) };
    } finally {
      clearTimeout(timer);
      client?.kill();
    }
  }

  private audit(entry: Record<string, unknown>): void {
    try {
      appendFileSync(this.auditPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf8");
    } catch {
      /* best-effort; reviews.log carries the durable per-scope record */
    }
  }
}

// --- pure helpers -----------------------------------------------------------------

const TOPIC_RE = /^topics\/[a-z0-9][a-z0-9-]*\.md$/;

export function isValidMemoryPath(path: string): boolean {
  return path === "entry.md" || path === "main.md" || TOPIC_RE.test(path);
}

export interface ReviewUpdate {
  files: MemoryFile[];
  deletes: string[];
}

/** Parse the strict <<<FILE path>>>… block format (with optional <<<DELETE>>>
 *  lines and a <<<END>>> terminator). Null when nothing parseable at all. */
export function parseReviewOutput(text: string): ReviewUpdate | null {
  const files: MemoryFile[] = [];
  const deletes: string[] = [];
  const fileRe = /<<<FILE (entry\.md|main\.md|topics\/[a-z0-9][a-z0-9-]*\.md)>>>\n([\s\S]*?)(?=\n<<<|$)/g;
  for (const m of text.matchAll(fileRe)) {
    const content = m[2]!.replace(/\n<<<END>>>.*$/s, "").trim();
    if (!files.some((f) => f.path === m[1])) files.push({ path: m[1]!, content });
  }
  for (const m of text.matchAll(/<<<DELETE (topics\/[a-z0-9][a-z0-9-]*\.md)>>>/g)) {
    if (!deletes.includes(m[1]!)) deletes.push(m[1]!);
  }
  return files.length > 0 || deletes.length > 0 ? { files, deletes } : null;
}

/** Hard caps at 2× the declared budget; also topic count and delete/format
 *  sanity. Returns null when valid, a reason string otherwise. */
export function validateUpdate(update: ReviewUpdate): string | null {
  const topics = update.files.filter((f) => f.path.startsWith("topics/"));
  if (topics.length > LIMITS.topicsMax) return `too many topics (${topics.length} > ${LIMITS.topicsMax})`;
  for (const f of update.files) {
    const cap = f.path === "entry.md" ? LIMITS["entry.md"] : f.path === "main.md" ? LIMITS["main.md"] : LIMITS.topic;
    if (f.content.length > cap * 2) return `${f.path} ${f.content.length} chars > 2x budget ${cap * 2}`;
  }
  for (const d of update.deletes) {
    if (!TOPIC_RE.test(d)) return `invalid delete path "${d}"`;
  }
  return null;
}

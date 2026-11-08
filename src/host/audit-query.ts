/**
 * audit-query — query-time merge of host audit.jsonl + per-bot gate-audit
 * JSONL files (M3.3, architecture m3-architecture.md §4).
 *
 * Both sources are append-only JSONL. The API reads the TAIL of each file
 * (bounded), parses lines (torn lines skipped), and returns a ts-descending
 * merged timeline with a `before` cursor. No cross-source dedup — see the
 * merge-step note below (known limitation).
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface AuditEntry {
  ts: string;
  kind: string;
  [key: string]: unknown;
}

export interface AuditQueryOptions {
  bot?: string;
  since?: string;
  kind?: string;
  limit?: number;
  /** Return only entries strictly BEFORE this ISO ts (cursor). */
  before?: string;
}

export interface AuditResult {
  entries: AuditEntry[];
  /** The oldest ts in this page (pass as `before` for the next page). */
  cursor: string | null;
  /** Total lines skipped (torn/corrupt). */
  skipped: number;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;
const TAIL_CHARS = 512 * 1024; // 512KB tail per file — bounded reads

function tailLines(path: string): string[] {
  try {
    const text = readFileSync(path, "utf8");
    if (text.length <= TAIL_CHARS) {
      return text.split("\n").filter((l) => l.trim().length > 0);
    }
    // Read the last TAIL_CHARS bytes
    const tail = text.slice(-TAIL_CHARS);
    // Drop the first (possibly torn) line
    const firstNl = tail.indexOf("\n");
    return (firstNl >= 0 ? tail.slice(firstNl + 1) : tail)
      .split("\n")
      .filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

function parseEntries(lines: string[], source: string): Array<AuditEntry & { _source: string }> {
  const out: Array<AuditEntry & { _source: string }> = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.ts === "string" && typeof parsed.kind === "string") {
        out.push({ ...parsed, ts: parsed.ts, kind: parsed.kind, _source: source });
      }
    } catch {
      // Torn/corrupt line — skip
    }
  }
  return out;
}

export class AuditQuery {
  private readonly hostAuditPath: string;
  private readonly piConfRoot: string;

  constructor(dataRoot: string) {
    this.hostAuditPath = join(dataRoot, "audit.jsonl");
    this.piConfRoot = join(dataRoot, "pi-conf");
  }

  /** All gate-audit files across bots (filesystem enumeration — includes
   *  deleted bots whose pi-conf dirs still exist). */
  private gateAuditPaths(): Array<{ path: string; botId: string }> {
    const out: Array<{ path: string; botId: string }> = [];
    if (!existsSync(this.piConfRoot)) return out;
    for (const entry of readdirSync(this.piConfRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = join(this.piConfRoot, entry.name, "gate-audit.jsonl");
      if (existsSync(p)) out.push({ path: p, botId: entry.name });
    }
    return out;
  }

  query(opts: AuditQueryOptions): AuditResult {
    const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(opts.limit!, MAX_LIMIT)) : DEFAULT_LIMIT;
    let skipped = 0;

    // 1. Collect from host audit
    const hostLines = tailLines(this.hostAuditPath);
    const hostEntries = parseEntries(hostLines, "host");
    skipped += hostLines.length - hostEntries.length;

    // 2. Collect from all gate-audit files
    const gateEntries: Array<AuditEntry & { _source: string }> = [];
    for (const { path, botId } of this.gateAuditPaths()) {
      const lines = tailLines(path);
      const entries = parseEntries(lines, "gate");
      skipped += lines.length - entries.length;
      // P2-3: gate-audit entries have no botId field — stamp it from the
      // pi-conf/<botId>/ directory name so ?bot= actually filters them.
      gateEntries.push(...entries.map((e) => ({ ...e, botId: (e.botId as string | undefined) ?? botId })));
    }

    const merged: Array<AuditEntry & { _source: string }> = [];
    // 3. Merge (P2-6 known limitation: the host approval rows carry the
    // ui-request randomUUID while gate rows carry event.toolCallId — two
    // different IDs for the same approval; cross-source dedup by key is
    // not implementable without a protocol change. Each approval appears
    // as two rows (both kind:"approval"): host outcome + gate detail.)
    merged.push(...hostEntries, ...gateEntries);

    // 4. Filter
    let filtered = merged;
    if (opts.bot !== undefined) {
      filtered = filtered.filter((e) => {
        const eBot = (e.botId as string | undefined) ?? (e.bot_id as string | undefined);
        return eBot === opts.bot;
      });
    }
    if (opts.kind !== undefined) {
      filtered = filtered.filter((e) => e.kind === opts.kind);
    }
    if (opts.since !== undefined) {
      filtered = filtered.filter((e) => e.ts >= opts.since!);
    }
    if (opts.before !== undefined) {
      filtered = filtered.filter((e) => e.ts < opts.before!);
    }

    // 5. Sort ts descending, take top N
    filtered.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    const page = filtered.slice(0, limit);

    // 6. Strip _source from the output
    const entries: AuditEntry[] = page.map(({ _source: _s, ...rest }) => { void _s; return rest; });

    return {
      entries,
      cursor: page.length === limit ? page[page.length - 1]!.ts : null,
      skipped,
    };
  }
}

/**
 * M0-S3 spike runner — usage metering acceptance criteria
 * (architecture.md §9 S3):
 *
 *  ① cross-check: ≥2 prompts in ONE session; the sum of message_end.usage
 *     events reconciles with get_session_stats (tokens AND cost)
 *  ② field reality: cacheWrite1h presence, cost unit semantics (USD decimal
 *     vs micros), totalFromProvider flag — recorded; §4 revised if needed
 *  ③ set_auto_retry on/off round-trips at the response level
 *  ④ custom provider chain: PI_CODING_AGENT_DIR + models.json with $ENV key
 *     interpolation drives a real OpenAI-compatible call (deepseek);
 *     cost=0 ⇒ "token-budget fallback" risk recorded
 *  ⑤ usage.sqlite: the §4 schema ingests the observed records and queries
 *     back (node:sqlite DatabaseSync)
 *
 * Writes spike/s3-report.md; exits non-zero on failure.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { RpcClient, type AgentEvent } from "../src/driver/rpc-client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = resolve(HERE, "../extensions/codar-gate/codar-gate.ts");

interface Criterion { id: string; title: string; pass: boolean; evidence: string[]; }
const criteria: Criterion[] = [];
function record(id: string, title: string, pass: boolean, evidence: string[]): void {
  criteria.push({ id, title, pass, evidence });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id} ${title}`);
  for (const line of evidence) console.log(`      ${line}`);
}

interface UsageShape {
  input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
  cacheWrite1h?: number; reasoning?: number; totalTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number; totalFromProvider?: boolean };
}

function messageEndUsages(events: AgentEvent[]): UsageShape[] {
  const out: UsageShape[] = [];
  for (const e of events) {
    if (e.type !== "message_end") continue;
    const message = (e as { message?: { role?: string; usage?: UsageShape } }).message;
    if (message?.role === "assistant" && message.usage) out.push(message.usage);
  }
  return out;
}

const num = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

async function criterion123(): Promise<{ usages: UsageShape[]; costScaleHint: string }> {
  const dir = mkdtempSync(join(tmpdir(), "codar-s3-"));
  const events: AgentEvent[] = [];
  const client = new RpcClient({
    cwd: dir,
    env: { CODAR_GATE_AUDIT: join(dir, "audit.jsonl") },
    idleTimeoutMs: 240_000,
    wallTimeoutMs: 12 * 60_000,
    onUiRequest: (req) => {
      if (req.method === "confirm") {
        client.replyUi({ type: "extension_ui_response", id: req.id, confirmed: true });
      }
    },
  });
  client.on("event", (e: AgentEvent) => events.push(e));
  let usages: UsageShape[] = [];
  try {
    // Session mode: get_session_stats reconciliation needs the session's
    // in-memory counters (--no-session keeps nothing on disk but stats work;
    // verified by this very run).
    await client.start({ extensionPath: EXTENSION, thinking: "low" });

    // ③ set_auto_retry round-trip
    const off = await client.command({ type: "set_auto_retry", enabled: false } as Record<string, unknown>);
    const on = await client.command({ type: "set_auto_retry", enabled: true } as Record<string, unknown>);
    record("③", "set_auto_retry off/on round-trip at response level",
      off.success && on.success,
      [`set_auto_retry(false): ${off.success}`, `set_auto_retry(true): ${on.success}`]);

    let settled = false;
    client.on("settled", () => { settled = true; });
    for (const message of [
      "Reply with the single word ALPHA.",
      "Now reply with the single word BRAVO.",
    ]) {
      settled = false;
      const pr = await client.prompt(message);
      if (!pr.success) throw new Error(`prompt rejected: ${pr.error}`);
      const deadline = Date.now() + 5 * 60_000;
      while (!settled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
      if (!settled) throw new Error("agent never settled");
    }
    usages = messageEndUsages(events);
    const stats = await client.command({ type: "get_session_stats" } as Record<string, unknown>);
    const data = stats.success ? (stats.data as {
      tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
      cost?: number;
    }) : null;

    if (!data) {
      record("①", "message_end.usage sums == get_session_stats", false, ["get_session_stats failed"]);
      return { usages, costScaleHint: "n/a" };
    }
    const sum = {
      input: usages.reduce((a, u) => a + num(u.input), 0),
      output: usages.reduce((a, u) => a + num(u.output), 0),
      cacheRead: usages.reduce((a, u) => a + num(u.cacheRead), 0),
      cacheWrite: usages.reduce((a, u) => a + num(u.cacheWrite), 0),
      totalTokens: usages.reduce((a, u) => a + num(u.totalTokens), 0),
    };
    const costSum = usages.reduce((a, u) => a + num(u.cost?.total), 0);
    const t = data.tokens ?? {};
    const tokenOk =
      sum.input === num(t.input) && sum.output === num(t.output) &&
      sum.cacheRead === num(t.cacheRead) && sum.cacheWrite === num(t.cacheWrite) &&
      (num(t.total) === 0 || sum.totalTokens === num(t.total)); // total dimension when reported
    const costOk = Math.abs(costSum - num(data.cost)) < 1e-9;
    record("①", "message_end.usage sums == get_session_stats (tokens + cost)",
      tokenOk && costOk && usages.length >= 2,
      [
        `assistant usage reports: ${usages.length} (need ≥2)`,
        `sum  input=${sum.input} output=${sum.output} cacheRead=${sum.cacheRead} cacheWrite=${sum.cacheWrite} totalTokens=${sum.totalTokens} cost=${costSum}`,
        `stat input=${num(t.input)} output=${num(t.output)} cacheRead=${num(t.cacheRead)} cacheWrite=${num(t.cacheWrite)} total=${num(t.total)} cost=${num(data.cost)}`,
        `tokens match: ${tokenOk}; cost match: ${costOk}`,
      ]);

    // ② field reality
    const with1h = usages.filter((u) => typeof u.cacheWrite1h === "number").length;
    const withFromProvider = usages.filter((u) => u.cost?.totalFromProvider === true).length;
    const perMsgCost = usages.map((u) => num(u.cost?.total));
    const costScaleHint = perMsgCost.length > 0 && perMsgCost.some((c) => c > 0 && c < 1)
      ? "USD-decimal (values < 1 ⇒ architecture §4 micros conversion round(usd*1e6) applies)"
      : perMsgCost.some((c) => c > 1000)
        ? "possibly-micros (large values — CHECK before §4 conversion)"
        : "zero-or-unknown (no positive cost observed)";
    record("②", "usage field reality: cacheWrite1h presence, cost unit, totalFromProvider",
      true, // observational criterion: records what IS
      [
        `usage reports with cacheWrite1h: ${with1h}/${usages.length} (provider-dependent; zai/glm may not report)`,
        `cost.totalFromProvider=true: ${withFromProvider}/${usages.length}`,
        `per-message cost.total: ${JSON.stringify(perMsgCost)}`,
        `cost unit read: ${costScaleHint}`,
      ]);
    return { usages, costScaleHint };
  } finally {
    client.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function criterion4Custom(): Promise<void> {
  // Custom provider chain: PI_CODING_AGENT_DIR + models.json + $ENV key.
  // Round-1 review proved deepseek is OUT OF BALANCE (402) — use the funded
  // zai endpoint as the custom target so the chain drives a REAL successful
  // call (which is what lets us also verify catalog-price cost behavior).
  const auth = JSON.parse(readFileSync(join(process.env.HOME!, ".pi/agent/auth.json"), "utf8")) as Record<
    string,
    { apiKey?: string; key?: string } | string | undefined
  >;
  const zaiEntry = auth["zai-coding-cn"];
  const zaiKey = typeof zaiEntry === "string" ? zaiEntry : (zaiEntry?.apiKey ?? zaiEntry?.key);
  if (!zaiKey) {
    record("④", "custom provider chain (PI_CODING_AGENT_DIR + models.json + $ENV)", false, [
      "no zai-coding-cn key in ~/.pi/agent/auth.json — cannot drive a funded custom call",
    ]);
    return;
  }
  const confDir = mkdtempSync(join(tmpdir(), "codar-s3-conf-"));
  const workDir = mkdtempSync(join(tmpdir(), "codar-s3-work-"));
  mkdirSync(confDir, { recursive: true });
  // models.json in the redirected agent dir; apiKey via $ENV interpolation
  // (key never lands in the file — that IS the mechanism under test).
  writeFileSync(join(confDir, "models.json"), JSON.stringify({
    providers: {
      s3custom: {
        api: "openai-completions",
        baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
        apiKey: "$S3_TEST_KEY",
        models: [{
          id: "glm-5.3",
          name: "GLM-5.3 (s3 custom chain)",
          input: ["text"],
          cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8_192,
          type: "chat",
        }],
      },
    },
  }, null, 2));

  const events: AgentEvent[] = [];
  const failures: string[] = [];
  const client = new RpcClient({
    cwd: workDir,
    env: {
      PI_CODING_AGENT_DIR: confDir,
      S3_TEST_KEY: zaiKey,
      CODAR_GATE_AUDIT: join(workDir, "audit.jsonl"),
    },
    idleTimeoutMs: 240_000,
    wallTimeoutMs: 8 * 60_000,
  });
  client.on("event", (e: AgentEvent) => events.push(e));
  client.on("bot_failed", (f) => failures.push(JSON.stringify(f).slice(0, 200)));
  client.on("stderr", (s: string) => { if (/error|fail/i.test(s)) failures.push(s.slice(0, 200)); });
  try {
    await client.start({ extensionPath: EXTENSION, model: "s3custom/glm-5.3" });
    let settled = false;
    client.on("settled", () => { settled = true; });
    const pr = await client.prompt("Reply with the single word CUSTOM.");
    if (!pr.success) throw new Error(`prompt rejected: ${pr.error}`);
    const deadline = Date.now() + 5 * 60_000;
    while (!settled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));

    // STRONG assertion (round-1 fix): an errored call also emits an assistant
    // message_end with an all-zero usage object — usage presence alone proved
    // nothing. Require: no bot_failed, last stopReason not error, real output.
    const last = await client.command({ type: "get_last_assistant_text" } as Record<string, unknown>);
    const lastText =
      last.success && typeof (last.data as { text?: unknown } | null)?.text === "string"
        ? (last.data as { text: string }).text
        : "";
    const errored = events.some((e) => {
      if (e.type !== "message_end") return false;
      const m = (e as { message?: { role?: string; stopReason?: string } }).message;
      return m?.role === "assistant" && m.stopReason === "error";
    });
    const usages = messageEndUsages(events);
    const outputTokens = usages.reduce((a, u) => a + num(u.output), 0);
    const costs = usages.map((u) => num(u.cost?.total));
    const costNonZero = costs.some((c) => c > 0);
    const pass = failures.length === 0 && !errored && outputTokens > 0 && lastText.length > 0;
    record("④", "custom provider chain drives a REAL successful OpenAI-compatible call", pass,
      [
        `PI_CODING_AGENT_DIR redirect + models.json + $S3_TEST_KEY interpolation: ${pass ? "worked end-to-end" : "FAILED"}`,
        `output tokens: ${outputTokens}; last text: ${JSON.stringify(lastText.slice(0, 60))}; errored message_end: ${errored}; bot_failed: ${failures.length}`,
        `cost.totals from models.json catalog price: ${JSON.stringify(costs)}`,
        costNonZero
          ? "custom catalog price IS used for usage cost (calculateCost path confirmed empirically)"
          : "cost=0 despite a successful priced custom call — token-budget fallback boundary CONFIRMED",
      ]);
  } finally {
    client.kill();
    rmSync(confDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

function criterion5Sqlite(usages: UsageShape[]): void {
  const dir = mkdtempSync(join(tmpdir(), "codar-s3-db-"));
  try {
    const dbPath = join(dir, "usage.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE usage (
      hour TEXT NOT NULL, bot_id TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL,
      input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
      cache_write_1h INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (hour, bot_id, model, kind))`);
    const hour = new Date().toISOString().slice(0, 13);
    const insert = db.prepare(
      `INSERT INTO usage (hour, bot_id, model, kind, input, output, cache_read, cache_write, cache_write_1h, cost_micros)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hour, bot_id, model, kind) DO UPDATE SET
         input = input + excluded.input, output = output + excluded.output,
         cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write,
         cache_write_1h = cache_write_1h + excluded.cache_write_1h,
         cost_micros = cost_micros + excluded.cost_micros`
    );
    for (const u of usages) {
      insert.run(
        hour, "bot_s3", "zai-coding-cn/glm-5.3", "chat",
        num(u.input), num(u.output), num(u.cacheRead), num(u.cacheWrite),
        num(u.cacheWrite1h), Math.round(num(u.cost?.total) * 1e6)
      );
    }
    const row = db.prepare(
      `SELECT SUM(input) AS input, SUM(output) AS output, SUM(cost_micros) AS cost_micros FROM usage`
    ).get() as { input: number; output: number; cost_micros: number };
    db.close();
    const sumIn = usages.reduce((a, u) => a + num(u.input), 0);
    const sumOut = usages.reduce((a, u) => a + num(u.output), 0);
    // Rounding consistency (round-1 P3): ingest is sum-of-rounds, so the
    // expectation must be too (round-of-sum can differ by ±1 on ties).
    const sumCostMicros = usages.reduce((a, u) => a + Math.round(num(u.cost?.total) * 1e6), 0);
    const ok = row.input === sumIn && row.output === sumOut && row.cost_micros === sumCostMicros && existsSync(dbPath);
    record("⑤", "usage.sqlite §4 schema ingests and queries back", ok, [
      `rows ingested: ${usages.length}; aggregate input=${row.input} output=${row.output} cost_micros=${row.cost_micros}`,
      `expected input=${sumIn} output=${sumOut} cost_micros=${sumCostMicros}`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("S3 spike — usage metering\n");
  const runners: Array<[string, () => Promise<void>]> = [];
  let usages: UsageShape[] = [];
  let costScaleHint = "n/a";
  const step1 = async () => {
    const r = await criterion123();
    usages = r.usages;
    costScaleHint = r.costScaleHint;
  };
  runners.push(["①②③", step1], ["④", criterion4Custom]);
  for (const [id, run] of runners) {
    try { await run(); } catch (error) {
      record(id, `runner crashed — ${String(error).slice(0, 300)}`, false, [String(error).slice(0, 800)]);
    }
  }
  try { criterion5Sqlite(usages); } catch (error) {
    record("⑤", `runner crashed — ${String(error).slice(0, 300)}`, false, [String(error).slice(0, 800)]);
  }

  const failed = criteria.filter((c) => !c.pass);
  const report = [
    "# M0-S3 Spike Report — usage metering",
    "",
    `Date: ${new Date().toISOString()}`,
    `pi: 1.5.0 · providers: zai-coding-cn/glm-5.3 (main) + deepseek via custom chain`,
    `cost unit read: ${costScaleHint}`,
    "",
    "## Verdicts",
    "",
  ];
  for (const c of criteria) {
    report.push(`### ${c.pass ? "✅" : "❌"} ${c.id} ${c.title}`);
    for (const e of c.evidence) report.push(`- ${e}`);
    report.push("");
  }
  report.push(`## Result: ${failed.length === 0 ? "ALL PASS — S3 gate OPEN" : `${failed.length} FAILED — S3 gate CLOSED`}`);
  writeFileSync(join(HERE, "s3-report.md"), report.join("\n") + "\n", "utf8");
  console.log("\nreport: spike/s3-report.md");
  if (failed.length > 0) process.exit(1);
}

void main().catch((e) => {
  writeFileSync(join(HERE, "s3-report.md"), `# M0-S3 Spike Report\n\nCRASHED: ${String(e).slice(0, 800)}\n`, "utf8");
  console.error("spike crashed:", e);
  process.exit(2);
});

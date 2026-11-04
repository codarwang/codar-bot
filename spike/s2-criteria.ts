/**
 * M0-S2 spike runner — proves the four architecture §9 S2 acceptance criteria
 * against a REAL pi 1.5.0 subprocess (real model call on the configured
 * provider, default zai-coding-cn/glm-5.3 at --thinking low to keep cost
 * minimal; four small calls total).
 *
 *  ① write-file approval: deny ⇒ file NOT written; approve ⇒ written;
 *     audit lines (tool_call + approval) persisted (deny and approve are
 *     separate fresh sessions)
 *  ② structured ui round-trip: bridge_echo params OUT as input-dialog
 *     placeholder JSON, host structured reply BACK as the value, tool result
 *     carries the marker (the D1 message_bot channel premise)
 *  ③ long park: confirm parked ≥60s; a get_state command still answers
 *     while parked; subprocess survives and completes after the reply
 *  ④ ready sequence: the exact stdout record sequence from spawn to the
 *     first successful get_state response, recorded into the report
 *
 * Writes spike/s2-report.md and exits non-zero on any criterion failure.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient, type UiRequest, type AgentEvent } from "../src/driver/rpc-client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = resolve(HERE, "../extensions/codar-gate/codar-gate.ts");
const PARK_MS = 60_000;

interface Criterion {
  id: string;
  title: string;
  pass: boolean;
  evidence: string[];
}

const criteria: Criterion[] = [];
function record(id: string, title: string, pass: boolean, evidence: string[]): void {
  criteria.push({ id, title, pass, evidence });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id} ${title}`);
  for (const line of evidence) console.log(`      ${line}`);
}

interface SessionResult {
  events: AgentEvent[];
  uiRequests: UiRequest[];
  lastText: string | null;
  stderr: string[];
}

interface SessionConfig {
  name: string;
  prompt: string;
  /** Handle each ui request; must eventually reply or the run idles out. */
  onUi: (req: UiRequest, client: RpcClient) => void;
  /** Capture the ready record sequence for the first session only. */
  captureReady?: { records: string[] };
}

async function runSession(cfg: SessionConfig): Promise<{ dir: string; result: SessionResult }> {
  const dir = mkdtempSync(join(tmpdir(), "codar-s2-"));
  const auditPath = join(dir, "audit.jsonl");
  const events: AgentEvent[] = [];
  const uiRequests: UiRequest[] = [];
  const stderr: string[] = [];
  let settled = false;

  const client = new RpcClient({
    cwd: dir,
    env: { CODAR_GATE_AUDIT: auditPath },
    idleTimeoutMs: 240_000,
    wallTimeoutMs: 12 * 60_000,
    onUiRequest: (req) => {
      if (process.env.S2_DEBUG) console.log("[dbg:ui]", req.method, String(req.title ?? "").slice(0, 40));
      uiRequests.push(req);
      cfg.onUi(req, client);
    },
  });
  client.on("event", (e: AgentEvent) => {
    if (process.env.S2_DEBUG) console.log("[dbg:event]", e.type);
    events.push(e);
    if (e.type === "agent_settled") settled = true;
  });
  client.on("stderr", (s: string) => { if (process.env.S2_DEBUG) process.stderr.write("[dbg:child] " + s.slice(0, 200)); stderr.push(s); });
  client.on("error", (e: Error) => stderr.push(`[driver-error] ${String(e)}`));
  if (cfg.captureReady) {
    const cap = cfg.captureReady;
    client.on("response", (r) => cap.records.push(`response:${r.command}:${r.success ? "ok" : "err"}`));
    client.on("event", (e) => cap.records.push(`event:${e.type}`));
    client.on("ui_request", (u) => cap.records.push(`ui:${u.method}`));
  }

  try {
    await client.start({ extensionPath: EXTENSION, thinking: "low" });
    const pr = await client.prompt(cfg.prompt);
    if (!pr.success) throw new Error(`prompt rejected: ${pr.error}`);
    // Wait for the settled event (prompt response only means "accepted").
    const deadline = Date.now() + 10 * 60_000;
    while (!settled && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!settled) throw new Error("agent never settled");
    const last = await client.command({ type: "get_last_assistant_text" } as Record<string, unknown>);
    const lastText =
      last.success && last.data && typeof (last.data as { text?: unknown }).text === "string"
        ? ((last.data as { text: string }).text)
        : null;
    return { dir, result: { events, uiRequests, lastText, stderr } };
  } catch (error) {
    // Surface the child's stderr tail with the failure (spike diagnostics).
    const tail = stderr.slice(-6).join("\n");
    throw new Error(`${String(error)}\n[child stderr tail]\n${tail}`);
  } finally {
    client.kill();
  }
}

function auditLines(dir: string): Array<Record<string, unknown>> {
  const p = join(dir, "audit.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function findConfirm(ui: UiRequest[]): UiRequest | undefined {
  return ui.find((u) => u.method === "confirm" && (u.title ?? "").startsWith("codar-gate:"));
}

async function criterion1Deny(): Promise<void> {
  const { dir, result } = await runSession({
    name: "c1-deny",
    prompt:
      "Use the write tool to create a file named out.txt in the current directory with exactly the content: hello-codar. Do NOT use bash. Do not use any other tool. Then reply with the single word DONE.",
    onUi: (req, client) => {
      if (req.method === "confirm") client.replyUi({ type: "extension_ui_response", id: req.id, confirmed: false });
    },
  });
  const file = join(dir, "out.txt");
  const fileExists = existsSync(file);
  const confirm = findConfirm(result.uiRequests);
  const audit = auditLines(dir);
  const approvals = audit.filter((l) => l.kind === "approval");
  const denied = approvals.some((l) => l.approved === false);
  const pass = !fileExists && confirm !== undefined && denied;
  record(
    "①a",
    "write denied ⇒ file NOT written + audit persisted",
    pass,
    [
      `confirm request reached host: ${confirm !== undefined}`,
      `out.txt exists: ${fileExists} (must be false)`,
      `audit approval{approved:false}: ${denied}`,
      `audit lines: ${audit.length}; last assistant: ${JSON.stringify((result.lastText ?? "").slice(0, 120))}`,
    ]
  );
  rmSync(dir, { recursive: true, force: true });
}

async function criterion1ApproveAnd3Park(): Promise<void> {
  const readyRecords: string[] = [];
  let parkedProbe: { aliveDuringPark: boolean; parkedMs: number } | null = null;
  const { dir, result } = await runSession({
    name: "c1-approve+c3-park",
    prompt:
      "Use the write tool to create a file named out.txt in the current directory with exactly the content: hello-codar. Do NOT use bash. Do not use any other tool. Then reply with the single word DONE.",
    captureReady: { records: readyRecords },
    onUi: (req, client) => {
      if (req.method !== "confirm") return;
      const arrivedAt = Date.now();
      void (async () => {
        // Criterion ③: park PARK_MS without answering, verify the command
        // channel answers while parked, THEN approve.
        await new Promise((r) => setTimeout(r, PARK_MS));
        let aliveDuringPark = false;
        try {
          const state = await client.command({ type: "get_state" } as Record<string, unknown>, 15_000);
          aliveDuringPark = state.success;
        } catch {
          aliveDuringPark = false;
        }
        parkedProbe = { aliveDuringPark, parkedMs: Date.now() - arrivedAt };
        client.replyUi({ type: "extension_ui_response", id: req.id, confirmed: true });
      })();
    },
  });

  const file = join(dir, "out.txt");
  const written = existsSync(file) && readFileSync(file, "utf8") === "hello-codar";
  const audit = auditLines(dir);
  const approvals = audit.filter((l) => l.kind === "approval");
  const approved = approvals.some((l) => l.approved === true && typeof l.waitedMs === "number" && l.waitedMs >= PARK_MS - 5_000);

  record(
    "①b",
    "write approved ⇒ file written with exact content + audit persisted",
    written && approved,
    [
      `out.txt content ok: ${written}`,
      `audit approval{approved:true, waitedMs≥park}: ${approved}`,
      `approvals: ${JSON.stringify(approvals)}`,
    ]
  );

  // Type assertion defeats TS's closure-assignment narrowing (assignments
  // happen inside the onUi closure; flow analysis still sees the initializer).
  const probe = parkedProbe as { aliveDuringPark: boolean; parkedMs: number } | null;
  const parkOk = probe !== null && probe.aliveDuringPark && probe.parkedMs >= PARK_MS;
  record(
    "③",
    `confirm parked ≥${PARK_MS / 1000}s; get_state answers mid-park; completes after reply`,
    parkOk,
    [
      `parked probe: ${JSON.stringify(probe)}`,
      `settled after late approval: ${result.events.some((e) => e.type === "agent_settled")}`,
    ]
  );

  record(
    "④",
    "ready sequence recorded (spawn → first successful get_state response)",
    readyRecords.length > 0 && readyRecords.includes("response:get_state:ok"),
    [`${JSON.stringify(readyRecords)}`, `…criteria ④ detail in spike/s2-report.md`]
  );
  (globalThis as unknown as Record<string, unknown>).__s4Records = readyRecords;
  rmSync(dir, { recursive: true, force: true });
}

async function criterion2Bridge(): Promise<void> {
  const marker = "BRIDGE_ECHO_OK_42";
  const { dir, result } = await runSession({
    name: "c2-bridge",
    prompt:
      'Call the bridge_echo tool once with payload {"k":42,"s":"中文"}. Do not use any other tool. Then reply with the single word DONE.',
    onUi: (req, client) => {
      if (req.method === "input" && req.title === "codar:bridge-echo") {
        client.replyUi({
          type: "extension_ui_response",
          id: req.id,
          value: JSON.stringify({ status: "ok", marker }),
        });
      }
    },
  });
  const req = result.uiRequests.find((u) => u.method === "input" && u.title === "codar:bridge-echo");
  let outboundOk = false;
  let outboundEvidence = "(no placeholder)";
  if (req && typeof req.placeholder === "string") {
    outboundEvidence = req.placeholder.slice(0, 200);
    try {
      let payload: unknown = (JSON.parse(req.placeholder) as { payload?: unknown }).payload;
      // Models may pass the payload as a JSON string rather than an object —
      // accept one level of string nesting (channel fidelity is the criterion,
      // not model formatting discipline).
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          /* keep the string */
        }
      }
      const p = payload as { k?: unknown; s?: unknown };
      outboundOk = (p?.k === 42 || p?.k === "42") && (p?.s === "中文" || String(p?.s ?? "").includes("中文"));
    } catch {
      outboundOk = false;
    }
  }
  const raw = JSON.stringify(result.events);
  const markerBack = raw.includes(marker);
  record(
    "②",
    "structured round-trip over ui bridge (params out as placeholder JSON, structured value back)",
    outboundOk && markerBack,
    [
      `ui_request input/codar:bridge-echo seen: ${req !== undefined}`,
      `outbound placeholder: ${outboundEvidence}`,
      `payload k/s recognized: ${outboundOk}`,
      `marker ${marker} observed in tool result events: ${markerBack}`,
    ]
  );
  rmSync(dir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  console.log(`S2 spike — extension: ${EXTENSION}`);
  console.log(`pi: ${process.env.PI_BIN ?? "pi"} (provider/model = configured default, thinking=low)\n`);

  await criterion1ApproveAnd3Park(); // also captures ④
  await criterion1Deny();
  await criterion2Bridge();

  const failed = criteria.filter((c) => !c.pass);
  const report: string[] = [
    "# M0-S2 Spike Report — workeros-gate port to pi 1.5.0",
    "",
    `Date: ${new Date().toISOString()}`,
    `Extension: extensions/codar-gate/codar-gate.ts (donated from workeros-gate, PRD §14)`,
    `pi: 1.5.0 (managed install) · provider: configured default (zai-coding-cn/glm-5.3, thinking=low)`,
    "",
    "## Verdicts",
    "",
  ];
  for (const c of criteria) {
    report.push(`### ${c.pass ? "✅" : "❌"} ${c.id} ${c.title}`);
    for (const e of c.evidence) report.push(`- ${e}`);
    report.push("");
  }
  const readyRecords = (globalThis as unknown as Record<string, unknown>).__s4Records as string[] | undefined;
  if (readyRecords) {
    report.push("## ④ Ready sequence (spawn → first successful get_state response)");
    report.push("");
    report.push("```");
    report.push(...readyRecords);
    report.push("```");
    report.push("");
  }
  report.push(`## Result: ${failed.length === 0 ? "ALL PASS — S2 gate OPEN" : `${failed.length} FAILED — S2 gate CLOSED`}`);
  writeFileSync(join(HERE, "s2-report.md"), report.join("\n") + "\n", "utf8");
  console.log(`\nreport: spike/s2-report.md`);
  if (failed.length > 0) process.exit(1);
}

void main().catch((e) => {
  console.error("spike crashed:", e);
  process.exit(2);
});

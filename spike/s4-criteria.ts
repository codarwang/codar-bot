/**
 * M0-S4 spike runner — Docker per-Bot sandbox acceptance criteria
 * (architecture.md §9 S4):
 *
 *  ① containerized pi RPC: docker run + §3.4 mounts + stdin/stdout JSONL
 *     transparent (a gated write lands HOST-side via the workDir mount; the
 *     ui-bridge approval works through the container boundary)
 *  ② session host-side persistence: container A writes its session under
 *     the mounted agent dir; container A is DESTROYED; container B starts
 *     fresh and resumes via switch_session (context survives)
 *  ③ fail-closed: no docker (bad bin) ⇒ start() refused; unreachable
 *     daemon ⇒ start() refused
 *
 * Writes spike/s4-report.md; exits non-zero on failure.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient, type AgentEvent } from "../src/driver/rpc-client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const IMAGE = "codar-bot-sandbox:0.1";

interface Criterion { id: string; title: string; pass: boolean; evidence: string[]; }
const criteria: Criterion[] = [];
function record(id: string, title: string, pass: boolean, evidence: string[]): void {
  criteria.push({ id, title, pass, evidence });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id} ${title}`);
  for (const line of evidence) console.log(`      ${line}`);
}

function zaiKey(): string | null {
  const auth = JSON.parse(readFileSync(join(process.env.HOME!, ".pi/agent/auth.json"), "utf8")) as Record<
    string, { apiKey?: string; key?: string } | string | undefined
  >;
  const entry = auth["zai-coding-cn"];
  return typeof entry === "string" ? entry : (entry?.apiKey ?? entry?.key ?? null);
}

interface Sandbox {
  root: string; work: string; shared: string; conf: string; sessions: string;
  dockerArgs(): string[];
}

function makeSandbox(key: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "codar-s4-"));
  const work = join(root, "work");
  const shared = join(root, "shared");
  const conf = join(root, "pi-conf");
  for (const d of [work, shared, conf]) mkdirSync(d, { recursive: true });
  // pi agent dir redirected into the mount: models.json defines the provider
  // with $ENV key interpolation (S3-proven chain); pi writes sessions under
  // <agentDir>/sessions — i.e. HOST-side via this mount (§3.4 v0.9: the
  // pi-conf mount IS the session carrier; no separate sessions bind).
  writeFileSync(join(conf, "models.json"), JSON.stringify({
    providers: {
      "zai-coding-cn": {
        api: "openai-completions",
        baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
        apiKey: "$CODAR_BOT_KEY",
        models: [{
          id: "glm-5.3", name: "GLM-5.3", input: ["text"],
          cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
          contextWindow: 128_000, maxTokens: 8_192, type: "chat",
        }],
      },
    },
  }, null, 2));
  const dockerArgs = (): string[] => [
    "run", "-i", "--rm",
    "-v", `${work}:/home/bot/work`,
    "-v", `${shared}:/home/bot/shared`,
    "-v", `${conf}:/state/pi-conf`,
    "-v", `${resolve(REPO, "extensions/codar-gate")}:/opt/codar-ext:ro`,
    "-e", `CODAR_BOT_KEY=${key}`,
    "-e", "PI_CODING_AGENT_DIR=/state/pi-conf",
    IMAGE,
  ];
  return { root, work, shared, conf, sessions: join(conf, "sessions"), dockerArgs };
}

function makeClient(sb: Sandbox, extra: Record<string, string> = {}): RpcClient {
  const events: AgentEvent[] = [];
  const failures: string[] = [];
  const client = new RpcClient({
    bin: "docker",
    argvPrefix: sb.dockerArgs(),
    cwd: sb.work,
    env: extra,
    idleTimeoutMs: 300_000,
    wallTimeoutMs: 12 * 60_000,
    onUiRequest: (req) => {
      if (req.method === "confirm") {
        client.replyUi({ type: "extension_ui_response", id: req.id, confirmed: true });
      }
    },
  });
  client.on("event", (e: AgentEvent) => events.push(e));
  client.on("error", (e: Error) => failures.push(String(e).slice(0, 200)));
  client.on("bot_failed", (f) => failures.push(JSON.stringify(f).slice(0, 200)));
  client.on("stderr", (s: string) => { if (/error|fail|denied/i.test(s)) failures.push(s.slice(0, 200)); });
  (client as unknown as { __events: AgentEvent[]; __failures: string[] }).__events = events;
  (client as unknown as { __failures: string[] }).__failures = failures;
  return client;
}

async function waitSettled(client: RpcClient, minutes = 6, afterAttach: () => Promise<void>): Promise<void> {
  let settled = false;
  client.on("settled", () => { settled = true; });
  await afterAttach(); // prompt sent AFTER the listener is attached (no race)
  const deadline = Date.now() + minutes * 60_000;
  while (!settled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  if (!settled) throw new Error("agent never settled");
}

async function criterion1And2(): Promise<void> {
  const key = zaiKey();
  if (!key) { record("①②", "containerized run + session resume", false, ["no zai key"]); return; }
  const sb = makeSandbox(key);
  try {
    // --- ① containerized gated write lands host-side (session ON: ② needs it) ---
    const c1 = makeClient(sb);
    try {
      await c1.start({
        extensionPath: "/opt/codar-ext/codar-gate.ts",
        model: "zai-coding-cn/glm-5.3",
        thinking: "low",
        noSession: false,
      });
      await waitSettled(c1, 6, async () => {
        const pr = await c1.prompt(
          "Two things: (1) Remember the secret word BANANA-7 for later. (2) Use the write tool to create out.txt in the current directory containing exactly: s4-hello. Do NOT use bash. Then reply DONE."
        );
        if (!pr.success) throw new Error(`prompt rejected: ${pr.error}`);
      });
    } finally {
      c1.kill();
    }
    // docker run --rm teardown is async after stdin close; give it a beat
    await new Promise((r) => setTimeout(r, 2_000));
    const out = join(sb.work, "out.txt");
    const written = existsSync(out) && readFileSync(out, "utf8").trim() === "s4-hello";
    const auditPath = join(sb.work, ".codar-gate-audit.jsonl");
    const auditExists = existsSync(auditPath);
    // The gate must have MEDIATED the write: an approval line in the audit
    // proves the confirm crossed the container boundary (without it, a bare
    // ungated write could fake `written` — review round-1 tightening).
    // Per-line JSON parse (the S2-verified pattern), not substring scan.
    const approvalMediated = auditExists
      ? readFileSync(auditPath, "utf8").trim().split("\n").some((line) => {
          try {
            const entry = JSON.parse(line) as { kind?: string; approved?: boolean };
            return entry.kind === "approval" && entry.approved === true;
          } catch { return false; }
        })
      : false;
    record("①", "containerized pi RPC: mounts live, ui-bridge approval through the boundary, gated write lands HOST-side",
      written && approvalMediated,
      [
        `out.txt on host (content s4-hello): ${written} (${out})`,
        `gate audit approval{approved:true} host-side: ${approvalMediated}`,
        `stdin/stdout JSONL transparency: proven by the approved-write round trip itself`,
      ]);

    // --- ② destroy container A, resume in container B via switch_session ---
    // pi nests sessions under a project dir derived from cwd
    // (sessions/--home-bot-work--/<file>.jsonl) — discover recursively.
    const sessionDir = sb.sessions;
    const sessionFiles: string[] = [];
    if (existsSync(sessionDir)) {
      for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        for (const f of readdirSync(join(sessionDir, entry.name))) {
          if (f.endsWith(".jsonl")) sessionFiles.push(`${entry.name}/${f}`);
        }
      }
    }
    if (sessionFiles.length === 0) {
      record("②", "session persists host-side; container B resumes via switch_session", false, [
        `no session files under host ${sessionDir} (recursive)`,
      ]);
      return;
    }
    const c2 = makeClient(sb);
    try {
      await c2.start({ extensionPath: "/opt/codar-ext/codar-gate.ts", model: "zai-coding-cn/glm-5.3", thinking: "low" });
      // §3.4 path rule: host path → container path translation.
      const containerPath = `/state/pi-conf/sessions/${sessionFiles[0]}`;
      const sw = await c2.command({ type: "switch_session", sessionPath: containerPath } as Record<string, unknown>);
      if (!sw.success) throw new Error(`switch_session failed: ${sw.error}`);
      await waitSettled(c2, 6, async () => {
        const pr = await c2.prompt("What was the secret word I asked you to remember? Reply with just the word.");
        if (!pr.success) throw new Error(`prompt rejected: ${pr.error}`);
      });
      const last = await c2.command({ type: "get_last_assistant_text" } as Record<string, unknown>);
      const text =
        last.success && typeof (last.data as { text?: unknown } | null)?.text === "string"
          ? (last.data as { text: string }).text : "";
      const failures = (c2 as unknown as { __failures: string[] }).__failures;
      const pass = text.toUpperCase().includes("BANANA-7") && failures.length === 0;
      record("②", "session persists HOST-side; fresh container resumes via switch_session (context survives)",
        pass,
        [
          `session files host-side: ${sessionFiles.length} (${sessionFiles[0]})`,
          `switch_session(containerPath): ${sw.success}`,
          `container B recall answer: ${JSON.stringify(text.slice(0, 80))}`,
          `failures: ${failures.length}`,
        ]);
    } finally {
      c2.kill();
    }
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
}

async function criterion3FailClosed(): Promise<void> {
  // (a) docker binary missing entirely
  let missingBinRefused = false;
  try {
    const c = new RpcClient({ bin: "/nonexistent/docker-codar", idleTimeoutMs: 5_000, wallTimeoutMs: 10_000 });
    c.on("error", () => {});
    await c.start({});
    c.kill();
  } catch {
    missingBinRefused = true; // start() must reject — spawn error ⇒ fail ⇒ throw
  }
  // (b) daemon unreachable (bogus DOCKER_HOST)
  let daemonDownRefused = false;
  try {
    const c = new RpcClient({
      bin: "docker",
      argvPrefix: ["run", "-i", "--rm", "hello-world"],
      env: { DOCKER_HOST: "tcp://127.0.0.1:1" },
      idleTimeoutMs: 5_000,
      wallTimeoutMs: 15_000,
    });
    c.on("error", () => {});
    await c.start({});
    c.kill();
  } catch {
    daemonDownRefused = true;
  }
  record("③", "fail-closed: missing docker binary AND unreachable daemon both refuse to start",
    missingBinRefused && daemonDownRefused,
    [
      `missing binary ⇒ start refused: ${missingBinRefused}`,
      `unreachable daemon (DOCKER_HOST=tcp://127.0.0.1:1) ⇒ start refused: ${daemonDownRefused}`,
    ]);
}

async function main(): Promise<void> {
  console.log(`S4 spike — image: ${IMAGE}\n`);
  const runners: Array<[string, () => Promise<void>]> = [
    ["①②", criterion1And2],
    ["③", criterion3FailClosed],
  ];
  for (const [id, run] of runners) {
    try { await run(); } catch (error) {
      record(id, `runner crashed — ${String(error).slice(0, 300)}`, false, [String(error).slice(0, 800)]);
    }
  }
  const failed = criteria.filter((c) => !c.pass);
  const report = [
    "# M0-S4 Spike Report — Docker per-Bot sandbox",
    "",
    `Date: ${new Date().toISOString()}`,
    `Image: ${IMAGE} (node:24-alpine + pi 1.5.0 pinned, tini PID-1, unprivileged 'node' user)`,
    `Mounts (§3.4 v0.9): work→/home/bot/work · shared→/home/bot/shared · pi-conf→/state/pi-conf (RW agent dir: models.json + sessions carrier) · codar-gate→/opt/codar-ext:ro`,
    `Note: sessions land under the pi-conf mount (PI_CODING_AGENT_DIR=<agentDir>/sessions/<project-dir>/) — the pi-conf mount IS the session carrier (§3.4 v0.9; no separate sessions bind).`,
    "",
    "## Verdicts",
    "",
  ];
  for (const c of criteria) {
    report.push(`### ${c.pass ? "✅" : "❌"} ${c.id} ${c.title}`);
    for (const e of c.evidence) report.push(`- ${e}`);
    report.push("");
  }
  report.push(`## Result: ${failed.length === 0 ? "ALL PASS — S4 gate OPEN" : `${failed.length} FAILED — S4 gate CLOSED`}`);
  writeFileSync(join(HERE, "s4-report.md"), report.join("\n") + "\n", "utf8");
  console.log("\nreport: spike/s4-report.md");
  if (failed.length > 0) process.exit(1);
}

void main().catch((e) => {
  writeFileSync(join(HERE, "s4-report.md"), `# M0-S4 Spike Report\n\nCRASHED: ${String(e).slice(0, 800)}\n`, "utf8");
  console.error("spike crashed:", e);
  process.exit(2);
});

/**
 * codar host CLI — start | stop | status (PRD §8 subset for M1-A).
 *
 * start: boot the host in the FOREGROUND (Ctrl-C / SIGTERM shuts it down
 * gracefully). Daemonization is a packaging concern (M3 compose); the
 * runtime contract — host.json with pid/port — already supports `stop` and
 * `status` from other processes.
 */
import { readFileSync, existsSync } from "node:fs";
import { Host } from "./host.js";
import { paths } from "./paths.js";
import { initTeam } from "./init.js";

function readRuntime(): { pid: number; port: number } | null {
  const p = paths().hostRuntime;
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as { pid: number; port: number };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "start") {
    const argvTail = process.env.CODAR_PI_ARGV; // e.g. the fake-pi fixture for offline runs
    const host = Host.boot({
      dataRoot: process.env.CODAR_BOT_HOME,
      bin: process.env.CODAR_PI_BIN,
      argv: argvTail !== undefined && argvTail !== "" ? [argvTail] : undefined,
      extensionPath: process.env.CODAR_EXT_PATH,
      extensionsDir: process.env.CODAR_EXTENSIONS_DIR,
    });
    const port = await host.start();
    console.log(`codar host listening on http://127.0.0.1:${port} (pid ${process.pid})`);
    let closing = false;
    const shutdown = async (signal: string) => {
      if (closing) return;
      closing = true;
      console.log(`\n${signal} received, shutting down…`);
      await host.shutdown();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    return;
  }
  if (cmd === "init") {
    // Non-interactive bootstrap (§3.2): keys via args or env (never echoed).
    //   codar init --provider zai-coding-cn --model glm-5.3 [--base-url …] [--thinking low]
    // API key comes from stdin (one line) or $CODAR_INIT_KEY.
    const args = new Map<string, string>();
    for (let i = 3; i < process.argv.length; i += 2) {
      const value = String(process.argv[i + 1] ?? "");
      if (value === "" || value.startsWith("--")) {
        console.error(`flag ${process.argv[i]} needs a value`);
        process.exitCode = 1;
        return;
      }
      args.set(String(process.argv[i]).replace(/^--/, ""), value);
    }
    const provider = args.get("provider");
    const modelId = args.get("model");
    if (provider === undefined || provider === "" || modelId === undefined || modelId === "") {
      console.error("usage: codar init --provider <name> --model <modelId> [--base-url <url>] [--thinking <level>]");
      console.error("       (api key on stdin, or CODAR_INIT_KEY env)");
      process.exitCode = 1;
      return;
    }
    let apiKey = process.env.CODAR_INIT_KEY ?? "";
    if (apiKey === "" && !process.stdin.isTTY) {
      apiKey = (await new Promise<string>((resolve) => {
        let buf = "";
        process.stdin.once("data", (c) => { buf += c.toString(); resolve(buf.split("\n")[0]!.trim()); });
        setTimeout(() => resolve(buf.split("\n")[0]!.trim()), 2_000).unref();
      })) ?? "";
    }
    if (apiKey === "") {
      console.error("no api key provided (stdin or CODAR_INIT_KEY)");
      process.exitCode = 1;
      return;
    }
    const result = initTeam({
      provider, apiKey, modelId,
      baseUrl: args.get("base-url"),
      thinkingLevel: args.get("thinking"),
      dataRoot: process.env.CODAR_BOT_HOME,
    });
    console.log(`initialized: chief=${result.chiefId} room=${result.roomId} workDir=${result.workDir} keyWritten=${result.keyWritten}`);
    return;
  }
  if (cmd === "status") {
    const rt = readRuntime();
    if (rt === null) {
      console.log("codar host: not running (no host.json)");
      process.exitCode = 1;
      return;
    }
    let alive = false;
    try {
      process.kill(rt.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    let overview = "n/a";
    try {
      const res = await fetch(`http://127.0.0.1:${rt.port}/api/overview`);
      if (res.ok) overview = String(((await res.json()) as { bots?: unknown[] }).bots?.length ?? "?");
    } catch {
      overview = "unreachable"; // stale host.json: pid gone, API down
    }
    console.log(`codar host: pid=${rt.pid} port=${rt.port} alive=${alive} bots=${overview}`);
    return;
  }
  if (cmd === "stop") {
    const rt = readRuntime();
    if (rt === null) {
      console.log("codar host: not running");
      return;
    }
    try {
      process.kill(rt.pid, "SIGTERM");
      console.log(`codar host: SIGTERM sent to pid ${rt.pid}`);
    } catch {
      console.log(`codar host: pid ${rt.pid} already gone`);
    }
    return;
  }
  console.log("usage: codar-host <start|stop|status>");
  process.exitCode = 1;
}

void main().catch((e) => {
  console.error("codar-host:", String(e));
  process.exit(1);
});

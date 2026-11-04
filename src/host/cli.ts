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
    const res = await fetch(`http://127.0.0.1:${rt.port}/api/overview`);
    const overview = res.ok ? ((await res.json()) as { bots?: unknown[] }).bots?.length : "?";
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

#!/usr/bin/env node
// codar — CLI for codar-bot (early development).
// Currently ships only `doctor`: an environment preflight for the upcoming
// bot-team host (node / pi / docker / data dir). Zero dependencies by design —
// this file must run before any install tooling exists.

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pkg = require("../package.json");

const IS_TTY = process.stdout.isTTY;
const GREEN = (s) => (IS_TTY ? `\x1b[32m${s}\x1b[0m` : s);
const RED = (s) => (IS_TTY ? `\x1b[31m${s}\x1b[0m` : s);
const DIM = (s) => (IS_TTY ? `\x1b[2m${s}\x1b[0m` : s);

// Minimum Node version codar-bot assumes for the preflight. The real floor
// follows what pi 1.5.0 requires and is pinned during M0; >=18 is the safe
// interim baseline.
const MIN_NODE_MAJOR = 18;

function run(cmd, timeoutMs = 5000) {
  try {
    const out = execSync(cmd, {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
    return { ok: true, out };
  } catch (err) {
    return {
      ok: false,
      out: (err.stdout || "").toString().trim(),
      err: (err.stderr || err.message || "").toString().trim(),
    };
  }
}

function whichPath(bin) {
  const probe = process.platform === "win32" ? `where ${bin}` : `command -v ${bin}`;
  const r = run(probe);
  return r.ok ? r.out.split("\n")[0] : null;
}

function nodeMajor(version) {
  const m = /v?(\d+)\./.exec(version || "");
  return m ? Number(m[1]) : 0;
}

function printHelp() {
  console.log(`codar — a home for your bot team on the pi runtime

Usage:
  codar              Show this help
  codar --version    Print version
  codar doctor       Environment preflight: node / pi / docker / data dir

Status: early development. The bot-team host is not shipped yet;
\`codar doctor\` is the first usable piece. Docs: https://github.com/codarwang/codar-bot`);
}

function doctor() {
  console.log("codar doctor — environment preflight for codar-bot\n");
  const results = [];

  // 1. Node
  const nodeMajorVer = nodeMajor(process.version);
  const nodeOk = nodeMajorVer >= MIN_NODE_MAJOR;
  results.push({
    ok: nodeOk,
    line: nodeOk
      ? `node ${process.version}`
      : `node ${process.version} (codar-bot assumes >= v${MIN_NODE_MAJOR}; final floor is pinned during M0)`,
  });

  // 2. pi CLI
  const piPath = whichPath("pi");
  if (piPath) {
    const piVersion = run("pi --version");
    results.push({
      ok: piVersion.ok,
      line: piVersion.ok
        ? `pi ${piVersion.out} ${DIM(`(${piPath})`)}`
        : `pi found at ${piPath} but \`pi --version\` failed`,
    });
  } else {
    results.push({
      ok: false,
      line: "pi CLI not found — codar-bot runs every bot on the pi runtime (https://github.com/earendil-works/pi)",
    });
  }

  // 3. Docker client
  const dockerVersion = run("docker --version");
  if (dockerVersion.ok) {
    results.push({ ok: true, line: dockerVersion.out });
    // 4. Docker daemon (sandbox target; fail-closed in the host later)
    const daemon = run("docker info --format {{.ServerVersion}}", 8000);
    results.push({
      ok: daemon.ok,
      line: daemon.ok
        ? `docker daemon reachable (server ${daemon.out})`
        : "docker daemon not reachable — `docker info` failed (is Docker running?)",
    });
  } else {
    results.push({
      ok: false,
      line: "docker not found — per-bot sandboxing is fail-closed, so the host will refuse to start bots without it",
    });
  }

  // 5. Data dir (informational, not a failure)
  const dataDir = path.join(os.homedir(), ".codar-bot");
  if (fs.existsSync(dataDir)) {
    console.log(`  ${GREEN("✔")} data dir ${DIM(dataDir)} exists`);
  } else {
    console.log(`  ${DIM(`• data dir ${dataDir} not created yet (normal before first run)`)}`);
  }

  for (const r of results) {
    console.log(`  ${r.ok ? GREEN("✔") : RED("✘")} ${r.line}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n${failed === 0 ? GREEN("All checks passed.") : RED(`${failed} check(s) failed.`)} ${DIM(
      "Early development — the bot-team host ships in a later release.",
    )}`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

function main() {
  const arg = process.argv[2];
  if (arg === "--version" || arg === "-v") {
    console.log(pkg.version);
    return;
  }
  if (arg === "doctor") {
    doctor();
    return;
  }
  printHelp();
}

main();

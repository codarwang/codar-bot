/**
 * `codar providers` smoke (v3 discovery surface) — spawns the real CLI
 * entry with a throwaway CODAR_BOT_HOME. renderProviders/providersReport
 * logic is unit-tested in provider-config.test.ts; this pins the CLI's
 * read-path behaviors that only exist in main(): state.json absent-tolerant
 * direct read, malformed state/keys → non-zero exit with a stderr message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initTeam } from "../src/host/init.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../src/host/cli.ts");

function runCli(home: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("npx", ["tsx", CLI, "providers"], {
    cwd: HERE,
    env: { ...process.env, CODAR_BOT_HOME: home },
    encoding: "utf8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("codar providers: init-seeded home lists configured provider + models; absent state tolerated", () => {
  const home = mkdtempSync(join(tmpdir(), "codar-cli-prov-"));
  try {
    // Seed through the real bootstrap: chief bot + key + state.json.
    initTeam({ provider: "zai-coding-cn", apiKey: "k", modelId: "glm-5.3", dataRoot: home });
    const out = runCli(home);
    assert.equal(out.status, 0);
    assert.ok(out.stdout.includes("✓ zai-coding-cn"), "configured provider marked");
    assert.ok(out.stdout.includes("glm-5.3"), "chief's in-use model listed");
    assert.match(out.stdout, /×\s+openai/, "unconfigured preset listed");
    // No host running: the command must not touch the store's single-writer
    // lock (direct state.json read) — that's the whole point of the path.
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("codar providers: empty home (no state, no keys) still exits 0 with a hint", () => {
  const home = mkdtempSync(join(tmpdir(), "codar-cli-prov-"));
  try {
    const out = runCli(home);
    assert.equal(out.status, 0);
    assert.ok(out.stdout.length > 0);
    assert.ok(out.stdout.includes("openai") || out.stdout.includes("no providers"), "presets or the empty hint");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("codar providers: malformed state.json / keys.json → non-zero exit, message on stderr", () => {
  const home = mkdtempSync(join(tmpdir(), "codar-cli-prov-"));
  try {
    writeFileSync(join(home, "state.json"), "{broken");
    let out = runCli(home);
    assert.equal(out.status, 1, "malformed state → exit 1");
    assert.match(out.stderr, /state\.json/);
    writeFileSync(join(home, "state.json"), "{}"); // absent-tolerant shape: empty doc, no bots key
    writeFileSync(join(home, "keys.json"), "{broken");
    out = runCli(home);
    assert.equal(out.status, 1, "malformed keys → exit 1");
    assert.match(out.stderr, /keys\.json/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

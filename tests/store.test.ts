/**
 * Store unit tests — atomic persistence, lock, invariants (offline).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, emptyState, defaultBudget, SCHEMA_VERSION, type BotRecord } from "../src/host/store.js";

const botBase = (): Omit<BotRecord, "id"> => ({
  name: "", role: "", chief: false,
  model: { provider: "p", modelId: "m", thinkingLevel: "low" },
  workDir: "/tmp/w", sessionPath: null,
  sandbox: { mode: "host-not-isolated" }, budget: defaultBudget(),
});

function tmpState(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "codar-store-"));
  return { dir, path: join(dir, "state.json") };
}

test("create → persist → reopen round-trips the roster", () => {
  const { dir, path } = tmpState();
  try {
    const s = Store.open(path, { create: true });
    s.addBot({ ...botBase(), name: "Chief", role: "coordinator", chief: true });
    s.addRoom({ name: "main", members: ["bot_1"], admin: "bot_1", mode: "admin-reply", sharedDir: "/tmp/s", budget: defaultBudget(), goal: null });
    s.close();
    const reopened = Store.open(path);
    assert.equal(reopened.state.bots.length, 1);
    assert.equal(reopened.state.bots[0]!.name, "Chief");
    assert.equal(reopened.state.rooms[0]!.guards.pingPongN, 4); // D4 defaults
    assert.equal(reopened.state.rooms[0]!.status, "active");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("single-chief invariant enforced", () => {
  const { dir, path } = tmpState();
  try {
    const s = Store.open(path, { create: true });
    const mk = () => s.addBot({ ...botBase(), name: `c${Math.random().toString(36).slice(2, 6)}`, chief: true });
    mk();
    assert.throws(mk, /single-chief/);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bot names are unique", () => {
  const { dir, path } = tmpState();
  try {
    const s = Store.open(path, { create: true });
    s.addBot({ ...botBase(), name: "Writer" });
    assert.throws(() => s.addBot({ ...botBase(), name: "Writer" }), /already in use/);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic persistence never leaves the state torn", () => {
  const { dir, path } = tmpState();
  try {
    const s = Store.open(path, { create: true });
    s.addBot({ ...botBase(), name: "A" });
    const raw = JSON.parse(readFileSync(path, "utf8")) as ReturnType<typeof emptyState>;
    assert.equal(raw.schemaVersion, SCHEMA_VERSION);
    assert.equal(raw.bots.length, 1);
    assert.ok(!existsSync(join(dir, "state.json.tmp"))); // rename cleaned up
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exclusive open locks out a second writer; stale lock is breakable", async () => {
  const { dir, path } = tmpState();
  try {
    const a = Store.openExclusive(path, { create: true });
    assert.throws(() => Store.openExclusive(path), /locked by pid/);
    a.close();
    const b = Store.openExclusive(path); // released ⇒ re-acquirable
    b.close();
    // Stale: hand-write an ancient lock with a dead pid.
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: 999_999_999, ts: Date.now() - 3_600_000 }));
    const c = Store.openExclusive(path);
    c.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("open without create on missing state throws", () => {
  const { dir, path } = tmpState();
  try {
    assert.throws(() => Store.open(path), /no state/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * init bootstrap tests (§3.2) — offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTeam } from "../src/host/init.js";
import { Store } from "../src/host/store.js";
import { loadKeys } from "../src/host/provider-config.js";
import { paths } from "../src/host/paths.js";

test("init creates chief + default room + keys.json; re-init is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "codar-init-"));
  try {
    const r1 = initTeam({ provider: "zai-coding-cn", apiKey: "k-1", modelId: "glm-5.3", dataRoot: root });
    assert.ok(r1.chiefId.startsWith("bot_"));
    assert.ok(r1.roomId.startsWith("room_"));
    assert.equal(r1.keyWritten, true);

    const p = paths(root);
    const keys = loadKeys(p.keys);
    assert.equal(keys.providers["zai-coding-cn"]!.apiKey, "k-1");
    const store = Store.open(p.state);
    assert.equal(store.state.bots.length, 1);
    assert.equal(store.state.bots[0]!.chief, true);
    assert.equal(store.state.bots[0]!.name, "Chief");
    assert.equal(store.state.rooms.length, 1);
    assert.equal(store.state.rooms[0]!.members[0], r1.chiefId);
    store.close();

    // Re-init with the same provider: keeps one chief/room, rotates the key.
    const r2 = initTeam({ provider: "zai-coding-cn", apiKey: "k-2", modelId: "glm-5.3", dataRoot: root });
    assert.equal(r2.chiefId, r1.chiefId);
    assert.equal(loadKeys(p.keys).providers["zai-coding-cn"]!.apiKey, "k-2");
    const store2 = Store.open(p.state);
    assert.equal(store2.state.bots.length, 1);
    store2.close();

    // Second provider: adds a key entry, still one chief — and the chief's
    // model is NOT rewritten (adding a key ≠ switching the chief).
    const before = Store.open(p.state).state.bots[0]!.model;
    initTeam({ provider: "minimax-cn", apiKey: "k-3", modelId: "abab", dataRoot: root });
    const store3 = Store.open(p.state);
    assert.equal(store3.state.bots.length, 1);
    assert.equal(Object.keys(loadKeys(p.keys).providers).length, 2);
    assert.deepEqual(store3.state.bots[0]!.model, before);
    store3.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom provider init records baseUrl in keys (chain input)", () => {
  const root = mkdtempSync(join(tmpdir(), "codar-init2-"));
  try {
    initTeam({
      provider: "myproxy", apiKey: "p-1", modelId: "gpt-x",
      baseUrl: "https://proxy.example/v1", dataRoot: root,
    });
    const entry = loadKeys(paths(root).keys).providers["myproxy"]!;
    assert.equal(entry.baseUrl, "https://proxy.example/v1");
    assert.equal(entry.apiKey, "p-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

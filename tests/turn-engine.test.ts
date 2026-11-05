/**
 * turn-engine pure state-machine tests — offline, deterministic (PRD §7:
 * the turn engine MUST have unit tests replayed without an LLM).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  afterBotTurn,
  nextRRPointer,
  onUserTurn,
  parseMentions,
  pickResponder,
  slotsSnapshot,
} from "../src/host/turn-engine.js";

const MEMBERS = [
  { id: "bot_chief", name: "Chief" },
  { id: "bot_writer", name: "Writer" },
  { id: "bot_research", name: "Research" },
];

const POLICY = {
  admin: "bot_chief",
  mode: "admin-reply" as const,
  members: ["bot_chief", "bot_writer", "bot_research"],
};

test("parseMentions: name match case-insensitive, dedupe, member-only", () => {
  assert.deepEqual(parseMentions("@Writer 请写周报", MEMBERS), { botIds: ["bot_writer"], all: false });
  assert.deepEqual(parseMentions("@writer and @WRITER", MEMBERS), { botIds: ["bot_writer"], all: false });
  assert.deepEqual(parseMentions("@Chief @Research 一起看看", MEMBERS), {
    botIds: ["bot_chief", "bot_research"],
    all: false,
  });
  assert.deepEqual(parseMentions("@unknown 空间站", MEMBERS), { botIds: [], all: false });
  assert.deepEqual(parseMentions("@all 注意", MEMBERS), { botIds: [], all: true });
  assert.deepEqual(parseMentions("@everyone standby", MEMBERS), { botIds: [], all: true });
  // CJK names match too
  const cjk = [{ id: "bot_a", name: "小明" }];
  assert.deepEqual(parseMentions("@小明 出列", cjk), { botIds: ["bot_a"], all: false });
});

test("pickResponder: admin-reply default → admin; mention wins; @all fans out in roster order; paused → nobody", () => {
  const d1 = pickResponder(POLICY, { botIds: [], all: false }, 0, false);
  assert.deepEqual(d1, { responders: ["bot_chief"], reason: "admin-default" });

  const d2 = pickResponder(POLICY, { botIds: ["bot_research"], all: false }, 0, false);
  assert.deepEqual(d2, { responders: ["bot_research"], reason: "mention" });

  const d3 = pickResponder(POLICY, { botIds: [], all: true }, 0, false);
  assert.deepEqual(d3.responders, POLICY.members);
  assert.equal(d3.reason, "all");

  const d4 = pickResponder(POLICY, { botIds: ["bot_writer"], all: false }, 0, true);
  assert.deepEqual(d4, { responders: [], reason: "paused" });
});

test("pickResponder: round-robin rotates; pointer wraps", () => {
  const rr = { ...POLICY, mode: "round-robin" as const };
  assert.deepEqual(
    pickResponder(rr, { botIds: [], all: false }, 0, false).responders,
    ["bot_chief"]
  );
  assert.deepEqual(
    pickResponder(rr, { botIds: [], all: false }, 1, false).responders,
    ["bot_writer"]
  );
  assert.deepEqual(
    pickResponder(rr, { botIds: [], all: false }, 3, false).responders,
    ["bot_chief"]
  );
  assert.equal(nextRRPointer(rr, 2), 0);
  assert.equal(nextRRPointer(rr, 0), 1);
  // Mention still overrides the pointer.
  assert.deepEqual(
    pickResponder(rr, { botIds: ["bot_research"], all: false }, 0, false).responders,
    ["bot_research"]
  );
});

test("ping-pong guard: N consecutive zero-tool turns pause; any tool call resets; user message resets", () => {
  const guards = { pingPongN: 4 };
  let st = { consecutivePure: 0 };
  const pauses: boolean[] = [];
  for (let i = 0; i < 4; i++) {
    const v = afterBotTurn(guards, st, 0);
    st = v.state;
    pauses.push(v.pauseNow);
  }
  assert.deepEqual(pauses, [false, false, false, true]);
  assert.equal(st.consecutivePure, 4);

  // A tool-using turn resets.
  const v2 = afterBotTurn(guards, { consecutivePure: 3 }, 2);
  assert.deepEqual(v2, { state: { consecutivePure: 0 }, pauseNow: false });

  // User message resets.
  assert.deepEqual(onUserTurn(), { consecutivePure: 0 });
});

test("slotsSnapshot: members default waiting, overrides applied", () => {
  const slots = slotsSnapshot(POLICY.members, { bot_writer: "working" });
  assert.equal(slots.bot_chief, "waiting");
  assert.equal(slots.bot_writer, "working");
  assert.equal(slots.bot_research, "waiting");
});

test("pickResponder: @all from a NON-admin bot is ignored (§5); admin ∉ members answers nobody", () => {
  // user sender: fan-out
  assert.deepEqual(pickResponder(POLICY, { botIds: [], all: true }, 0, false, { kind: "user" }).reason, "all");
  // admin bot sender: fan-out allowed
  assert.deepEqual(
    pickResponder(POLICY, { botIds: [], all: true }, 0, false, { kind: "bot", id: "bot_chief" }).reason,
    "all"
  );
  // non-admin bot sender: @all stripped → admin default
  const d = pickResponder(POLICY, { botIds: [], all: true }, 0, false, { kind: "bot", id: "bot_writer" });
  assert.deepEqual(d, { responders: ["bot_chief"], reason: "admin-default" });

  // admin not in members ⇒ no responder (deleted admin can't answer)
  const broken = { admin: "bot_gone", mode: "admin-reply" as const, members: ["bot_writer"] };
  assert.deepEqual(pickResponder(broken, { botIds: [], all: false }, 0, false).responders, []);
});

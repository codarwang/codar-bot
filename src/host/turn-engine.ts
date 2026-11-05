/**
 * turn-engine — the pure group-turn state machine (architecture §6.1).
 *
 * No I/O, no timers: the room engine feeds events in and gets decisions +
 * slot transitions out. Deterministic by construction → unit tests replay
 * message streams without an LLM (PRD §7).
 *
 * Semantics (v1, admin-reply default):
 *  - slot states per member: waiting / speaking / posted / passed / working /
 *    failed / timed-out (§6.1 set)
 *  - responder selection: explicit @mentions win; @all fans out to every
 *    member (admin-only — enforced by the caller for bot senders; the human
 *    operator is always allowed); no mention → room admin answers in
 *    admin-reply mode, round-robin pointer otherwise
 *  - ping-pong guard (PRD 3.3-1): N consecutive completed bot turns with
 *    zero tool calls ⇒ pause-for-human; any user message resets the counter
 */

export type SlotState =
  | "waiting"
  | "speaking"
  | "posted"
  | "passed"
  | "working"
  | "failed"
  | "timed-out";

export const INITIAL_SLOT: SlotState = "waiting";

export interface RoomMemberRef {
  id: string;
  name: string;
}

export interface RoomPolicy {
  admin: string;
  mode: "admin-reply" | "round-robin";
  members: string[];
}

export interface MentionParse {
  /** Explicitly @-mentioned member ids (deduped, member-only). */
  botIds: string[];
  /** @all / @everyone was used. */
  all: boolean;
}

const MENTION_RE = /@([\p{L}\p{N}_-]+)/gu;

/** Parse @mentions against the member roster (case-insensitive name match). */
export function parseMentions(text: string, members: RoomMemberRef[]): MentionParse {
  const byName = new Map<string, string>();
  for (const m of members) byName.set(m.name.toLowerCase(), m.id);
  const hits = new Set<string>();
  let all = false;
  for (const match of text.matchAll(MENTION_RE)) {
    const token = (match[1] ?? "").toLowerCase();
    if (token === "all" || token === "everyone") {
      all = true;
      continue;
    }
    const id = byName.get(token);
    if (id !== undefined) hits.add(id);
  }
  return { botIds: [...hits], all };
}

export interface TurnDecision {
  /** Responder order (fan-out for @all); empty = no one answers. */
  responders: string[];
  reason: "mention" | "all" | "admin-default" | "round-robin" | "paused";
}

/** Choose who answers this message. Mentions > @all > mode default. */
export function pickResponder(
  policy: RoomPolicy,
  mentions: MentionParse,
  rrPointer: number,
  paused: boolean
): TurnDecision {
  if (paused) return { responders: [], reason: "paused" };
  if (mentions.botIds.length > 0) {
    // Explicit mentions keep roster order for determinism.
    const ordered = policy.members.filter((m) => mentions.botIds.includes(m));
    return { responders: ordered, reason: "mention" };
  }
  if (mentions.all) {
    return { responders: [...policy.members], reason: "all" };
  }
  if (policy.mode === "round-robin" && policy.members.length > 0) {
    const idx = ((rrPointer % policy.members.length) + policy.members.length) % policy.members.length;
    return { responders: [policy.members[idx]!], reason: "round-robin" };
  }
  return { responders: [policy.admin], reason: "admin-default" };
}

/** Next round-robin pointer after a completed turn. */
export function nextRRPointer(policy: RoomPolicy, current: number): number {
  return policy.members.length > 0 ? (current + 1) % policy.members.length : 0;
}

// --- ping-pong guard (PRD 3.3-1) ---------------------------------------------

export interface PingPongState {
  /** Completed bot turns in a row with zero tool calls. */
  consecutivePure: number;
}

export interface PingPongVerdict {
  state: PingPongState;
  /** True when this completion crossed the threshold ⇒ pause for human. */
  pauseNow: boolean;
}

/**
 * A bot turn completed. `toolCalls` = tool executions observed during the
 * turn (any tool call makes the turn "real work" and resets the counter —
 * PRD 3.3-1 targets idle chatter, not working bots).
 */
export function afterBotTurn(
  guards: { pingPongN: number },
  state: PingPongState,
  toolCalls: number
): PingPongVerdict {
  if (toolCalls > 0) {
    return { state: { consecutivePure: 0 }, pauseNow: false };
  }
  const consecutivePure = state.consecutivePure + 1;
  return { state: { consecutivePure }, pauseNow: consecutivePure >= guards.pingPongN };
}

/** A human message arrived: the guard's wait is over (room-engine owns the
 *  pause policy — ping-pong pause lifts on user message, budget pause does
 *  not, §5.3). */
export function onUserTurn(): PingPongState {
  return { consecutivePure: 0 };
}

// --- slot helpers --------------------------------------------------------------

export function slotsSnapshot(members: string[], overrides: Record<string, SlotState>): Record<string, SlotState> {
  const slots: Record<string, SlotState> = {};
  for (const m of members) slots[m] = overrides[m] ?? INITIAL_SLOT;
  return slots;
}

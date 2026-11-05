#!/usr/bin/env node
/**
 * fake-pi — a deterministic stub of the pi rpc protocol for offline tests.
 *
 * Speaks the same JSONL protocol as `pi --mode rpc` (byte-exact LF framing)
 * with scripted, prompt-driven behavior:
 *   "Reply with the single word ALPHA."  → streams "ALPHA", settles, usage 1
 *   "...word BRAVO."                     → same with usage 2
 *   prompt containing "FAIL"             → assistant message_end
 *                                          stopReason:"error", settles
 *                                          (exercises the bot_failed path)
 *   prompt containing "PARK"             → emits extension_ui_request
 *                                          (confirm), parks until the host
 *                                          replies; confirmed=true ⇒ "PARKED"
 *                                          else blocked-settles
 * Commands: get_state / prompt / abort / get_last_assistant_text /
 *           switch_session / set_auto_retry / get_session_stats
 */
import { readFileSync, writeFileSync } from "node:fs";

// Integration marker: when FAKE_PI_MARKER is set, record what the child
// actually SAW in its environment (§3.3 chain assertions).
if (process.env.FAKE_PI_MARKER) {
  try {
    writeFileSync(process.env.FAKE_PI_MARKER, JSON.stringify({
      hasBotKey: typeof process.env.CODAR_BOT_KEY === "string" && process.env.CODAR_BOT_KEY !== "",
      hasAnthropicKey: typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY !== "",
      agentDir: process.env.PI_CODING_AGENT_DIR ?? null,
      modelsJson: (() => {
        try {
          return readFileSync(`${process.env.PI_CODING_AGENT_DIR}/models.json`, "utf8");
        } catch {
          return null;
        }
      })(),
    }));
  } catch {
    /* marker is best-effort diagnostics */
  }
}

const out = (record) => process.stdout.write(JSON.stringify(record) + "\n");
let seq = 0;
const usage = (input, output) => ({
  input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: (input + output) / 1e6 },
});
let lastText = null;
const transcript = [];
let sessionFile = process.env.FAKE_PI_SESSION_FILE ?? null;
let autoRetry = true;
let pendingPark = null;
let pendingMessageBot = null;

function respond(id, command, data) {
  out({ id, type: "response", command, success: true, data });
}
function fail(id, command, error) {
  out({ id, type: "response", command, success: false, error });
}

async function runPrompt(id, message) {
  void id;
  if (message.includes("DISPATCH")) {
    // Chief-like turn: call the message_bot tool — the gate parks it on the
    // ui bridge (input dialog with the codar: title), then the host Handoff
    // answers; the tool result is recorded and the turn settles.
    respond(id, "prompt", { disposition: "started" });
    out({ type: "agent_start" });
    out({ type: "turn_start" });
    out({ type: "message_start", message: { role: "system", content: "" } });
    out({ type: "message_end", message: { role: "system", content: "" } });
    const callId = `call-dispatch-${++seq}`;
    const target = process.env.FAKE_PI_MB_TARGET ?? "Writer";
    out({ type: "message_start", message: { role: "assistant" } });
    out({ type: "tool_execution_start", toolCallId: callId, toolName: "message_bot", args: { to: target, task: "draft the weekly report" } });
    out({
      type: "extension_ui_request", id: `mb-${++seq}`, method: "input",
      title: "codar:message_bot",
      placeholder: JSON.stringify({ to: target, task: "Reply with the single word BRAVO.", request_id: "", call_id: callId }),
    });
    pendingMessageBot = { callId };
    return;
  }

  if (message.includes("SLOW")) {
    // Deterministic long run: started → 1.5s of silence → settle with OK.
    transcript.push({ role: "user", content: message });
    transcript.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    respond(id, "prompt", { disposition: "started" });
    out({ type: "agent_start" });
    out({ type: "turn_start" });
    out({ type: "message_start", message: { role: "system", content: "" } });
    out({ type: "message_end", message: { role: "system", content: "" } });
    setTimeout(() => {
      lastText = "OK";
      void transcript;
      out({ type: "message_start", message: { role: "assistant" } });
      out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "OK" } });
      out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop", usage: usage(4, 1) } });
      out({ type: "turn_end" });
      out({ type: "agent_end" });
      out({ type: "agent_settled", aborted: false });
    }, 1_500);
    return;
  }
  if (message.startsWith("/")) {
    // pi handles slash commands without starting an agent run — respond
    // disposition "handled" and settle nothing (rpc-mode real behavior).
    respond(id, "prompt", { disposition: "handled" });
    return;
  }
  respond(id, "prompt", { disposition: "started" });
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  // system message pair (mirrors the real first-turn shape)
  out({ type: "message_start", message: { role: "system", content: "" } });
  out({ type: "message_end", message: { role: "system", content: "" } });

  if (message.includes("PARK")) {
    const parkId = `park-${++seq}`;
    pendingPark = parkId;
    out({ type: "tool_execution_start", toolCallId: `call-${seq}`, toolName: "write", args: { path: "x" } });
    out({ type: "extension_ui_request", id: parkId, method: "confirm", title: "codar-gate: approval required", message: "write" });
    return; // parked; resumed by extension_ui_response below
  }

  if (message.includes("DIE")) {
    // Simulate a mid-run child crash: hard exit without settling.
    setTimeout(() => process.exit(1), 30);
    return;
  }

  if (message.includes("FAIL")) {
    out({ type: "message_start", message: { role: "assistant" } });
    out({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "500: injected failure", usage: usage(0, 0) },
    });
    out({ type: "turn_end" });
    out({ type: "agent_end" });
    out({ type: "agent_settled", aborted: false });
    return;
  }

  if (message.includes("[codar memory review]")) {
    // M2-D review-child branch. FAKE_PI_MEM_REVIEW selects the outcome:
    //   ok (default) — valid FILE blocks | broken — unparseable prose |
    //   huge — entry.md at 2.5x the hard cap
    const mode = process.env.FAKE_PI_MEM_REVIEW ?? "ok";
    transcript.push({ role: "user", content: message });
    respond(id, "prompt", { disposition: "started" });
    out({ type: "agent_start" });
    out({ type: "turn_start" });
    out({ type: "message_start", message: { role: "system", content: "" } });
    out({ type: "message_end", message: { role: "system", content: "" } });
    let text;
    if (mode === "broken") text = "sure, I updated the memory accordingly. (no structured blocks)";
    else if (mode === "huge") text = `<<<FILE entry.md>>>\n${"x".repeat(5_000)}\n<<<END>>>`;
    else if (mode === "delete") {
      text = "<<<FILE entry.md>>>\nkept.\n<<<DELETE topics/style.md>>>\n<<<END>>>";
    }
    else if (mode === "crash") {
      // Review child dies mid-run: started, then hard exit without settling.
      setTimeout(() => process.exit(1), 30);
      return;
    }
    else {
      text = [
        "<<<FILE entry.md>>>",
        "Chief prefers concise answers.",
        "<<<FILE main.md>>>",
        "Team shipped the budget feature; reviews run weekly.",
        "<<<FILE topics/style.md>>>",
        "User-facing lines stay in Chinese.",
        "<<<END>>>",
      ].join("\n");
    }
    const finish = () => {
      lastText = text;
      transcript.push({ role: "assistant", content: [{ type: "text", text }] });
      out({ type: "message_start", message: { role: "assistant" } });
      out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
      out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: usage(30, 6) } });
      out({ type: "turn_end" });
      out({ type: "agent_end" });
      out({ type: "agent_settled", aborted: false });
    };
    const delay = Number(process.env.FAKE_PI_MEM_DELAY_MS ?? 0);
    if (delay > 0) setTimeout(finish, delay);
    else finish();
    return;
  }

  const word = message.includes("ALPHA") ? "ALPHA" : message.includes("BRAVO") ? "BRAVO" : message.includes("PARKED") ? "PARKED" : "OK";
  const u = word === "ALPHA" ? usage(10, 1) : word === "BRAVO" ? usage(20, 2) : usage(5, 1);
  lastText = word;
  transcript.push({ role: "user", content: message });
  transcript.push({ role: "assistant", content: [{ type: "text", text: word }] });
  out({ type: "message_start", message: { role: "assistant" } });
  for (const chunk of [word.slice(0, 1), word.slice(1) || ""].filter(Boolean)) {
    out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: chunk } });
  }
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: word }], stopReason: "stop", usage: u } });
  out({ type: "turn_end" });
  out({ type: "agent_end" });
  out({ type: "agent_settled", aborted: false });
}

function finishParked(confirmed) {
  const parkId = pendingPark;
  pendingPark = null;
  if (confirmed) {
    const word = "PARKED";
    lastText = word;
    out({ type: "message_start", message: { role: "assistant" } });
    out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: word } });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: word }], stopReason: "stop", usage: usage(7, 1) } });
    out({ type: "tool_execution_end", toolCallId: `call-${seq}` });
  } else {
    out({ type: "tool_execution_end", toolCallId: `call-${seq}` });
    out({ type: "message_start", message: { role: "assistant" } });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop", usage: usage(3, 0) } });
  }
  out({ type: "turn_end" });
  out({ type: "agent_end" });
  out({ type: "agent_settled", aborted: false });
  void parkId;
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim().length === 0) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      out({ type: "response", command: "parse", success: false, error: "bad json" });
      continue;
    }
    if (cmd.type === "extension_ui_response") {
      if (pendingPark !== null && cmd.id === pendingPark) finishParked(cmd.confirmed === true);
      if (pendingMessageBot !== null && typeof cmd.value === "string") {
        const mb = pendingMessageBot;
        pendingMessageBot = null;
        let ok = false; let text = "rejected";
        try {
          const parsed = JSON.parse(cmd.value);
          ok = parsed?.status === "ok";
          text = ok ? `accepted — work ${parsed.workId}` : `rejected — ${parsed.error ?? "?"}`;
        } catch { ok = false; }
        void cmd.id;
        lastText = `DISPATCHED:${ok ? "ok" : "no"}`;
        transcript.push({ role: "assistant", content: [{ type: "text", text: lastText }] });
        out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: lastText }], stopReason: "stop", usage: usage(8, 4) } });
        out({ type: "tool_execution_end", toolCallId: mb.callId });
        out({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text }] } });
        out({ type: "turn_end" });
        out({ type: "agent_end" });
        out({ type: "agent_settled", aborted: false });
      }
      continue;
    }
    const { id, type } = cmd;
    switch (type) {
      case "get_state": {
        const delay = Number(process.env.FAKE_PI_READY_DELAY_MS ?? "0");
        const answer = () => respond(id, "get_state", {
          isStreaming: pendingPark !== null, sessionFile,
          sessionId: "fake-session", messageCount: 0,
        });
        if (delay > 0) setTimeout(answer, delay);
        else answer();
        break;
      }
      case "prompt":
        void runPrompt(id, String(cmd.message ?? ""));
        break;
      case "abort":
        respond(id, "abort");
        // Real pi still emits message_end for the in-flight assistant
        // message with stopReason "aborted" (agent-session.js), then settles.
        out({ type: "message_start", message: { role: "assistant" } });
        out({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "aborted", usage: usage(0, 0) },
        });
        out({ type: "agent_settled", aborted: true });
        break;
      case "get_last_assistant_text":
        respond(id, "get_last_assistant_text", { text: lastText });
        break;
      case "switch_session":
        sessionFile = String(cmd.sessionPath ?? sessionFile);
        respond(id, "switch_session", { cancelled: false });
        break;
      case "set_auto_retry":
        autoRetry = cmd.enabled === true;
        respond(id, "set_auto_retry");
        break;
      case "get_messages":
        respond(id, "get_messages", { messages: transcript });
        break;
      case "get_session_stats":
        respond(id, "get_session_stats", {
          sessionId: "fake-session", sessionFile,
          userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
        });
        break;
      default:
        fail(id, String(type), "fake-pi: unsupported command");
    }
  }
});
process.stdin.on("end", () => process.exit(0));
void readFileSync;
void autoRetry;

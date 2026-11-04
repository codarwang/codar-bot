/**
 * codar-gate extension handler unit tests — offline, deterministic.
 *
 * Mocks the pi ExtensionAPI surface (the small slice codar-gate uses) and
 * drives the tool_call / message_end / registerTool wiring through the same
 * factory the real child loads. The fail-closed paths are the point: a
 * regression here silently opens the gate in production.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import codarGate from "../extensions/codar-gate/codar-gate.js";

type ToolCallHandler = (
  event: { toolCallId: string; toolName: string; input: unknown },
  ctx: { hasUI: boolean; ui: { confirm: (t: string, m: string) => Promise<boolean>; input: (t: string, p: string) => Promise<string | undefined> } }
) => Promise<{ block?: boolean; reason?: string } | undefined>;
type MessageEndHandler = (event: { message: unknown }) => void;
interface RegisteredTool {
  name: string;
  execute: (id: string, params: unknown) => Promise<{ isError: boolean; content: Array<{ type: string; text: string }>; details?: unknown }>;
}

function makeHarness(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codar-gate-test-"));
  const auditPath = join(dir, "audit.jsonl");
  const prevEnv = { ...process.env };
  process.env.CODAR_GATE_AUDIT = auditPath;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;

  let toolCallHandler: ToolCallHandler | null = null;
  let messageEndHandler: MessageEndHandler | null = null;
  const tools = new Map<string, RegisteredTool>();

  const fakeApi = {
    on(event: string, handler: unknown) {
      if (event === "tool_call") toolCallHandler = handler as ToolCallHandler;
      if (event === "message_end") messageEndHandler = handler as MessageEndHandler;
      return () => {};
    },
    registerTool(tool: { name: string } & RegisteredTool) {
      tools.set(tool.name, tool as RegisteredTool);
    },
  };
  codarGate(fakeApi as never);

  const harness = {
    dir,
    auditPath,
    toolCall: toolCallHandler!,
    messageEnd: messageEndHandler!,
    tools,
    ctx(over: Partial<Parameters<ToolCallHandler>[1]> = {}) {
      return {
        hasUI: true,
        ui: {
          confirm: async () => true,
          input: async () => undefined,
        },
        ...over,
      };
    },
    auditLines(): Array<Record<string, unknown>> {
      try {
        return readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    restore() {
      process.env = prevEnv;
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

test("allow decision: no block, tool_call audited", async () => {
  const h = makeHarness();
  try {
    const verdict = await h.toolCall({ toolCallId: "c1", toolName: "read", input: { path: "x" } }, h.ctx());
    assert.equal(verdict, undefined);
    const lines = h.auditLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.kind, "tool_call");
    assert.equal(lines[0]!.action, "allow");
  } finally {
    h.restore();
  }
});

test("gate + confirm true: allowed, approval audited with real wait", async () => {
  const h = makeHarness();
  try {
    const verdict = await h.toolCall(
      { toolCallId: "c2", toolName: "write", input: { path: "a.txt" } },
      h.ctx({ ui: { confirm: async () => true, input: async () => undefined } })
    );
    assert.equal(verdict, undefined);
    const approvals = h.auditLines().filter((l) => l.kind === "approval");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]!.approved, true);
  } finally {
    h.restore();
  }
});

test("gate + confirm false: blocked with reason", async () => {
  const h = makeHarness();
  try {
    const verdict = await h.toolCall(
      { toolCallId: "c3", toolName: "write", input: { path: "a.txt" } },
      h.ctx({ ui: { confirm: async () => false, input: async () => undefined } })
    );
    assert.equal(verdict?.block, true);
    assert.ok(String(verdict?.reason).includes("denied by approver"));
  } finally {
    h.restore();
  }
});

test("gate without UI: fail-closed block", async () => {
  const h = makeHarness();
  try {
    const verdict = await h.toolCall({ toolCallId: "c4", toolName: "edit", input: {} }, h.ctx({ hasUI: false }));
    assert.equal(verdict?.block, true);
    assert.ok(String(verdict?.reason).includes("fail-closed"));
  } finally {
    h.restore();
  }
});

test("audit write failure blocks the call (cannot audit ⇒ cannot allow)", async () => {
  const h = makeHarness();
  try {
    // Break the audit sink AFTER factory init: point the path at a missing dir.
    const badDir = join(h.dir, "gone");
    rmSync(h.dir, { recursive: true, force: true });
    void badDir;
    const verdict = await h.toolCall({ toolCallId: "c5", toolName: "read", input: {} }, h.ctx());
    assert.equal(verdict?.block, true);
    assert.ok(String(verdict?.reason).includes("internal error"));
  } finally {
    h.restore();
  }
});

test("bridge_echo: structured round-trip memo reported by execute; cancelled blocks", async () => {
  const h = makeHarness();
  try {
    // Routed arm: input dialog returns a JSON {status,marker} value.
    const seen: string[] = [];
    const verdict = await h.toolCall(
      { toolCallId: "c6", toolName: "bridge_echo", input: { payload: { k: 42 } } },
      h.ctx({
        ui: {
          confirm: async () => true,
          input: async (_t, placeholder) => {
            seen.push(placeholder);
            return JSON.stringify({ status: "ok", marker: "M1" });
          },
        },
      })
    );
    assert.equal(verdict, undefined);
    assert.deepEqual(JSON.parse(seen[0]!), { payload: { k: 42 } });
    const tool = h.tools.get("bridge_echo")!;
    const result = await tool.execute("c6", {});
    assert.equal(result.isError, false);
    assert.ok((result.content[0] as { text: string } | undefined)?.text.includes("M1"));

    // Cancelled arm: host cancels the dialog ⇒ call blocked. Blocked calls
    // leave NO memo (leak-free), so execute() reports the honest unrouted
    // routing-bug error.
    const verdict2 = await h.toolCall(
      { toolCallId: "c7", toolName: "bridge_echo", input: { payload: 1 } },
      h.ctx({ ui: { confirm: async () => true, input: async () => undefined } })
    );
    assert.equal(verdict2?.block, true);
    const result2 = await h.tools.get("bridge_echo")!.execute("c7", {});
    assert.equal(result2.isError, true);
    const body2 = JSON.parse((result2.content[0] as { text: string }).text) as { code?: string };
    assert.equal(body2.code, "bridge_echo_unrouted");
  } finally {
    h.restore();
  }
});

test("message_end usage is projected into the audit file", async () => {
  const h = makeHarness();
  try {
    h.messageEnd({ message: { role: "assistant", usage: { input: 5, output: 6, totalTokens: 11, cost: { total: 0.1 } } } });
    h.messageEnd({ message: { role: "assistant" } }); // no usage ⇒ no line
    const usageLines = h.auditLines().filter((l) => l.kind === "usage");
    assert.equal(usageLines.length, 1);
    assert.equal((usageLines[0]!.usage as { totalTokens: number }).totalTokens, 11);
  } finally {
    h.restore();
  }
});

test("invalid rules file installs deny-all (factory must not throw)", async () => {
  const h = makeHarness({ CODAR_GATE_RULES: "/nonexistent/rules.json" });
  try {
    const verdict = await h.toolCall({ toolCallId: "c8", toolName: "read", input: {} }, h.ctx());
    assert.equal(verdict?.block, true);
    assert.ok(String(verdict?.reason).includes("denied by rule"));
  } finally {
    h.restore();
  }
});

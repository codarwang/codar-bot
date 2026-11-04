/**
 * codar-bot RPC driver — spawns a pi subprocess in rpc mode and speaks the
 * JSONL protocol on stdin/stdout (architecture.md §2).
 *
 * Engineering red lines inherited from the WorkerOS adapter's hard-won rules:
 *  - Framing is byte-split-on-LF only. readline is NOT usable: it also splits
 *    on U+2028/U+2029, which are valid inside JSON strings.
 *  - Bounded everything: line bytes, raw stream bytes, idle timeout,
 *    wall-clock timeout, prompt bytes.
 *  - Shutdown: detached-process-group SIGTERM → grace → SIGKILL.
 *  - provider failures surface as explicit errors, never silent success.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

// --- bounds (architecture §2.3: bounded everything) --------------------------

export const LINE_MAX_BYTES = 16 * 1024 * 1024;
export const STREAM_MAX_BYTES = 512 * 1024 * 1024;
export const PROMPT_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_WALL_TIMEOUT_MS = 30 * 60_000;
const SHUTDOWN_GRACE_MS = 2_000;

// --- protocol types (pi 1.5.0 rpc-types, host-side projection) --------------

export interface PromptOptions {
  streamingBehavior?: "steer" | "followUp";
}

export interface UiRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  message?: string;
  placeholder?: string;
  options?: string[];
  timeout?: number;
  [key: string]: unknown;
}

export interface UiResponse {
  type: "extension_ui_response";
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: true;
}

export interface RpcResponse {
  type: "response";
  command: string;
  success: boolean;
  id?: string;
  data?: unknown;
  error?: string;
}

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

export type DriverRecord = RpcResponse | UiRequest | AgentEvent;

function isResponse(r: unknown): r is RpcResponse {
  return (
    typeof r === "object" && r !== null && (r as { type?: unknown }).type === "response" &&
    typeof (r as { command?: unknown }).command === "string"
  );
}
function isUiRequest(r: unknown): r is UiRequest {
  return (
    typeof r === "object" && r !== null &&
    (r as { type?: unknown }).type === "extension_ui_request" &&
    typeof (r as { id?: unknown }).id === "string" &&
    typeof (r as { method?: unknown }).method === "string"
  );
}

// --- framing ------------------------------------------------------------------

/**
 * Byte-level LF framing. Feed chunks; complete lines come back as Buffers
 * (callers decode + JSON.parse). Splits ONLY on 0x0A — U+2028/U+2029 inside
 * JSON strings stay in-line (the WorkerOS readline lesson).
 */
export class LineFramer {
  private buffer: Buffer = Buffer.alloc(0);
  private totalBytes = 0;

  /** Throws when a single line exceeds LINE_MAX_BYTES or the stream exceeds
   *  STREAM_MAX_BYTES (bounded everything — a hostile/hung child cannot
   *  balloon host memory). */
  push(chunk: Buffer): Buffer[] {
    this.totalBytes += chunk.length;
    if (this.totalBytes > STREAM_MAX_BYTES) {
      throw new Error(`rpc stream exceeded STREAM_MAX_BYTES=${STREAM_MAX_BYTES}`);
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const lines: Buffer[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf(0x0a)) !== -1) {
      const line = this.buffer.subarray(0, idx);
      this.buffer = this.buffer.subarray(idx + 1);
      if (line.length > LINE_MAX_BYTES) {
        throw new Error(`rpc line exceeded LINE_MAX_BYTES=${LINE_MAX_BYTES}`);
      }
      if (line.length > 0) lines.push(line);
    }
    return lines;
  }

  /** Bytes buffered but not yet terminated by LF. */
  get pending(): number {
    return this.buffer.length;
  }
}

// --- client -------------------------------------------------------------------

export interface RpcClientOptions {
  /** pi binary (default "pi"). */
  bin?: string;
  /** Extra argv after the fixed rpc flags. */
  extraArgs?: string[];
  /** Working directory for the child (the bot's workspace). */
  cwd?: string;
  /** Extra env (provider keys etc.). */
  env?: Record<string, string>;
  idleTimeoutMs?: number;
  wallTimeoutMs?: number;
  /** Called for every extension_ui_request. Unanswered requests park in the
   *  child; answer with client.replyUi(id, {...}) whenever ready. */
  onUiRequest?: (req: UiRequest) => void;
}

export interface StartOptions {
  extensionPath?: string;
  model?: string;
  thinking?: string;
  noSession?: boolean;
}

interface PendingCommand {
  command: string;
  resolve: (r: RpcResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class RpcClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private readonly framer = new LineFramer();
  private readonly pending = new Map<string, PendingCommand>();
  private idleTimer: NodeJS.Timeout | null = null;
  private wallTimer: NodeJS.Timeout | null = null;
  private idleDeadline = false;
  private exited = false;
  private streamError: Error | null = null;
  private readonly opts: Required<Pick<RpcClientOptions, "idleTimeoutMs" | "wallTimeoutMs">> &
    RpcClientOptions;

  constructor(options: RpcClientOptions = {}) {
    super();
    this.opts = {
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      wallTimeoutMs: options.wallTimeoutMs ?? DEFAULT_WALL_TIMEOUT_MS,
      ...options,
    };
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** Spawn the child and resolve on the first successful `get_state` response
   *  (the ready contract, architecture §2.3a). */
  async start(start: StartOptions = {}): Promise<void> {
    if (this.proc !== null) throw new Error("rpc client already started");
    const args = ["--mode", "rpc", "--no-extensions", "--no-mcp"];
    if (start.noSession !== false) args.push("--no-session");
    if (start.extensionPath) args.push("--extension", start.extensionPath);
    if (start.model) args.push("--model", start.model);
    if (start.thinking) args.push("--thinking", start.thinking);

    this.proc = spawn(this.opts.bin ?? "pi", args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group: SIGTERM reaches the whole tree
    });
    const proc = this.proc;

    proc.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
    proc.stderr!.on("data", (chunk: Buffer) => {
      this.emit("stderr", chunk.toString("utf8"));
    });
    proc.on("error", (err) => this.fail(new Error(`rpc spawn error: ${String(err)}`)));
    proc.on("exit", (code, signal) => {
      this.exited = true;
      this.clearTimers();
      const err =
        this.streamError ??
        new Error(`rpc child exited early (code=${code} signal=${signal})`);
      this.failAllPending(err);
      this.emit("exit", { code, signal, error: this.streamError ? String(this.streamError) : null });
    });

    this.armWall();
    this.armIdle();
    // Ready contract: first successful get_state response.
    await this.command({ type: "get_state" } as const, 30_000);
  }

  private onStdout(chunk: Buffer): void {
    let lines: Buffer[];
    try {
      lines = this.framer.push(chunk);
    } catch (error) {
      this.streamError = error instanceof Error ? error : new Error(String(error));
      this.kill();
      return;
    }
    for (const line of lines) {
      let record: unknown;
      try {
        record = JSON.parse(line.toString("utf8"));
      } catch {
        this.emit("protocol_error", line.toString("utf8").slice(0, 256));
        continue;
      }
      this.armIdle();
      if (isResponse(record)) {
        const byId = record.id !== undefined ? this.pending.get(record.id) : undefined;
        if (byId) {
          clearTimeout(byId.timer);
          this.pending.delete(record.id!);
          byId.resolve(record);
        } else if (!record.success) {
          this.emit("unmatched_error_response", record);
        }
        this.emit("response", record);
        continue;
      }
      if (isUiRequest(record)) {
        this.emit("ui_request", record);
        this.opts.onUiRequest?.(record);
        continue;
      }
      this.emit("event", record as AgentEvent);
      if ((record as { type?: string }).type === "agent_settled") {
        this.emit("settled", record);
      }
    }
  }

  /** Send a command; resolves with the correlated response. */
  command(body: Record<string, unknown>, timeoutMs = 60_000): Promise<RpcResponse> {
    if (this.exited || this.proc === null) {
      return Promise.reject(new Error("rpc child is not running"));
    }
    const id = randomUUID();
    const payload = { ...body, id };
    const bytes = Buffer.from(JSON.stringify(payload) + "\n", "utf8");
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc command "${String(body.type)}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { command: String(body.type), resolve, reject, timer });
      this.proc!.stdin!.write(bytes, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`rpc stdin write failed: ${String(err)}`));
        }
      });
    });
  }

  /** Prompt the agent. */
  prompt(message: string, options: PromptOptions = {}): Promise<RpcResponse> {
    const bytes = Buffer.from(message, "utf8").length;
    if (bytes > PROMPT_MAX_BYTES) {
      return Promise.reject(new Error(`prompt exceeds PROMPT_MAX_BYTES=${PROMPT_MAX_BYTES}`));
    }
    return this.command({
      type: "prompt",
      message,
      ...(options.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
    });
  }

  /** Answer a parked extension_ui_request. NOT a correlated command: the
   *  record's `id` field IS the payload (it must equal the request's id —
   *  routing it through command() would overwrite it with a fresh
   *  correlation id and pi would drop the reply silently). Fire-and-forget
   *  on stdin, like the protocol defines. */
  replyUi(res: UiResponse): void {
    if (this.exited || this.proc === null) {
      this.emit("ui_reply_error", new Error("rpc child is not running"));
      return;
    }
    const bytes = Buffer.from(JSON.stringify({ ...res, type: "extension_ui_response" }) + "\n", "utf8");
    this.proc.stdin!.write(bytes, (err) => {
      if (err) this.emit("ui_reply_error", err);
    });
  }

  abort(): Promise<RpcResponse> {
    return this.command({ type: "abort" } as const);
  }

  private armIdle(): void {
    if (this.idleDeadline) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleDeadline = true;
      this.fail(new Error(`rpc idle timeout after ${this.opts.idleTimeoutMs}ms without a record`));
    }, this.opts.idleTimeoutMs);
  }

  private armWall(): void {
    this.wallTimer = setTimeout(() => {
      this.fail(new Error(`rpc wall-clock timeout after ${this.opts.wallTimeoutMs}ms`));
    }, this.opts.wallTimeoutMs);
  }

  private clearTimers(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.wallTimer) clearTimeout(this.wallTimer);
    this.idleTimer = null;
    this.wallTimer = null;
  }

  private fail(err: Error): void {
    this.streamError = this.streamError ?? err;
    this.emit("error", err);
    this.kill();
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** SIGTERM → grace → SIGKILL (the supervisor pattern). */
  kill(): void {
    this.clearTimers();
    const proc = this.proc;
    if (proc === null || this.exited) return;
    try {
      process.kill(-proc.pid!, "SIGTERM");
    } catch {
      /* group already gone */
    }
    setTimeout(() => {
      if (!this.exited) {
        try {
          process.kill(-proc.pid!, "SIGKILL");
        } catch {
          /* group already gone */
        }
      }
    }, SHUTDOWN_GRACE_MS).unref();
  }
}

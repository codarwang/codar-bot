/**
 * Host assembly — store + ledger + bot-manager + HTTP API (architecture §3).
 * `codar start` boots this; PID/port land in host.json for CLI discovery.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { Store } from "./store.js";
import { UsageLedger } from "./usage-ledger.js";
import { BotManager } from "./bot-manager.js";
import { HttpApi } from "./http-api.js";
import { paths, type HostPaths } from "./paths.js";
import { loadKeys } from "./provider-config.js";

export interface HostOptions {
  dataRoot?: string;
  /** bare-process spawn (tests: fake-pi; dev: real pi). */
  bin?: string;
  /** argv between bin and the rpc flags (tests: the fake-pi fixture path). */
  argv?: string[];
  extensionPath?: string;
  env?: Record<string, string>;
}

export class Host {
  readonly p: HostPaths;
  readonly store: Store;
  readonly ledger: UsageLedger;
  readonly bots: BotManager;
  readonly api: HttpApi;
  private port: number | null = null;
  private running = false;

  private constructor(
    opts: HostOptions,
    store: Store,
    ledger: UsageLedger,
    bots: BotManager,
    api: HttpApi
  ) {
    this.p = paths(opts.dataRoot);
    this.store = store;
    this.ledger = ledger;
    this.bots = bots;
    this.api = api;
  }

  static boot(opts: HostOptions = {}): Host {
    const p = paths(opts.dataRoot);
    for (const dir of [p.root, p.piConfRoot, p.memoryRoot, p.logs]) {
      mkdirSync(dir, { recursive: true });
    }
    const store = Store.openExclusive(p.state, { create: true });
    const ledger = new UsageLedger(p.ledger);
    const keys = loadKeys(p.keys);
    const bots = new BotManager(store, ledger, p.root, {
      bin: opts.bin,
      sandboxArgv: opts.argv,
      extensionPath: opts.extensionPath,
      env: opts.env,
    }, keys);
    const api = new HttpApi({ store, bots, ledger });
    return new Host(opts, store, ledger, bots, api);
  }

  get httpPort(): number | null {
    return this.port;
  }

  async start(): Promise<number> {
    if (this.running) throw new Error("host already running");
    this.running = true;
    const envPort = Number(process.env.CODAR_BOT_PORT);
    this.port = await this.api.listen(Number.isInteger(envPort) && envPort >= 0 ? envPort : 7600);
    writeFileSync(this.p.hostRuntime, JSON.stringify(
      { pid: process.pid, port: this.port, startedAt: new Date().toISOString() }, null, 2));
    return this.port;
  }

  async shutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.bots.stopAll();
    await this.api.close();
    this.ledger.close();
    this.store.close();
    if (existsSync(this.p.hostRuntime)) rmSync(this.p.hostRuntime);
  }
}

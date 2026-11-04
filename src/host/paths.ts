/**
 * Data-directory resolution (architecture §4).
 *
 * CODAR_BOT_HOME overrides the default ~/.codar-bot — tests run against
 * throwaway directories; nothing here may create side effects outside it.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(): string {
  const override = process.env.CODAR_BOT_HOME;
  return override !== undefined && override !== "" ? override : join(homedir(), ".codar-bot");
}

export interface HostPaths {
  root: string;
  state: string;
  keys: string;
  piConfRoot: string;
  memoryRoot: string;
  roomsRoot: string;
  ledger: string;
  audit: string;
  logs: string;
  hostRuntime: string;
}

export function paths(root: string = dataDir()): HostPaths {
  return {
    root,
    state: join(root, "state.json"),
    keys: join(root, "keys.json"),
    piConfRoot: join(root, "pi-conf"),
    memoryRoot: join(root, "memory"),
    roomsRoot: join(root, "rooms"),
    ledger: join(root, "usage.sqlite"),
    audit: join(root, "audit.jsonl"),
    logs: join(root, "logs"),
    hostRuntime: join(root, "host.json"),
  };
}

export function botPiConfDir(root: string, botId: string): string {
  return join(paths(root).piConfRoot, botId);
}

/**
 * First-start bootstrap (architecture §3.2): `codar init` — record the
 * provider key, create the Chief bot and the default room. Runs before the
 * host ever spawns a child; no Bot tool calls involved (no chicken-egg).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";
import { Store, defaultBudget, type BotModelRef } from "./store.js";
import { writeKeys, loadKeys, type KeysDoc } from "./provider-config.js";

export interface InitInput {
  provider: string;
  apiKey: string;
  modelId: string;
  baseUrl?: string;
  thinkingLevel?: string;
  /** Non-interactive callers pass workDir; default lives under the data root. */
  dataRoot?: string;
}

export interface InitResult {
  chiefId: string;
  roomId: string;
  workDir: string;
  keyWritten: boolean;
}

export function initTeam(input: InitInput): InitResult {
  const p = paths(input.dataRoot);
  for (const dir of [p.root, p.piConfRoot, p.memoryRoot, p.roomsRoot, p.logs, join(p.root, "work")]) {
    mkdirSync(dir, { recursive: true });
  }
  // 1. keys.json (merge — init is re-runnable for a second provider).
  const keys: KeysDoc = loadKeys(p.keys);
  const keyExisted = keys.providers[input.provider]?.apiKey !== undefined;
  keys.providers[input.provider] = {
    ...keys.providers[input.provider],
    apiKey: input.apiKey,
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
  };
  writeKeys(p.keys, keys);

  // 2. Chief bot + default room (single-chief invariant: idempotent re-init
  //    keeps the existing chief, only updates the model if given).
  const store = Store.open(p.state, { create: true });
  try {
    const model: BotModelRef = {
      provider: input.provider,
      modelId: input.modelId,
      thinkingLevel: input.thinkingLevel ?? "low",
    };
    let chief = store.chief();
    if (chief === undefined) {
      chief = store.addBot({
        name: "Chief",
        role: "Team coordinator: routes work, manages bots and rooms, reports usage.",
        chief: true,
        model,
        workDir: join(p.root, "work"),
        sessionPath: null,
        sandbox: { mode: "host-not-isolated" },
        budget: defaultBudget(),
      });
    } else if (chief.model.provider !== input.provider || chief.model.modelId !== input.modelId) {
      chief = store.updateBot(chief.id, { model });
    }
    const room =
      store.state.rooms.find((r) => r.name === "default") ??
      store.addRoom({
        name: "default",
        members: [chief.id],
        admin: chief.id,
        mode: "admin-reply",
        sharedDir: join(p.root, "shared"),
        budget: defaultBudget(),
        goal: null,
      });
    return {
      chiefId: chief.id,
      roomId: room.id,
      workDir: chief.workDir,
      keyWritten: !keyExisted,
    };
  } finally {
    store.close();
  }
}

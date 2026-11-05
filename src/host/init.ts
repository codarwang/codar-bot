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
  /** pi KnownApi override (preset default applies when omitted). */
  api?: string;
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
  // Provider names become keys.json members and pi provider ids — restrict
  // to a safe charset (blocks __proto__/constructor prototype escapes).
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.provider)) {
    throw new Error(`invalid provider name "${input.provider}" (use [A-Za-z0-9._-])`);
  }

  // Take the single-writer lock FIRST: a locked-out init must leave NOTHING
  // behind (previously the key was written before the lock threw).
  const store = Store.openExclusive(p.state, { create: true });
  try {
    // 1. keys.json (merge — init is re-runnable for a second provider).
    const keys: KeysDoc = loadKeys(p.keys);
    const keyExisted = Object.hasOwn(keys.providers, input.provider) &&
      keys.providers[input.provider]!.apiKey !== undefined;
    keys.providers[input.provider] = {
      ...(Object.hasOwn(keys.providers, input.provider) ? keys.providers[input.provider] : {}),
      apiKey: input.apiKey,
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.api !== undefined ? { api: input.api } : {}),
    };
    writeKeys(p.keys, keys);

    // 2. Chief bot + default room (single-chief invariant: idempotent).
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
        // M1 chief runs bare by default; docker-default-on lands M3-3.2
        // (PRD §6). The choice is explicit here, not silently downgraded.
        sandbox: { mode: "host-not-isolated" },
        budget: defaultBudget(),
      });
    }
    // A LATER init only adds/updates the KEY. It must never rewrite the
    // chief's model: "register a second provider" and "switch the chief to
    // it" are different intents — model changes go through PATCH (or the
    // UI), not as a side effect of key entry (found in real dual-provider
    // use, 2026-11-05).
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

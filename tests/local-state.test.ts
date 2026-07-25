import { describe, expect, test } from "bun:test";
import { createLocalState } from "../src/local-state.ts";
import type { FsLike } from "../src/settings.ts";
import type { CcProvider } from "../src/types.ts";

function memFs(initial: Record<string, string> = {}): FsLike & {
  store: Record<string, string>;
} {
  const store = { ...initial };
  return {
    store,
    existsSync: (path) => path in store,
    readFileSync: (path) => {
      if (!(path in store)) throw new Error("missing");
      return store[path];
    },
    writeFileSync: (path, data) => {
      store[path] = data;
    },
    renameSync: (from, to) => {
      store[to] = store[from];
      delete store[from];
    },
  };
}

function provider(id = "abc"): CcProvider {
  return {
    id,
    piName: `ps-codex-${id}`,
    displayName: "provider",
    appType: "codex",
    api: "openai-responses",
    baseUrl: "https://example.com",
    apiKey: "key",
    authHeader: true,
    configModels: ["gpt-5"],
    meta: {},
    isCurrentInCc: false,
  };
}

describe("local state interface", () => {
  test("owns paths and selection migration", () => {
    const home = "/home/test";
    const settingsPath = `${home}/.pi/agent/settings.json`;
    const fs = memFs({
      [settingsPath]: JSON.stringify({
        ccSwitchSelection: { provider: "ccs-provider", model: "gpt-5" },
      }),
    });
    const state = createLocalState({ fs, home, pid: 7 });

    const selection = state.readOrMigrateSelection([provider()]);

    expect(selection).toMatchObject({ dbId: "abc", model: "gpt-5" });
    expect(state.readSelection()).toEqual(selection);
    expect(Object.keys(fs.store).some((path) => path.includes("tmp-7"))).toBe(false);
  });

  test("togglePin persists computed pins through one operation", () => {
    const home = "/home/test";
    const configPath = `${home}/.pi/agent/pi-switch.json`;
    const fs = memFs({ [configPath]: "{}" });
    const state = createLocalState({ fs, home, pid: 1 });

    const result = state.togglePin(undefined, {
      dbId: "abc",
      model: "gpt-5",
      label: "provider · gpt-5",
    });

    expect(result).toMatchObject({ ok: true, pinned: true });
    expect(state.readConfig().pins).toEqual(result.pins);
  });

  test("recordRecent de-duplicates, limits, and persists", () => {
    const home = "/home/test";
    const configPath = `${home}/.pi/agent/pi-switch.json`;
    const fs = memFs({ [configPath]: "{}" });
    const state = createLocalState({ fs, home, pid: 1 });

    const first = state.recordRecent(undefined, {
      dbId: "abc",
      model: "gpt-5",
      at: 1,
    }, 2);
    const second = state.recordRecent(first.recent, {
      dbId: "abc",
      model: "gpt-5",
      at: 2,
    }, 2);

    expect(second).toMatchObject({ ok: true });
    expect(second.recent).toEqual([{ dbId: "abc", model: "gpt-5", at: 2 }]);
    expect(state.readConfig().recent).toEqual(second.recent);
  });

  test("provider model metadata preserves neighboring override fields", () => {
    const home = "/home/test";
    const configPath = `${home}/.pi/agent/pi-switch.json`;
    const fs = memFs({
      [configPath]: JSON.stringify({
        providerOverrides: {
          abc: { headers: { "User-Agent": "x" } },
        },
      }),
    });
    const state = createLocalState({ fs, home, pid: 1 });

    const result = state.saveProviderModelMeta(provider(), {
      reasoning: false,
    });

    expect(result.ok).toBe(true);
    expect(state.readConfig().providerOverrides?.abc).toMatchObject({
      headers: { "User-Agent": "x" },
      modelMeta: { reasoning: false },
    });
  });
});

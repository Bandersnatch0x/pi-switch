import { test, expect, describe } from "bun:test";
import {
  migrateLegacySelection,
  pushRecentEntry,
  readPiSwitchConfig,
  readSelection,
  resolveProviderOverride,
  togglePinEntry,
  writePins,
  writeProviderModelMeta,
  writeRecent,
  writeSelection,
  type FsLike,
} from "../src/settings.ts";
import type { CcProvider } from "../src/types.ts";

function memFs(initial: Record<string, string> = {}): FsLike & { store: Record<string, string> } {
  const store = { ...initial };
  return {
    store,
    existsSync: (p) => p in store,
    readFileSync: (p) => {
      if (!(p in store)) throw new Error("missing");
      return store[p];
    },
    writeFileSync: (p, data) => {
      store[p] = data;
    },
    renameSync: (from, to) => {
      store[to] = store[from];
      delete store[from];
    },
  };
}

const provider = (id: string, name: string): CcProvider => ({
  id,
  piName: `ps-codex-${id}`,
  displayName: name,
  appType: "codex",
  api: "openai-responses",
  baseUrl: "https://x",
  apiKey: "k",
  authHeader: true,
  configModels: ["m"],
  meta: {},
  isCurrentInCc: false,
});

describe("selection persistence", () => {
  test("write and read by dbId", () => {
    const fs = memFs();
    const path = "/tmp/settings.json";
    writeSelection(
      fs,
      path,
      { dbId: "abc", model: " m1 ", tab: "codex", appType: "codex", provider: "ps-codex-abc" },
      1,
    );
    const sel = readSelection(fs, path);
    expect(sel?.dbId).toBe("abc");
    expect(sel?.model).toBe("m1");
  });
});

describe("legacy migration", () => {
  test("unique name match migrates", () => {
    const fs = memFs({
      "/s.json": JSON.stringify({
        ccSwitchSelection: { provider: "ccs-sbai", model: "gpt-5" },
      }),
    });
    const sel = migrateLegacySelection(fs, "/s.json", [provider("id1", "sbai")], 1);
    expect(sel?.dbId).toBe("id1");
    expect(sel?.model).toBe("gpt-5");
    expect(readSelection(fs, "/s.json")?.dbId).toBe("id1");
  });

  test("ambiguous name does not migrate", () => {
    const fs = memFs({
      "/s.json": JSON.stringify({
        ccSwitchSelection: { provider: "ccs-x", model: "m" },
      }),
    });
    const sel = migrateLegacySelection(
      fs,
      "/s.json",
      [provider("1", "x"), provider("2", "x")],
      1,
    );
    expect(sel).toBeUndefined();
  });
});

describe("provider modelMeta overrides", () => {
  test("writeProviderModelMeta saves under dbId and preserves headers", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        providerOverrides: {
          abc: {
            label: "old",
            headers: { "User-Agent": "x" },
          },
        },
      }),
    });
    const r = writeProviderModelMeta(
      fs,
      "/c.json",
      { id: "abc", displayName: "elysiver-claude" },
      { reasoning: false, maxTokens: 8192 },
      7,
    );
    expect(r.ok).toBe(true);
    const raw = JSON.parse(fs.store["/c.json"]);
    expect(raw.providerOverrides.abc.headers["User-Agent"]).toBe("x");
    expect(raw.providerOverrides.abc.modelMeta).toEqual({
      reasoning: false,
      maxTokens: 8192,
    });
    expect(raw.providerOverrides.abc.label).toBe("old");
  });

  test("writeProviderModelMeta clears modelMeta only", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        providerOverrides: {
          abc: {
            label: "elysiver-claude",
            headers: { "User-Agent": "x" },
            modelMeta: { reasoning: false },
          },
        },
      }),
    });
    const r = writeProviderModelMeta(
      fs,
      "/c.json",
      { id: "abc", displayName: "elysiver-claude" },
      null,
      7,
    );
    expect(r.ok).toBe(true);
    const raw = JSON.parse(fs.store["/c.json"]);
    expect(raw.providerOverrides.abc.modelMeta).toBeUndefined();
    expect(raw.providerOverrides.abc.headers["User-Agent"]).toBe("x");
  });

  test("resolveProviderOverride matches dbId, piName, displayName, slug", () => {
    const provider = {
      id: "dooongai-1775180253543",
      piName: "elysiver-claude",
      displayName: "elysiver-claude",
    };
    const byId = {
      "dooongai-1775180253543": { modelMeta: { reasoning: false } },
    };
    expect(resolveProviderOverride(byId, provider)?.modelMeta?.reasoning).toBe(false);

    const byName = {
      "elysiver-claude": { modelMeta: { reasoning: false, maxTokens: 1 } },
    };
    expect(resolveProviderOverride(byName, provider)?.modelMeta?.maxTokens).toBe(1);

    const byCase = {
      "Elysiver-Claude": { modelMeta: { contextWindow: 123 } },
    };
    expect(resolveProviderOverride(byCase, provider)?.modelMeta?.contextWindow).toBe(123);
  });

  test("writeProviderModelMeta rejects invalid thinkingFormat", () => {
    const fs = memFs({ "/c.json": "{}" });
    const r = writeProviderModelMeta(
      fs,
      "/c.json",
      { id: "abc", displayName: "x" },
      { thinkingFormat: "not-a-real-format" },
      1,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("invalid thinkingFormat");
  });

  test("writeProviderModelMeta accepts valid thinkingFormat", () => {
    const fs = memFs({ "/c.json": "{}" });
    const r = writeProviderModelMeta(
      fs,
      "/c.json",
      { id: "abc", displayName: "x" },
      { thinkingFormat: "deepseek", reasoning: true },
      1,
    );
    expect(r.ok).toBe(true);
    const raw = JSON.parse(fs.store["/c.json"]);
    expect(raw.providerOverrides.abc.modelMeta.thinkingFormat).toBe("deepseek");
  });

  test("writeProviderModelMeta drops empty shell when only invalid-empty meta", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        providerOverrides: {
          abc: { label: "x", modelMeta: { reasoning: false } },
        },
      }),
    });
    // clear modelMeta and no headers → entry removed
    const r = writeProviderModelMeta(
      fs,
      "/c.json",
      { id: "abc", displayName: "x" },
      null,
      1,
    );
    expect(r.ok).toBe(true);
    const raw = JSON.parse(fs.store["/c.json"]);
    // label-only with no headers/modelMeta is dropped
    expect(raw.providerOverrides.abc).toBeUndefined();
  });

  test("readPiSwitchConfig reads top-level vars", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        vars: { codexVersion: "9.9.9", claudeCodeVersion: "1.2.3" },
        debug: true,
      }),
    });
    const cfg = readPiSwitchConfig(fs, "/c.json");
    expect(cfg.vars?.codexVersion).toBe("9.9.9");
    expect(cfg.vars?.claudeCodeVersion).toBe("1.2.3");
    expect(cfg.debug).toBe(true);
  });
});

describe("pins and recent", () => {
  test("togglePinEntry adds then removes", () => {
    const a = togglePinEntry(undefined, { dbId: "1", model: "m1", label: "p · m1" });
    expect(a.pinned).toBe(true);
    expect(a.pins).toEqual([{ dbId: "1", model: "m1", label: "p · m1" }]);
    const b = togglePinEntry(a.pins, { dbId: "1", model: "m1" });
    expect(b.pinned).toBe(false);
    expect(b.pins).toEqual([]);
  });

  test("pushRecentEntry de-dupes and respects limit", () => {
    let recent = pushRecentEntry(undefined, { dbId: "1", model: "a", at: 1 }, 2);
    recent = pushRecentEntry(recent, { dbId: "2", model: "b", at: 2 }, 2);
    recent = pushRecentEntry(recent, { dbId: "1", model: "a", at: 3 }, 2);
    expect(recent).toHaveLength(2);
    expect(recent[0]).toEqual({ dbId: "1", model: "a", at: 3 });
    expect(recent[1]).toEqual({ dbId: "2", model: "b", at: 2 });
  });

  test("writePins / writeRecent persist", () => {
    const fs = memFs({ "/c.json": "{}" });
    expect(writePins(fs, "/c.json", [{ dbId: "1", model: "m" }], 1).ok).toBe(true);
    expect(writeRecent(fs, "/c.json", [{ dbId: "1", model: "m", at: 9 }], 1).ok).toBe(true);
    const raw = JSON.parse(fs.store["/c.json"]);
    expect(raw.pins).toEqual([{ dbId: "1", model: "m" }]);
    expect(raw.recent).toEqual([{ dbId: "1", model: "m", at: 9 }]);
  });

  test("readPiSwitchConfig parses pins/recent/defaultModelMeta", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        defaultModelMeta: { reasoning: false },
        pins: [{ dbId: "x", model: "y" }],
        recent: [{ dbId: "x", model: "y", at: 1 }],
        recentLimit: 5,
      }),
    });
    const cfg = readPiSwitchConfig(fs, "/c.json");
    expect(cfg.defaultModelMeta).toEqual({ reasoning: false });
    expect(cfg.pins).toEqual([{ dbId: "x", model: "y" }]);
    expect(cfg.recent?.[0].model).toBe("y");
    expect(cfg.recentLimit).toBe(5);
  });
});

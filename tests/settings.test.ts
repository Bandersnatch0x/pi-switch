import { test, expect, describe } from "bun:test";
import {
  clearAllModelMetaOverrides,
  isPinned,
  togglePinAndWrite,
  migrateLegacySelection,
  pushRecentEntry,
  readPiSwitchConfig,
  readSelection,
  resolveProviderOverride,
  togglePinEntry,
  writePins,
  writeModelMetaOverride,
  writeProviderModelMeta,
  writeProviderWireCompat,
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

  test("writeProviderModelMeta accepts full DeepSeek meta", () => {
    const fs = memFs({ "/c.json": "{}" });
    const meta = {
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
      thinkingLevelMap: {
        minimal: "high",
        low: "high",
        medium: "high",
        high: "high",
        xhigh: "max",
      },
    };
    const r = writeProviderModelMeta(
      fs,
      "/c.json",
      { id: "ds", displayName: "deepseek" },
      meta,
      1,
    );
    expect(r.ok).toBe(true);
    const raw = JSON.parse(fs.store["/c.json"]);
    expect(raw.providerOverrides.ds.modelMeta).toEqual(meta);
  });

  test("writeProviderModelMeta rejects invalid thinkingLevelMap key", () => {
    const fs = memFs({ "/c.json": "{}" });
    const r = writeProviderModelMeta(
      fs,
      "/c.json",
      { id: "abc", displayName: "x" },
      { thinkingLevelMap: { nope: "high" } as any },
      1,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("invalid thinkingLevelMap key");
  });

  test("writeProviderModelMeta rejects invalid thinkingLevelMap value", () => {
    const fs = memFs({ "/c.json": "{}" });
    const r = writeProviderModelMeta(
      fs,
      "/c.json",
      { id: "abc", displayName: "x" },
      { thinkingLevelMap: { minimal: "  " } },
      1,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("invalid thinkingLevelMap value");
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

  test("readPiSwitchConfig parses geminiToolCompat", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        geminiToolCompat: {
          mode: "never",
          hosts: ["elysia.h-e.top"],
          forceToolConfigMode: "AUTO",
          blockEmptyToolCalls: false,
          convertSchema: false,
        },
      }),
    });
    const cfg = readPiSwitchConfig(fs, "/c.json");
    expect(cfg.geminiToolCompat).toEqual({
      mode: "never",
      hosts: ["elysia.h-e.top"],
      forceToolConfigMode: "AUTO",
      blockEmptyToolCalls: false,
      convertSchema: false,
    });
  });

  test("readPiSwitchConfig ignores invalid geminiToolCompat", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({ geminiToolCompat: "on" }),
    });
    const cfg = readPiSwitchConfig(fs, "/c.json");
    expect(cfg.geminiToolCompat).toBeUndefined();
  });
});

describe("provider wire compat persistence", () => {
  test("loads nested Provider compat and preserves false", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        providerOverrides: {
          codex: {
            "provider-1": {
              compat: { api: "openai-completions", supportsStore: false },
            },
          },
        },
      }),
    });

    const cfg = readPiSwitchConfig(fs, "/c.json");
    const entry = resolveProviderOverride(cfg.providerOverrides, {
      id: "provider-1",
      piName: "ps-codex-provider-1",
      displayName: "relay",
      appType: "codex",
    });

    expect(entry?.compat).toEqual({
      api: "openai-completions",
      supportsStore: false,
    });
  });

  test("rejects compat outside Provider scope and malformed Provider compat", () => {
    const invalidDocuments = [
      { compat: { api: "openai-completions", supportsStore: true } },
      {
        defaultModelMeta: {
          reasoning: false,
          compat: { api: "openai-completions", supportsStore: true },
        },
      },
      {
        providerOverrides: {
          codex: {
            "provider-1": {
              modelOverrides: {
                model: {
                  compat: { api: "openai-completions", supportsStore: true },
                },
              },
            },
          },
        },
      },
      {
        providerOverrides: {
          codex: {
            "provider-1": {
              modelMeta: {
                reasoning: false,
                compat: { api: "openai-completions", supportsStore: true },
              },
            },
          },
        },
      },
      {
        providerOverrides: {
          codex: { "provider-1": { compat: null } },
        },
      },
      {
        providerOverrides: {
          codex: {
            "provider-1": {
              compat: { api: "openai-responses", supportsStore: true },
            },
          },
        },
      },
      {
        providerOverrides: {
          codex: {
            "provider-1": {
              compat: {
                api: "openai-completions",
                supportsStore: true,
                unknown: false,
              },
            },
          },
        },
      },
    ];

    for (const document of invalidDocuments) {
      const fs = memFs({ "/c.json": JSON.stringify(document) });
      expect(() => readPiSwitchConfig(fs, "/c.json")).toThrow(/compat/i);
    }
  });

  test("writes true and false at Provider scope and clears only compat", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        providerOverrides: {
          codex: {
            "provider-1": { headers: { "User-Agent": "test" } },
          },
        },
      }),
    });
    const chatProvider = {
      ...provider("provider-1", "relay"),
      api: "openai-completions" as const,
    };

    expect(
      writeProviderWireCompat(
        fs,
        "/c.json",
        chatProvider,
        { api: "openai-completions", supportsStore: false },
        1,
      ),
    ).toEqual({ ok: true });
    const loadedFalse = resolveProviderOverride(
      readPiSwitchConfig(fs, "/c.json").providerOverrides,
      chatProvider,
    )?.compat;
    expect(
      loadedFalse && "supportsStore" in loadedFalse ? loadedFalse.supportsStore : undefined,
    ).toBe(false);

    expect(
      writeProviderWireCompat(
        fs,
        "/c.json",
        chatProvider,
        { api: "openai-completions", supportsStore: true },
        1,
      ),
    ).toEqual({ ok: true });
    const loadedTrue = resolveProviderOverride(
      readPiSwitchConfig(fs, "/c.json").providerOverrides,
      chatProvider,
    )?.compat;
    expect(
      loadedTrue && "supportsStore" in loadedTrue ? loadedTrue.supportsStore : undefined,
    ).toBe(true);

    expect(writeProviderWireCompat(fs, "/c.json", chatProvider, null, 1)).toEqual({
      ok: true,
    });
    const entry = resolveProviderOverride(
      readPiSwitchConfig(fs, "/c.json").providerOverrides,
      chatProvider,
    );
    expect(entry?.compat).toBeUndefined();
    expect(entry?.headers).toEqual({ "User-Agent": "test" });
  });

  test("rejects writing Chat compat for a non-Chat Provider", () => {
    const fs = memFs({ "/c.json": "{}" });
    const result = writeProviderWireCompat(
      fs,
      "/c.json",
      provider("provider-1", "relay"),
      { api: "openai-completions", supportsStore: true },
      1,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not match provider api/i);
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

  test("togglePinEntry with appType unpins a migrated pin (no duplicate)", () => {
    // Regression: pre-fix, toggling an appType-less entry on a migrated pin
    // created a duplicate instead of removing it.
    const migrated = [{ dbId: "1", model: "m1", appType: "codex" }];
    // Correct appType entry removes the migrated pin cleanly.
    const removed = togglePinEntry(migrated, { dbId: "1", model: "m1", appType: "codex" });
    expect(removed.pinned).toBe(false);
    expect(removed.pins).toEqual([]);
    // Legacy (no appType) entry against a migrated pin must NOT match → still adds
    // (the picker always passes appType post-fix; this documents the key gap).
    const dup = togglePinEntry(migrated, { dbId: "1", model: "m1" });
    expect(dup.pinned).toBe(true);
    expect(dup.pins).toHaveLength(2);
  });

  test("isPinned matches appType-aware key (post-migration)", () => {
    const pins = [{ dbId: "1", model: "m1", appType: "codex" }];
    expect(isPinned(pins, "1", "m1")).toBe(false); // legacy key misses migrated pin
    expect(isPinned(pins, "1", "m1", "codex")).toBe(true); // composite key matches
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

describe("pin appType round-trip (/ps p duplicate bug)", () => {
  test("readPiSwitchConfig preserves pin/recent appType", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        pins: [{ dbId: "x", model: "y", appType: "claude" }],
        recent: [{ dbId: "x", model: "y", appType: "claude", at: 1 }],
      }),
    });
    const cfg = readPiSwitchConfig(fs, "/c.json");
    expect(cfg.pins?.[0].appType).toBe("claude");
    expect(cfg.recent?.[0].appType).toBe("claude");
  });

  test("togglePinAndWrite second toggle unpins instead of duplicating", () => {
    const fs = memFs({ "/c.json": "{}" });
    const entry = { dbId: "1", model: "m1", appType: "claude", label: "p · m1" };
    const first = togglePinAndWrite(fs, "/c.json", entry, 1);
    expect(first.ok).toBe(true);
    expect(first.pinned).toBe(true);
    const second = togglePinAndWrite(fs, "/c.json", entry, 1);
    expect(second.ok).toBe(true);
    expect(second.pinned).toBe(false);
    expect(second.pins).toEqual([]);
    expect(JSON.parse(fs.store["/c.json"]).pins).toEqual([]);
  });

  test("togglePinAndWrite heals accumulated appType-less duplicates", () => {
    // State produced by the old appType-stripping bug: one migrated pin plus
    // legacy duplicates of the same (dbId, model).
    const fs = memFs({
      "/c.json": JSON.stringify({
        pins: [
          { dbId: "1", model: "m1", appType: "claude" },
          { dbId: "1", model: "m1" },
          { dbId: "1", model: "m1" },
          { dbId: "2", model: "other" },
        ],
      }),
    });
    const r = togglePinAndWrite(fs, "/c.json", { dbId: "1", model: "m1", appType: "claude" }, 1);
    expect(r.pinned).toBe(false);
    expect(r.pins).toEqual([{ dbId: "2", model: "other" }]);
  });
});

describe("override write targets nested [appType][id] (shadowed override bug)", () => {
  test("write with appType lands where resolveProviderOverride reads", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        providerOverrides: {
          claude: { "1": { modelOverrides: { other: { maxTokens: 1 } }, label: "x" } },
        },
      }),
    });
    const p = { id: "1", piName: "ps-claude-1", displayName: "x", appType: "claude" };
    const r = writeModelMetaOverride(
      fs, "/c.json", p, { kind: "model", modelId: "m" }, { maxTokens: 111 }, 1,
    );
    expect(r.ok).toBe(true);
    const cfg = readPiSwitchConfig(fs, "/c.json");
    const entry = resolveProviderOverride(cfg.providerOverrides, p);
    expect(entry?.modelOverrides?.m?.maxTokens).toBe(111);
    expect(entry?.modelOverrides?.other?.maxTokens).toBe(1);
  });

  test("write absorbs a shadowed top-level entry into the nested layer", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        providerOverrides: {
          "1": { modelOverrides: { lost: { maxTokens: 5 } } },
          claude: { "1": { modelOverrides: { other: { maxTokens: 1 } } } },
        },
      }),
    });
    const p = { id: "1", piName: "ps-claude-1", displayName: "x", appType: "claude" };
    writeModelMetaOverride(fs, "/c.json", p, { kind: "model", modelId: "m" }, { maxTokens: 111 }, 1);
    const cfg = readPiSwitchConfig(fs, "/c.json");
    const entry = resolveProviderOverride(cfg.providerOverrides, p);
    expect(entry?.modelOverrides?.m?.maxTokens).toBe(111);
    expect(entry?.modelOverrides?.other?.maxTokens).toBe(1);
    expect(entry?.modelOverrides?.lost?.maxTokens).toBe(5);
    expect(JSON.parse(fs.store["/c.json"]).providerOverrides["1"]).toBeUndefined();
  });

  test("clearAllModelMetaOverrides clears the nested layer", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        providerOverrides: {
          claude: {
            "1": {
              modelMeta: { reasoning: false },
              modelOverrides: { m: { maxTokens: 1 } },
              headers: { "x-h": "v" },
            },
          },
        },
      }),
    });
    const p = { id: "1", piName: "ps-claude-1", displayName: "x", appType: "claude" };
    const r = clearAllModelMetaOverrides(fs, "/c.json", p, 1);
    expect(r.ok).toBe(true);
    const cfg = readPiSwitchConfig(fs, "/c.json");
    const entry = resolveProviderOverride(cfg.providerOverrides, p);
    expect(entry?.modelMeta).toBeUndefined();
    expect(entry?.modelOverrides).toBeUndefined();
    expect(entry?.headers).toEqual({ "x-h": "v" });
  });
});

describe("per-model modelMeta overrides", () => {
  test("model scope writes under modelOverrides[id], keeps provider meta", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        providerOverrides: { abc: { modelMeta: { reasoning: false } } },
      }),
    });
    const r = writeModelMetaOverride(
      fs,
      "/c.json",
      { id: "abc", displayName: "relay" },
      { kind: "model", modelId: "glm-4.6" },
      { maxTokens: 8192 },
      7,
    );
    expect(r.ok).toBe(true);
    const raw = JSON.parse(fs.store["/c.json"]);
    expect(raw.providerOverrides.abc.modelMeta).toEqual({ reasoning: false });
    expect(raw.providerOverrides.abc.modelOverrides["glm-4.6"]).toEqual({
      maxTokens: 8192,
    });
  });

  test("model scope writes exact id without rewriting a matching glob", () => {
    // Editing gpt-5-pro must not clobber the broader gpt-5* rule.
    const fs = memFs({
      "/c.json": JSON.stringify({
        providerOverrides: { abc: { modelOverrides: { "gpt-5*": { reasoning: true } } } },
      }),
    });
    writeModelMetaOverride(
      fs,
      "/c.json",
      { id: "abc", displayName: "relay" },
      { kind: "model", modelId: "gpt-5-pro" },
      { reasoning: false },
      7,
    );
    const raw = JSON.parse(fs.store["/c.json"]);
    expect(Object.keys(raw.providerOverrides.abc.modelOverrides).sort()).toEqual([
      "gpt-5*",
      "gpt-5-pro",
    ]);
    expect(raw.providerOverrides.abc.modelOverrides["gpt-5*"]).toEqual({ reasoning: true });
    expect(raw.providerOverrides.abc.modelOverrides["gpt-5-pro"]).toEqual({
      reasoning: false,
    });
  });

  test("model scope clear drops only that model key", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        providerOverrides: {
          abc: {
            modelOverrides: { "glm-4.6": { reasoning: false }, "gpt-5": { maxTokens: 1 } },
          },
        },
      }),
    });
    writeModelMetaOverride(
      fs,
      "/c.json",
      { id: "abc", displayName: "relay" },
      { kind: "model", modelId: "glm-4.6" },
      null,
      7,
    );
    const raw = JSON.parse(fs.store["/c.json"]);
    expect(Object.keys(raw.providerOverrides.abc.modelOverrides)).toEqual(["gpt-5"]);
  });

  test("provider-scope clear keeps per-model overrides", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        providerOverrides: {
          abc: {
            modelMeta: { reasoning: false },
            modelOverrides: { "glm-4.6": { maxTokens: 1 } },
          },
        },
      }),
    });
    writeProviderModelMeta(fs, "/c.json", { id: "abc", displayName: "relay" }, null, 7);
    const raw = JSON.parse(fs.store["/c.json"]);
    expect(raw.providerOverrides.abc.modelMeta).toBeUndefined();
    expect(raw.providerOverrides.abc.modelOverrides["glm-4.6"]).toEqual({ maxTokens: 1 });
  });

  test("clearAllModelMetaOverrides wipes both layers and empty entry", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        providerOverrides: {
          abc: {
            label: "relay",
            modelMeta: { reasoning: false },
            modelOverrides: { "glm-4.6": { maxTokens: 1 } },
          },
        },
      }),
    });
    clearAllModelMetaOverrides(fs, "/c.json", { id: "abc", displayName: "relay" }, 7);
    const raw = JSON.parse(fs.store["/c.json"]);
    expect(raw.providerOverrides.abc).toBeUndefined();
  });

  test("clearAllModelMetaOverrides keeps headers/fingerprint", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        providerOverrides: {
          abc: {
            fingerprint: "codex",
            headers: { "User-Agent": "x" },
            modelOverrides: { "glm-4.6": { maxTokens: 1 } },
          },
        },
      }),
    });
    clearAllModelMetaOverrides(fs, "/c.json", { id: "abc", displayName: "relay" }, 7);
    const raw = JSON.parse(fs.store["/c.json"]);
    expect(raw.providerOverrides.abc.fingerprint).toBe("codex");
    expect(raw.providerOverrides.abc.modelOverrides).toBeUndefined();
  });

  test("model scope rejects invalid thinkingFormat", () => {
    const fs = memFs();
    const r = writeModelMetaOverride(
      fs,
      "/c.json",
      { id: "abc", displayName: "relay" },
      { kind: "model", modelId: "glm-4.6" },
      { thinkingFormat: "nope" },
      7,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("invalid thinkingFormat");
  });

  test("model scope rejects empty model id", () => {
    const fs = memFs();
    const r = writeModelMetaOverride(
      fs,
      "/c.json",
      { id: "abc", displayName: "relay" },
      { kind: "model", modelId: "   " },
      { reasoning: false },
      7,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("empty model id");
  });
});

import { describe, expect, test } from "bun:test";
import type { FsLike } from "../src/json-file.ts";
import {
  createProviderMirror,
  mergeProviderEntry,
  planProviderSync,
  sanitizeProviderEntry,
  stableJson,
  syncPersistedProviders,
  type ProviderMirrorEntry,
} from "../src/persistent-providers.ts";
import type { BuiltProviderConfig } from "../src/register.ts";

const MODELS_PATH = "/home/.pi/agent/models.json";
const STATE_PATH = "/home/.pi/agent/pi-switch-persisted-providers.json";

function memFs(initial: Record<string, string> = {}): FsLike & {
  store: Record<string, string>;
  writes: string[];
} {
  const store = { ...initial };
  const writes: string[] = [];
  return {
    store,
    writes,
    existsSync: (path) => path in store,
    readFileSync: (path) => {
      if (!(path in store)) throw new Error(`ENOENT: ${path}`);
      return store[path]!;
    },
    writeFileSync: (path, data) => {
      store[path] = data;
      writes.push(path);
    },
    renameSync: (from, to) => {
      store[to] = store[from]!;
      delete store[from];
    },
    unlinkSync: (path) => {
      delete store[path];
    },
  };
}

/** Tiny deterministic digest — enough to tell two entries apart in tests. */
function digest(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
}

function io(fs: FsLike) {
  return { fs, modelsPath: MODELS_PATH, statePath: STATE_PATH, pid: 4242, digest };
}

function config(overrides: Partial<BuiltProviderConfig> = {}): BuiltProviderConfig {
  return {
    name: "cline-e5a5ddc3",
    baseUrl: "https://relay.example.com/v1",
    apiKey: "sk-secret",
    api: "openai-completions",
    authHeader: false,
    models: [
      {
        id: "cline-pass/deepseek-v4.1-flash",
        name: "cline-pass/deepseek-v4.1-flash",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
    ],
    ...overrides,
  } as BuiltProviderConfig;
}

function readModels(fs: FsLike & { store: Record<string, string> }): Record<string, unknown> {
  const source = fs.store[MODELS_PATH];
  return source ? (JSON.parse(source) as Record<string, unknown>) : {};
}

describe("persistent provider entries", () => {
  test("sanitize keeps only keys models.json validates", () => {
    const entry = sanitizeProviderEntry({
      ...config(),
      internalDebugFlag: true,
      models: [
        {
          ...config().models[0]!,
          piSwitchInternal: "x",
        },
      ],
    } as unknown as BuiltProviderConfig);

    expect(Object.keys(entry).sort()).toEqual([
      "api",
      "apiKey",
      "authHeader",
      "baseUrl",
      "models",
      "name",
    ]);
    const [model] = entry.models as Record<string, unknown>[];
    expect(model!.piSwitchInternal).toBeUndefined();
    expect(model!.maxTokens).toBe(64_000);
  });

  test("models without an id are dropped instead of written half-formed", () => {
    const entry = sanitizeProviderEntry({
      ...config(),
      models: [{ name: "no id" }],
    } as unknown as BuiltProviderConfig);
    expect(entry.models).toBeUndefined();
  });

  test("merge unions model ids and lets the later registration win", () => {
    const first = sanitizeProviderEntry(config());
    const second = sanitizeProviderEntry(
      config({
        models: [
          {
            id: "cline-pass/deepseek-v4.1-flash",
            name: "renamed",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1_000_000,
            maxTokens: 8_192,
          },
        ],
      } as Partial<BuiltProviderConfig>),
    );

    const merged = mergeProviderEntry(first, second);
    const models = merged.models as Record<string, unknown>[];
    expect(models).toHaveLength(1);
    expect(models[0]!.maxTokens).toBe(8_192);
    expect(models[0]!.contextWindow).toBe(1_000_000);
  });

  test("stableJson ignores property order so digests are comparable", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});

describe("provider mirror", () => {
  test("re-registering one model id does not shrink the provider entry", () => {
    const mirror = createProviderMirror();
    mirror.record("ps-codex-a", config());
    mirror.record(
      "ps-codex-a",
      config({
        models: [
          {
            id: "gpt-5.6-sol",
            name: "gpt-5.6-sol",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 400_000,
            maxTokens: 32_000,
          },
        ],
      } as Partial<BuiltProviderConfig>),
    );

    const [entry] = mirror.entries();
    const ids = (entry!.config.models as Record<string, unknown>[]).map((model) => model.id);
    expect(ids).toHaveLength(2);
  });

  test("forget drops entries so a later sync prunes them", () => {
    const mirror = createProviderMirror();
    mirror.record("ps-codex-a", config());
    mirror.record("ps-codex-b", config({ name: "ps-codex-b" }));
    mirror.forget(["ps-codex-a"]);
    expect(mirror.entries().map((entry) => entry.name)).toEqual(["ps-codex-b"]);
  });
});

describe("planProviderSync", () => {
  const desired = (name: string, value: Record<string, unknown> = { id: name }): ProviderMirrorEntry => ({
    name,
    config: value,
  });

  test("absent names are written and recorded as owned", () => {
    const plan = planProviderSync({
      existing: {},
      owned: {},
      desired: [desired("a")],
      digest,
    });
    expect(plan.writes.map((entry) => entry.name)).toEqual(["a"]);
    expect(plan.nextOwned.a).toBe(digest(stableJson({ id: "a" })));
    expect(plan.valueChanged).toBe(true);
  });

  test("identical existing content is adopted without a rewrite", () => {
    const plan = planProviderSync({
      existing: { a: { id: "a" } },
      owned: {},
      desired: [desired("a")],
      digest,
    });
    expect(plan.writes).toHaveLength(0);
    expect(plan.valueChanged).toBe(false);
    expect(plan.ownershipChanged).toBe(true);
    expect(plan.nextOwned).toEqual({ a: digest(stableJson({ id: "a" })) });
  });

  test("owned names are rewritten when their content drifted", () => {
    // The digest records what pi-switch wrote last time, not what is desired now.
    const owned = { a: digest(stableJson({ id: "a", stale: true })) };
    const plan = planProviderSync({
      existing: { a: { id: "a", stale: true } },
      owned,
      desired: [desired("a")],
      digest,
    });
    expect(plan.writes.map((entry) => entry.name)).toEqual(["a"]);
    expect(plan.conflicts).toEqual([]);
  });

  test("foreign content under a wanted name is a conflict, never an overwrite", () => {
    const plan = planProviderSync({
      existing: { a: { handWritten: true } },
      owned: { a: digest(stableJson({ id: "a", stale: true })) },
      desired: [desired("a")],
      digest,
    });
    expect(plan.writes).toHaveLength(0);
    expect(plan.conflicts).toEqual(["a"]);
    expect(plan.nextOwned).toEqual({});
  });

  test("owned names that are no longer desired are pruned", () => {
    const plan = planProviderSync({
      existing: { a: { id: "a" }, b: { id: "b" } },
      owned: { a: digest(stableJson({ id: "a" })), b: digest(stableJson({ id: "b" })) },
      desired: [desired("b")],
      digest,
    });
    expect(plan.removals).toEqual(["a"]);
    expect(plan.nextOwned).toEqual({ b: digest(stableJson({ id: "b" })) });
  });

  test("externally edited content is left behind and ownership is dropped", () => {
    const plan = planProviderSync({
      existing: { a: { handEdited: true } },
      owned: { a: digest(stableJson({ id: "a" })) },
      desired: [],
      digest,
    });
    expect(plan.removals).toEqual([]);
    expect(plan.nextOwned).toEqual({});
    expect(plan.valueChanged).toBe(false);
    expect(plan.ownershipChanged).toBe(true);
  });
});

describe("syncPersistedProviders", () => {
  test("writes into models.json without touching foreign providers or keys", () => {
    const fs = memFs({
      [MODELS_PATH]: JSON.stringify({
        providers: { answers: { baseUrl: "https://answers.example.com" } },
        unknownTopLevelKey: { keep: true },
      }),
    });

    const result = syncPersistedProviders(io(fs), [
      { name: "cline-e5a5ddc3", config: sanitizeProviderEntry(config()) },
    ]);

    expect(result.ok).toBe(true);
    expect(result.written).toEqual(["cline-e5a5ddc3"]);
    const document = readModels(fs);
    expect(document.unknownTopLevelKey).toEqual({ keep: true });
    const providers = document.providers as Record<string, unknown>;
    expect(providers.answers).toEqual({ baseUrl: "https://answers.example.com" });
    expect(providers["cline-e5a5ddc3"]).toBeDefined();
  });

  test("creates models.json when the host never had one", () => {
    const fs = memFs();
    const result = syncPersistedProviders(io(fs), [
      { name: "ps-codex-a", config: sanitizeProviderEntry(config()) },
    ]);
    expect(result.ok).toBe(true);
    expect(readModels(fs).providers).toBeDefined();
  });

  test("prunes the previous provider on switch and keeps the sidecar in sync", () => {
    const fs = memFs();
    syncPersistedProviders(io(fs), [
      { name: "ps-codex-a", config: sanitizeProviderEntry(config()) },
    ]);
    syncPersistedProviders(io(fs), [
      { name: "ps-codex-b", config: sanitizeProviderEntry(config({ name: "ps-codex-b" })) },
    ]);

    const providers = readModels(fs).providers as Record<string, unknown>;
    expect(Object.keys(providers)).toEqual(["ps-codex-b"]);
    const state = JSON.parse(fs.store[STATE_PATH]!) as { owned: Record<string, string> };
    expect(Object.keys(state.owned)).toEqual(["ps-codex-b"]);
  });

  test("repeat syncs are no-ops", () => {
    const fs = memFs();
    const desired = [{ name: "ps-codex-a", config: sanitizeProviderEntry(config()) }];
    syncPersistedProviders(io(fs), desired);
    const before = fs.store[MODELS_PATH]!;
    const writesBefore = fs.writes.length;

    const again = syncPersistedProviders(io(fs), desired);
    expect(again.written).toEqual([]);
    expect(fs.store[MODELS_PATH]).toBe(before);
    expect(fs.writes.length).toBe(writesBefore);
  });

  test("a foreign same-named entry blocks the write and is reported", () => {
    const fs = memFs({
      [MODELS_PATH]: JSON.stringify({ providers: { "ps-codex-a": { handWritten: true } } }),
    });

    const result = syncPersistedProviders(io(fs), [
      { name: "ps-codex-a", config: sanitizeProviderEntry(config()) },
    ]);

    expect(result.ok).toBe(true);
    expect(result.written).toEqual([]);
    expect(result.conflicts).toEqual(["ps-codex-a"]);
    const providers = readModels(fs).providers as Record<string, unknown>;
    expect(providers["ps-codex-a"]).toEqual({ handWritten: true });
  });

  test("a corrupt models.json is left untouched and reported", () => {
    const fs = memFs({ [MODELS_PATH]: "{ not json" });
    const result = syncPersistedProviders(io(fs), [
      { name: "ps-codex-a", config: sanitizeProviderEntry(config()) },
    ]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not valid JSON");
    expect(fs.store[MODELS_PATH]).toBe("{ not json");
  });

  test("an empty mirror with no ownership never creates a file", () => {
    const fs = memFs();
    const result = syncPersistedProviders(io(fs), []);
    expect(result.ok).toBe(true);
    expect(fs.store[MODELS_PATH]).toBeUndefined();
    expect(fs.writes).toEqual([]);
  });
});

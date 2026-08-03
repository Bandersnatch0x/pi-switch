import { test, expect, describe } from "bun:test";
import {
  CAPABILITIES_FAILURE_COOLDOWN_MS,
  CAPABILITIES_TTL_MS,
  extractModelsDevCapabilities,
  findModelsDevEntry,
  isModelsDevMiss,
  makeMiss,
  MODELS_DEV_API_URL,
  shouldRefreshModelsDev,
} from "../src/capabilities/models-dev.ts";
import { resolveModelCapabilities } from "../src/capabilities/resolve.ts";

const SAMPLE_CATALOG = {
  vivgrid: {
    id: "vivgrid",
    models: {
      "gpt-5.6-sol": {
        id: "gpt-5.6-sol",
        limit: { context: 1000000, output: 384000 },
        reasoning: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        last_updated: "2026-04-24",
      },
    },
  },
};

describe("models.dev extractor (W4)", () => {
  test("finds model across providers and extracts 4 fields + provenance", () => {
    const hit = findModelsDevEntry(SAMPLE_CATALOG, "gpt-5.6-sol");
    expect(hit?.provider).toBe("vivgrid");
    const cap = extractModelsDevCapabilities(hit!.model, "2026-07-31T00:00:00Z");
    expect(cap).toEqual({
      contextWindow: 1000000,
      maxTokens: 384000,
      reasoning: true,
      vision: true,
      observedAt: "2026-04-24",
      source: "models-dev",
    });
  });

  test("missing model id yields undefined", () => {
    expect(findModelsDevEntry(SAMPLE_CATALOG, "nope")).toBeUndefined();
    expect(findModelsDevEntry(null, "x")).toBeUndefined();
  });

  test("missing fields stay undefined; fetch time used as observedAt", () => {
    const hit = findModelsDevEntry({ p: { models: { m: { id: "m" } } } }, "m");
    const cap = extractModelsDevCapabilities(hit!.model, "2026-07-31T00:00:00Z");
    expect(cap.contextWindow).toBeUndefined();
    expect(cap.maxTokens).toBeUndefined();
    expect(cap.reasoning).toBeUndefined();
    expect(cap.vision).toBeUndefined();
    expect(cap.observedAt).toBe("2026-07-31T00:00:00Z");
  });

  test("api url is the full-catalog endpoint", () => {
    expect(MODELS_DEV_API_URL).toBe("https://models.dev/api.json");
  });
});

describe("models.dev negative cache helpers (issue #39)", () => {
  test("isModelsDevMiss / makeMiss shape", () => {
    const miss = makeMiss("2026-08-03T00:00:00Z");
    expect(miss).toEqual({ missing: true, observedAt: "2026-08-03T00:00:00Z" });
    expect(isModelsDevMiss(miss)).toBe(true);
    expect(
      isModelsDevMiss({
        contextWindow: 1,
        observedAt: "2026-08-03T00:00:00Z",
        source: "models-dev",
      }),
    ).toBe(false);
    expect(isModelsDevMiss(undefined)).toBe(false);
  });

  test("shouldRefreshModelsDev truth table", () => {
    const now = Date.parse("2026-08-03T00:00:00Z");
    const ttl = CAPABILITIES_TTL_MS;
    const cooldown = CAPABILITIES_FAILURE_COOLDOWN_MS;
    const fresh = new Date(now - 1000).toISOString();
    const stale = new Date(now - ttl - 1).toISOString();

    // cold → true
    expect(
      shouldRefreshModelsDev({ entry: undefined, now, ttlMs: ttl, cooldownMs: cooldown }),
    ).toBe(true);

    // fresh positive → false
    expect(
      shouldRefreshModelsDev({
        entry: { observedAt: fresh, source: "models-dev" },
        now,
        ttlMs: ttl,
        cooldownMs: cooldown,
      }),
    ).toBe(false);

    // fresh negative → false
    expect(
      shouldRefreshModelsDev({
        entry: makeMiss(fresh),
        now,
        ttlMs: ttl,
        cooldownMs: cooldown,
      }),
    ).toBe(false);

    // stale positive → true
    expect(
      shouldRefreshModelsDev({
        entry: { observedAt: stale, source: "models-dev" },
        now,
        ttlMs: ttl,
        cooldownMs: cooldown,
      }),
    ).toBe(true);

    // stale negative → true
    expect(
      shouldRefreshModelsDev({
        entry: makeMiss(stale),
        now,
        ttlMs: ttl,
        cooldownMs: cooldown,
      }),
    ).toBe(true);

    // cooldown active → false even when cold
    expect(
      shouldRefreshModelsDev({
        entry: undefined,
        now,
        ttlMs: ttl,
        failedAt: now - 1000,
        cooldownMs: cooldown,
      }),
    ).toBe(false);

    // bad timestamp → false (last-good)
    expect(
      shouldRefreshModelsDev({
        entry: { observedAt: "not-a-date", source: "models-dev" },
        now,
        ttlMs: ttl,
        cooldownMs: cooldown,
      }),
    ).toBe(false);
  });
});

describe("resolveModelCapabilities (W4)", () => {
  const md = {
    contextWindow: 1000000,
    maxTokens: 384000,
    reasoning: true,
    vision: true,
    observedAt: "2026-04-24",
    source: "models-dev" as const,
  };
  const defaults = { contextWindow: 400000, maxTokens: 128000, reasoning: true, vision: true };

  test("user override wins and never conflicts", () => {
    // defaults aligned with models.dev on non-overridden fields, so the only
    // layer divergence is user-vs-models.dev which never warns.
    const r = resolveModelCapabilities({
      user: { contextWindow: 200000, reasoning: false },
      modelsDev: md,
      defaults: { ...defaults, maxTokens: 384000 },
    });
    expect(r.contextWindow).toMatchObject({ value: 200000, source: "user-override" });
    expect(r.maxTokens).toMatchObject({ value: 384000, source: "models-dev" });
    expect(r.conflicts).toEqual([]);
  });

  test("lower-layer disagreement surfaces as conflict", () => {
    const r = resolveModelCapabilities({
      modelsDev: md,
      ccMeta: { contextWindow: 128000 },
      defaults,
    });
    expect(r.contextWindow.value).toBe(1000000);
    expect(r.conflicts).toContainEqual(
      expect.objectContaining({
        field: "contextWindow",
        effectiveSource: "models-dev",
        overriddenSource: "cc-meta",
      }),
    );
  });

  test("protocol default is the floor when no other layer supplies a field", () => {
    const r = resolveModelCapabilities({ defaults });
    expect(r.contextWindow).toMatchObject({ value: 400000, source: "protocol-default" });
    expect(r.reasoning).toMatchObject({ value: true, source: "protocol-default" });
  });

  test("stale models.dev fact is flagged and keeps last-good", () => {
    const staleMd = {
      contextWindow: 1000000,
      maxTokens: 384000,
      reasoning: true,
      vision: true,
      observedAt: "2020-01-01T00:00:00Z",
      source: "models-dev" as const,
    };
    const r = resolveModelCapabilities({
      modelsDev: staleMd,
      defaults,
      now: Date.parse("2026-07-31T00:00:00Z"),
      staleThresholdMs: 90 * 24 * 60 * 60 * 1000,
    });
    expect(r.contextWindow.value).toBe(1000000); // last-good kept
    expect(r.contextWindow.stale).toBe(true);
  });

  test("six-layer priority: user > idTag > host > models.dev > cc-meta > default", () => {
    const r = resolveModelCapabilities({
      user: { contextWindow: 111 },
      idTag: { contextWindow: 222 },
      hostAdaptation: { contextWindow: 333 },
      modelsDev: { ...md, contextWindow: 444 },
      ccMeta: { contextWindow: 555 },
      defaults: { ...defaults, contextWindow: 666 },
    });
    expect(r.contextWindow).toMatchObject({ value: 111, source: "user-override" });

    const r2 = resolveModelCapabilities({
      idTag: { contextWindow: 222 },
      hostAdaptation: { contextWindow: 333 },
      modelsDev: { ...md, contextWindow: 444 },
      ccMeta: { contextWindow: 555 },
      defaults: { ...defaults, contextWindow: 666 },
    });
    expect(r2.contextWindow).toMatchObject({ value: 222, source: "model-id-tag" });

    const r3 = resolveModelCapabilities({
      hostAdaptation: { contextWindow: 333 },
      modelsDev: { ...md, contextWindow: 444 },
      ccMeta: { contextWindow: 555 },
      defaults: { ...defaults, contextWindow: 666 },
    });
    expect(r3.contextWindow).toMatchObject({ value: 333, source: "host-adaptation" });

    const r4 = resolveModelCapabilities({
      modelsDev: { ...md, contextWindow: 444 },
      ccMeta: { contextWindow: 555 },
      defaults: { ...defaults, contextWindow: 666 },
    });
    expect(r4.contextWindow).toMatchObject({ value: 444, source: "models-dev" });

    const r5 = resolveModelCapabilities({
      ccMeta: { contextWindow: 555 },
      defaults: { ...defaults, contextWindow: 666 },
    });
    expect(r5.contextWindow).toMatchObject({ value: 555, source: "cc-meta" });
  });

  test("idTag over models-dev conflicts; user over idTag does not", () => {
    const conflict = resolveModelCapabilities({
      idTag: { contextWindow: 1_000_000 },
      modelsDev: { ...md, contextWindow: 200_000 },
      defaults,
    });
    expect(conflict.contextWindow).toMatchObject({
      value: 1_000_000,
      source: "model-id-tag",
    });
    expect(conflict.conflicts).toContainEqual(
      expect.objectContaining({
        field: "contextWindow",
        effectiveSource: "model-id-tag",
        overriddenSource: "models-dev",
      }),
    );

    const noConflict = resolveModelCapabilities({
      user: { contextWindow: 512_000 },
      idTag: { contextWindow: 1_000_000 },
      defaults,
    });
    expect(noConflict.contextWindow).toMatchObject({
      value: 512_000,
      source: "user-override",
    });
    expect(noConflict.conflicts).toEqual([]);
  });

  test("stale models.dev still acts as last-good under registration layers", () => {
    const staleMd = {
      contextWindow: 200_000,
      maxTokens: 8_192,
      reasoning: false,
      vision: false,
      observedAt: "2020-01-01T00:00:00Z",
      source: "models-dev" as const,
    };
    // No higher layer for maxTokens → stale models.dev still wins (last-good).
    const r = resolveModelCapabilities({
      idTag: { contextWindow: 1_000_000 },
      modelsDev: staleMd,
      defaults,
      now: Date.parse("2026-07-31T00:00:00Z"),
      staleThresholdMs: 90 * 24 * 60 * 60 * 1000,
    });
    expect(r.contextWindow).toMatchObject({ value: 1_000_000, source: "model-id-tag" });
    expect(r.maxTokens).toMatchObject({ value: 8_192, source: "models-dev", stale: true });
  });
});

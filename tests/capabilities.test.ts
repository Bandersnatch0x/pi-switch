import { test, expect, describe } from "bun:test";
import {
  extractModelsDevCapabilities,
  findModelsDevEntry,
  MODELS_DEV_API_URL,
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
});

import { test, expect, describe } from "bun:test";
import {
  cleanModelMeta,
  countModelOverrides,
  matchModelOverride,
  mergeModelMeta,
  resolveModelMetaLayers,
  getModelMetaPreset,
  MODEL_META_PRESETS,
  resolveEffectiveModelMeta,
  summarizeModelMeta,
} from "../src/model-meta.ts";

describe("model-meta presets", () => {
  test("has relay-safe and full-reasoning", () => {
    expect(MODEL_META_PRESETS.map((p) => p.id).sort()).toEqual([
      "full-reasoning",
      "relay-safe",
    ]);
    expect(getModelMetaPreset("relay-safe")?.modelMeta).toEqual({ reasoning: false });
    expect(getModelMetaPreset("full-reasoning")?.modelMeta).toEqual({ reasoning: true });
  });
});

describe("cleanModelMeta", () => {
  test("drops invalid fields", () => {
    expect(
      cleanModelMeta({
        reasoning: true,
        thinkingFormat: "  ",
        contextWindow: -1,
        maxTokens: 100.7,
      } as any),
    ).toEqual({ reasoning: true, maxTokens: 100 });
  });
  test("drops unknown thinkingFormat", () => {
    expect(
      cleanModelMeta({
        reasoning: false,
        thinkingFormat: "nope-format",
      } as any),
    ).toEqual({ reasoning: false });
    expect(
      cleanModelMeta({
        thinkingFormat: "nope-format",
      } as any),
    ).toBeUndefined();
    expect(
      cleanModelMeta({
        thinkingFormat: "openai",
      }),
    ).toEqual({ thinkingFormat: "openai" });
  });
  test("undefined for empty", () => {
    expect(cleanModelMeta({})).toBeUndefined();
    expect(cleanModelMeta(null)).toBeUndefined();
  });
});

describe("resolveEffectiveModelMeta", () => {
  test("provider override wins over default", () => {
    const meta = resolveEffectiveModelMeta(
      {
        defaultModelMeta: { reasoning: false },
        providerOverrides: {
          abc: { modelMeta: { reasoning: true, contextWindow: 1000 } },
        },
      },
      { id: "abc", piName: "ps", displayName: "x" },
    );
    expect(meta).toEqual({ reasoning: true, contextWindow: 1000 });
  });
  test("falls back to defaultModelMeta", () => {
    const meta = resolveEffectiveModelMeta(
      { defaultModelMeta: { reasoning: false } },
      { id: "none", piName: "ps", displayName: "x" },
    );
    expect(meta).toEqual({ reasoning: false });
  });
});

describe("summarizeModelMeta", () => {
  test("default label", () => {
    expect(summarizeModelMeta(undefined)).toBe("默认协议档");
  });
  test("lists fields", () => {
    expect(summarizeModelMeta({ reasoning: false, maxTokens: 8 })).toBe(
      "reasoning=false, maxTokens=8",
    );
  });
});

describe("mergeModelMeta", () => {
  test("later layers win per field, unset never clobbers", () => {
    expect(
      mergeModelMeta({ reasoning: false, maxTokens: 8 }, { maxTokens: 16 }),
    ).toEqual({ reasoning: false, maxTokens: 16 });
  });
  test("undefined when all layers empty", () => {
    expect(mergeModelMeta(undefined, {}, null as never)).toBeUndefined();
  });
});

describe("matchModelOverride", () => {
  const map = {
    "glm-4.6": { reasoning: false },
    "gpt-5*": { maxTokens: 128_000 },
    "gpt-5-codex*": { maxTokens: 64_000 },
    "Claude-Sonnet": { reasoning: true },
  };

  test("exact id wins", () => {
    expect(matchModelOverride(map, "glm-4.6")).toEqual({
      key: "glm-4.6",
      modelMeta: { reasoning: false },
    });
  });
  test("case-insensitive exact before glob", () => {
    expect(matchModelOverride(map, "claude-sonnet")?.key).toBe("Claude-Sonnet");
  });
  test("most specific glob wins", () => {
    expect(matchModelOverride(map, "gpt-5-codex-high")?.key).toBe("gpt-5-codex*");
    expect(matchModelOverride(map, "gpt-5-pro")?.key).toBe("gpt-5*");
  });
  test("no match / no model id", () => {
    expect(matchModelOverride(map, "kimi-k2")).toBeUndefined();
    expect(matchModelOverride(map, undefined)).toBeUndefined();
    expect(matchModelOverride(undefined, "gpt-5")).toBeUndefined();
  });
});

describe("model-scope layering", () => {
  const config = {
    defaultModelMeta: { reasoning: false, contextWindow: 128_000 },
    providerOverrides: {
      abc: {
        modelMeta: { contextWindow: 200_000 },
        modelOverrides: {
          "glm-4.6": { maxTokens: 8_192 },
          "gpt-5*": { reasoning: true },
        },
      },
    },
  };
  const provider = { id: "abc", piName: "ps", displayName: "x" };

  test("model layer merges on top of provider and default", () => {
    expect(resolveEffectiveModelMeta(config, provider, "glm-4.6")).toEqual({
      reasoning: false,
      contextWindow: 200_000,
      maxTokens: 8_192,
    });
  });
  test("glob model layer can flip a default field", () => {
    expect(resolveEffectiveModelMeta(config, provider, "gpt-5-pro")).toEqual({
      reasoning: true,
      contextWindow: 200_000,
    });
  });
  test("unmatched model falls back to provider ⊕ default", () => {
    expect(resolveEffectiveModelMeta(config, provider, "kimi-k2")).toEqual({
      reasoning: false,
      contextWindow: 200_000,
    });
  });
  test("layers expose base / provider / model and inherited-for-model", () => {
    const layers = resolveModelMetaLayers(config, provider, "glm-4.6");
    expect(layers.base).toEqual({ reasoning: false, contextWindow: 128_000 });
    expect(layers.provider).toEqual({ contextWindow: 200_000 });
    expect(layers.model).toEqual({ maxTokens: 8_192 });
    expect(layers.modelKey).toBe("glm-4.6");
    expect(layers.inheritedForModel).toEqual({
      reasoning: false,
      contextWindow: 200_000,
    });
  });
});

describe("countModelOverrides", () => {
  test("counts across providers", () => {
    expect(
      countModelOverrides({
        a: { modelOverrides: { "m1": { reasoning: false }, "m2": {} } },
        b: { modelMeta: { reasoning: true } },
        c: { modelOverrides: { "m3": { maxTokens: 1 } } },
      }),
    ).toBe(3);
  });
  test("zero when absent", () => {
    expect(countModelOverrides(undefined)).toBe(0);
    expect(countModelOverrides({ a: { label: "x" } })).toBe(0);
  });
});

import { test, expect, describe } from "bun:test";
import {
  cleanModelMeta,
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

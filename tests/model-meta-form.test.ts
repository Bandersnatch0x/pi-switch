import { test, expect, describe } from "bun:test";
import {
  buildFormItems,
  builtInFor,
  countSubmenuOptions,
  resolveCountPick,
  thinkingSubmenuOptions,
  scopeSubmenuOptions,
  parseScopePick,
  presetSubmenuOptions,
  findPresetByLabel,
  applyPresetToDraft,
  storedFor,
  inheritedFor,
  sameMeta,
  scopeLabel,
  formTitle,
  currentValueForReasoning,
  reasoningValues,
  cycleUseBuiltInCompat,
  shouldShowBuiltInCompatRow,
  useBuiltInCompatStateText,
  userMetaForBuiltInGate,
  CUSTOM_VALUE,
  INHERIT_VALUE,
  CONTEXT_PRESETS,
  MAX_TOKENS_PRESETS,
  FORM_ITEM_ID,
} from "../src/ui/model-meta-form.ts";
import type { ModelMetaDialogInput, ModelMetaScope } from "../src/ui/model-meta-dialog.ts";
import type { ModelMetaOverride } from "../src/types.ts";
import {
  canonicalProviderEndpointTuple,
  type ThinkingProjectionDecision,
} from "../src/capabilities/thinking-projection.ts";

const provider = { id: "abc", displayName: "elysiver-claude", piName: "elysiver-claude" };

function baseInput(over?: Partial<ModelMetaDialogInput>): ModelMetaDialogInput {
  return {
    provider,
    scope: { kind: "provider" },
    tier: { reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
    models: ["glm-4.6", "claude-sonnet-4"],
    ...over,
  };
}

function ultraDecision(): ThinkingProjectionDecision {
  return {
    tuple: canonicalProviderEndpointTuple({
      appType: "codex",
      providerId: "abc",
      api: "openai-responses",
      baseUrl: "https://relay.example/v1",
      modelId: "gpt-5.6-sol",
    }),
    tupleKey: "codex:abc:gpt-5.6-sol",
    profileVersion: "catalog@1",
    control: { type: "effort" },
    map: { max: "max" },
    advertised: [
      { type: "effort", value: "max" },
      { type: "effort", value: "ultra" },
    ],
    unrepresented: [{ type: "effort", value: "ultra" }],
    projections: [],
    collisions: [],
    source: "codex-model-catalog",
    observedAt: "2026-08-17T00:00:00.000Z",
    stale: false,
    status: "exact",
    runtime: {
      version: "0.84.2",
      runtimeVerified: true,
      payloadVerified: true,
      supportedControls: ["effort"],
      providerDefault: "supported",
      off: "indistinguishable-from-provider-default",
    },
    warnings: [],
  };
}

const byId = (items: ReturnType<typeof buildFormItems>, id: string) =>
  items.find((i) => i.id === id) ?? null;

describe("scope helpers", () => {
  test("scopeLabel", () => {
    expect(scopeLabel({ kind: "provider" })).toBe("全部模型");
    expect(scopeLabel({ kind: "model", modelId: "glm-4.6" })).toBe("模型 glm-4.6");
  });

  test("storedFor reads provider scope then model scope", () => {
    const input = baseInput({
      providerMeta: { reasoning: false },
      modelOverrides: { "glm-4.6": { maxTokens: 8_192 } },
    });
    expect(storedFor(input, { kind: "provider" })).toEqual({ reasoning: false });
    expect(storedFor(input, { kind: "model", modelId: "glm-4.6" })).toEqual({ maxTokens: 8_192 });
    expect(storedFor(input, { kind: "model", modelId: "other" })).toBeUndefined();
  });

  test("inheritedFor merges base+provider at model scope", () => {
    const input = baseInput({
      base: { reasoning: true } as ModelMetaOverride,
      providerMeta: { contextWindow: 100_000 } as ModelMetaOverride,
    });
    expect(inheritedFor(input, { kind: "provider" })).toEqual({ reasoning: true });
    expect(inheritedFor(input, { kind: "model", modelId: "glm-4.6" })).toEqual({
      reasoning: true,
      contextWindow: 100_000,
    });
  });

  test("builtInFor / form shows 内置 for deepseek thinkingFormat", () => {
    const scope = { kind: "model" as const, modelId: "deepseek-v4-flash" };
    expect(builtInFor(scope)?.thinkingFormat).toBe("deepseek");
    expect(builtInFor({ kind: "provider" })).toBeUndefined();

    const input = baseInput({
      models: ["deepseek-v4-flash"],
      scope,
    });
    const items = buildFormItems(input, scope, {});
    const thinking = items.find((i) => i.id === FORM_ITEM_ID.thinkingFormat);
    expect(thinking?.currentValue).toBe("内置 deepseek");
    expect(byId(items, FORM_ITEM_ID.useBuiltInCompat)?.currentValue).toBe("默认 开启");

    const opts = thinkingSubmenuOptions({}, undefined, undefined, builtInFor(scope));
    expect(opts.some((o) => o.label === "不覆写（内置 deepseek）")).toBe(true);
  });

  test("useBuiltInCompat false hides 内置 and shows 覆写 关闭", () => {
    const scope = { kind: "model" as const, modelId: "deepseek-v4-flash" };
    const draft = { useBuiltInCompat: false };
    expect(builtInFor(scope, userMetaForBuiltInGate(draft, undefined))).toBeUndefined();
    const items = buildFormItems(
      baseInput({ models: ["deepseek-v4-flash"], scope }),
      scope,
      draft,
    );
    expect(byId(items, FORM_ITEM_ID.thinkingFormat)?.currentValue).toBe("默认");
    expect(byId(items, FORM_ITEM_ID.useBuiltInCompat)?.currentValue).toBe("覆写 关闭");
  });

  test("cycleUseBuiltInCompat and shouldShowBuiltInCompatRow", () => {
    const d: ModelMetaOverride = {};
    cycleUseBuiltInCompat(d);
    expect(d.useBuiltInCompat).toBe(false);
    cycleUseBuiltInCompat(d);
    expect(d.useBuiltInCompat).toBe(true);
    cycleUseBuiltInCompat(d);
    expect(d.useBuiltInCompat).toBeUndefined();

    expect(useBuiltInCompatStateText({}, undefined)).toBe("默认 开启");
    expect(shouldShowBuiltInCompatRow({ kind: "model", modelId: "glm-4.6" }, {}, undefined)).toBe(
      false,
    );
    expect(
      shouldShowBuiltInCompatRow(
        { kind: "model", modelId: "deepseek-v4-flash" },
        {},
        undefined,
      ),
    ).toBe(true);
  });

  test("inheritedFor at model scope includes matching glob (not exact)", () => {
    const input = baseInput({
      base: { reasoning: true } as ModelMetaOverride,
      providerMeta: { maxTokens: 8_000 } as ModelMetaOverride,
      modelOverrides: {
        "gpt-5*": { contextWindow: 400_000 },
        "gpt-5-pro": { reasoning: false },
      },
    });
    // Only glob → inherit shows glob fields
    expect(
      inheritedFor(
        { ...input, modelOverrides: { "gpt-5*": { contextWindow: 400_000 } } },
        { kind: "model", modelId: "gpt-5-pro" },
      ),
    ).toEqual({
      reasoning: true,
      maxTokens: 8_000,
      contextWindow: 400_000,
    });
    // Exact key exists → glob not treated as inherit (exact is stored/own)
    expect(inheritedFor(input, { kind: "model", modelId: "gpt-5-pro" })).toEqual({
      reasoning: true,
      maxTokens: 8_000,
    });
    expect(storedFor(input, { kind: "model", modelId: "gpt-5-pro" })).toEqual({
      reasoning: false,
    });
  });

  test("sameMeta compares by cleaned sorted keys", () => {
    expect(sameMeta({ reasoning: true }, { reasoning: true })).toBe(true);
    expect(sameMeta({ reasoning: true }, { reasoning: false })).toBe(false);
    expect(sameMeta(undefined, undefined)).toBe(true);
    expect(sameMeta({ reasoning: true, contextWindow: 100 }, { contextWindow: 100, reasoning: true })).toBe(true);
  });
});

describe("count submenu", () => {
  test("contextWindow presets are user-requested set", () => {
    expect(CONTEXT_PRESETS).toEqual([200_000, 256_000, 500_000, 1_000_000]);
  });

  test("maxTokens presets", () => {
    expect(MAX_TOKENS_PRESETS).toEqual([4_096, 8_192, 16_000, 32_000, 64_000, 128_000]);
  });

  test("countSubmenuOptions shows presets + custom + inherit", () => {
    const items = countSubmenuOptions("contextWindow", {}, undefined, baseInput().tier);
    const labels = items.map((i) => i.label);
    expect(labels).toContain("200k · 200000");
    expect(labels).toContain("256k · 256000");
    expect(labels).toContain("1M · 1000000");
    expect(labels.some((l) => l.startsWith("✎ 自定义"))).toBe(true);
    expect(labels.some((l) => l.startsWith("不覆写"))).toBe(true);
  });

  test("inherit label shows inherited value when present", () => {
    const items = countSubmenuOptions("maxTokens", {}, { maxTokens: 8_192 }, undefined);
    const inherit = items.find((i) => i.value === INHERIT_VALUE)!;
    expect(inherit.label).toBe("不覆写（继承 8192）");
  });

  test("resolveCountPick: value / inherit / custom", () => {
    expect(resolveCountPick("200000")).toEqual({ kind: "value", n: 200_000 });
    expect(resolveCountPick(INHERIT_VALUE)).toEqual({ kind: "inherit" });
    expect(resolveCountPick(CUSTOM_VALUE)).toEqual({ kind: "custom" });
  });

  test("maxTokens offers the trusted sync value at exact-model scope only", () => {
    const input = baseInput({
      models: ["glm-4.6"],
      maxTokensHints: { "glm-4.6": { value: 384_000, source: "models-dev" } },
    });
    const scope = { kind: "model" as const, modelId: "glm-4.6" };
    const hint = input.maxTokensHints!["glm-4.6"];

    const withHint = countSubmenuOptions("maxTokens", {}, undefined, input.tier, hint);
    const sync = withHint[0]!;
    expect(sync.label).toBe("使用同步值 384k（models.dev）");
    expect(resolveCountPick(sync.value)).toEqual({ kind: "value", n: 384_000 });
    // Presets still resolve to their own value, not shifted by the sync row.
    expect(resolveCountPick(withHint[1]!.value)).toEqual({ kind: "value", n: 4_096 });

    // Provider scope has no single model to pin, so no sync row is offered.
    const noHint = countSubmenuOptions("maxTokens", {}, undefined, input.tier);
    expect(noHint.some((o) => o.label.startsWith("使用同步值"))).toBe(false);
    // contextWindow never gets a maxTokens hint.
    expect(
      countSubmenuOptions("contextWindow", {}, undefined, input.tier, hint).some((o) =>
        o.label.startsWith("使用同步值"),
      ),
    ).toBe(false);

    const items = buildFormItems(input, scope, {});
    expect(byId(items, FORM_ITEM_ID.maxTokens)?.description).toContain("384k");
    expect(
      byId(buildFormItems(input, { kind: "provider" }, {}), FORM_ITEM_ID.maxTokens)
        ?.description,
    ).not.toContain("384k");
  });

  test("cc-meta hint is labeled as CC Switch meta", () => {
    const items = countSubmenuOptions("maxTokens", {}, undefined, undefined, {
      value: 8_192,
      source: "cc-meta",
    });
    expect(items[0]!.label).toBe("使用同步值 8192（CC Switch meta）");
  });
});

describe("thinking submenu", () => {
  test("options contain all formats + inherit", () => {
    const items = thinkingSubmenuOptions({}, undefined, undefined);
    const labels = items.map((i) => i.label);
    expect(labels).toContain("deepseek");
    expect(labels).toContain("qwen");
    expect(items.some((i) => i.value === INHERIT_VALUE)).toBe(true);
  });
});

describe("scope submenu", () => {
  test("lists provider + models + manual, marks overrides", () => {
    const input = baseInput({
      providerMeta: { reasoning: false },
      modelOverrides: { "glm-4.6": { maxTokens: 8_192 } },
    });
    const items = scopeSubmenuOptions(input);
    const prov = items.find((i) => i.value === "provider")!;
    expect(prov.label).toBe("全部模型（provider 级） ⚙");
    const glm = items.find((i) => i.value === "model::glm-4.6")!;
    expect(glm.label).toBe("glm-4.6 ⚙");
    const sonnet = items.find((i) => i.value === "model::claude-sonnet-4")!;
    expect(sonnet.label).toBe("claude-sonnet-4");
    expect(items.some((i) => i.value === "manual")).toBe(true);
  });

  test("parseScopePick", () => {
    expect(parseScopePick("provider")).toEqual({ kind: "provider" });
    expect(parseScopePick("model::glm-4.6")).toEqual({ kind: "model", modelId: "glm-4.6" });
    expect(parseScopePick("manual")).toEqual({ kind: "manual" });
  });
});

describe("preset submenu", () => {
  test("entries map to real presets by label", () => {
    const items = presetSubmenuOptions();
    expect(items.length).toBeGreaterThan(0);
    const first = findPresetByLabel(items[0].value)!;
    expect(first).toBeTruthy();
    expect(first.label).toBe(items[0].value);
  });

  test("applyPresetToDraft copies fields", () => {
    const draft: ModelMetaOverride = {};
    const preset = findPresetByLabel(presetSubmenuOptions()[0].value)!;
    applyPresetToDraft(draft, preset);
    expect(cleanEq(draft, preset.modelMeta)).toBe(true);
  });
});

function cleanEq(a: ModelMetaOverride | undefined, b: ModelMetaOverride | undefined): boolean {
  const norm = (m: ModelMetaOverride | undefined) => {
    const c = (m ?? {}) as Record<string, unknown>;
    return JSON.stringify(Object.keys(c).sort().map((k) => [k, c[k]]));
  };
  return norm(a) === norm(b);
}

describe("buildFormItems", () => {
  test("shows ultra opt-in only for an advertised exact-model decision", () => {
    const scope = { kind: "model" as const, modelId: "gpt-5.6-sol" };
    const input = baseInput({
      scope,
      models: [scope.modelId],
      thinkingProjections: { [scope.modelId]: ultraDecision() },
    });

    expect(buildFormItems(input, scope, {}).some((item) => item.id === FORM_ITEM_ID.thinkingOptIn)).toBe(true);
    expect(
      buildFormItems(input, { kind: "provider" }, {}).some(
        (item) => item.id === FORM_ITEM_ID.thinkingOptIn,
      ),
    ).toBe(false);
    expect(
      buildFormItems(input, { kind: "model", modelId: "gpt-*" }, {}).some(
        (item) => item.id === FORM_ITEM_ID.thinkingOptIn,
      ),
    ).toBe(false);
  });

  test("emits the canonical item order", () => {
    const ids = buildFormItems(baseInput(), { kind: "provider" }, {}).map((i) => i.id);
    expect(ids).toEqual([
      FORM_ITEM_ID.scope,
      FORM_ITEM_ID.preset,
      FORM_ITEM_ID.reasoning,
      FORM_ITEM_ID.contextWindow,
      FORM_ITEM_ID.maxTokens,
      FORM_ITEM_ID.thinkingFormat,
      FORM_ITEM_ID.useBuiltInCompat, // provider scope always offers fleet opt-out
      FORM_ITEM_ID.save,
      FORM_ITEM_ID.cancel,
    ]);
  });

  test("reasoning row shows override when draft sets it", () => {
    const items = buildFormItems(baseInput(), { kind: "provider" }, { reasoning: false });
    expect(byId(items, FORM_ITEM_ID.reasoning)?.currentValue).toBe("覆写 false");
  });

  test("reasoning row shows inherit at model scope", () => {
    const input = baseInput({ providerMeta: { reasoning: false } });
    const items = buildFormItems(input, { kind: "model", modelId: "glm-4.6" }, {});
    expect(byId(items, FORM_ITEM_ID.reasoning)?.currentValue).toBe("继承 false");
  });

  test("contextWindow row shows tier default when unset", () => {
    const items = buildFormItems(baseInput(), { kind: "provider" }, {});
    expect(byId(items, FORM_ITEM_ID.contextWindow)?.currentValue).toBe("默认 200k");
  });

  test("clearScope row appears when draft or stored has override", () => {
    const items1 = buildFormItems(baseInput(), { kind: "provider" }, { reasoning: true });
    expect(items1.some((i) => i.id === FORM_ITEM_ID.clearScope)).toBe(true);
    const items2 = buildFormItems(
      baseInput({ providerMeta: { reasoning: false } }),
      { kind: "provider" },
      {},
    );
    expect(items2.some((i) => i.id === FORM_ITEM_ID.clearScope)).toBe(true);
  });

  test("clearAll row appears when any override exists", () => {
    const input = baseInput({
      providerMeta: { reasoning: false },
      modelOverrides: { "glm-4.6": { maxTokens: 8_192 } },
    });
    const items = buildFormItems(input, { kind: "provider" }, {});
    expect(items.some((i) => i.id === FORM_ITEM_ID.clearAll)).toBe(true);
  });

  test("save has no star (title-level marker drives dirty text)", () => {
    const items = buildFormItems(baseInput(), { kind: "provider" }, {});
    const save = byId(items, FORM_ITEM_ID.save)!;
    expect(save.label).toBe("保存");
    expect(save.currentValue).toBe("保存并关闭");
  });
});

describe("reasoning values + currentValue", () => {
  test("reasoningValues returns toggle cycle", () => {
    expect(reasoningValues({})).toEqual(["不覆写", "true", "false"]);
  });

  test("currentValueForReasoning resolves override>inherit>default", () => {
    expect(currentValueForReasoning({ reasoning: true }, undefined, undefined)).toBe("覆写 true");
    expect(currentValueForReasoning({}, { reasoning: false }, undefined)).toBe("继承 false");
    expect(currentValueForReasoning({}, undefined, { reasoning: true })).toBe("默认 true");
    expect(currentValueForReasoning({}, undefined, undefined)).toBe("默认");
  });
});

describe("formTitle", () => {
  test("dirty shows star", () => {
    const input = baseInput({ providerMeta: { reasoning: false } });
    const providerScope: ModelMetaScope = { kind: "provider" };
    // dirty=true because draft {} differs from stored {reasoning:false}
    expect(formTitle(input, providerScope, true)).toBe(
      "参数覆写 · elysiver-claude · 全部模型 ✱",
    );
    expect(formTitle(input, providerScope, false)).toBe(
      "参数覆写 · elysiver-claude · 全部模型",
    );
  });
});

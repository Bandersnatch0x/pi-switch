import { test, expect, describe } from "bun:test";
import {
  BUILT_IN_COMPAT_PROFILES,
  builtInCompatForModelId,
  compatOnlyMeta,
  matchBuiltInCompatProfile,
  mergeBuiltInCompatUnderUser,
  withBuiltInCompatUnderUser,
} from "../src/compat/built-in-compat-profile.ts";
import { resolveRegistrationMeta } from "../src/capabilities/registration.ts";
import { resolveEffectiveModelMeta, summarizeModelMeta } from "../src/model-meta.ts";
import { buildProviderConfig } from "../src/register.ts";
import type { CcProvider, PiSwitchConfig } from "../src/types.ts";

function mk(partial: Partial<CcProvider> & Pick<CcProvider, "id" | "appType">): CcProvider {
  return {
    piName: `ps-${partial.appType}-${partial.id}`,
    displayName: partial.displayName ?? `name-${partial.id}`,
    api: "openai-completions",
    baseUrl: "https://example.com",
    apiKey: "k",
    authHeader: true,
    configModels: ["m1"],
    meta: {},
    isCurrentInCc: false,
    ...partial,
  };
}

describe("built-in compat profile (PR1/PR2)", () => {
  test("deepseek* matches full DeepSeek compat", () => {
    const hit = matchBuiltInCompatProfile("deepseek-v4-flash");
    expect(hit?.key).toBe("deepseek*");
    expect(hit?.modelMeta).toEqual({
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
      thinkingLevelMap: {
        minimal: "high",
        low: "high",
        medium: "high",
        high: "high",
        xhigh: "max",
      },
    });
  });

  test("deepseek with [1M] tag still matches family", () => {
    // glob is deepseek* — tagged ids start with deepseek
    expect(matchBuiltInCompatProfile("deepseek-v4-flash[1M]")?.key).toBe("deepseek*");
  });

  test("qwen* matches format-only profile (PR2)", () => {
    const hit = matchBuiltInCompatProfile("qwen3-max");
    expect(hit?.key).toBe("qwen*");
    expect(hit?.modelMeta).toEqual({ thinkingFormat: "qwen" });
  });

  test("unrelated model ids miss", () => {
    expect(matchBuiltInCompatProfile("claude-sonnet-4")).toBeUndefined();
    expect(matchBuiltInCompatProfile("gpt-5.6-sol")).toBeUndefined();
    expect(matchBuiltInCompatProfile("glm-4.6")).toBeUndefined();
  });

  test("compatOnlyMeta strips capability scalars", () => {
    expect(
      compatOnlyMeta({
        thinkingFormat: "deepseek",
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        reasoning: true,
      }),
    ).toEqual({ thinkingFormat: "deepseek" });
  });

  test("user override wins over built-in per field", () => {
    const merged = mergeBuiltInCompatUnderUser("deepseek-v4-flash", {
      thinkingFormat: "openai",
    });
    expect(merged?.thinkingFormat).toBe("openai");
    // built-in fields not overridden remain
    expect(merged?.requiresReasoningContentOnAssistantMessages).toBe(true);
    expect(merged?.thinkingLevelMap?.high).toBe("high");
  });

  test("user can set requiresReasoningContent false over built-in true", () => {
    const merged = mergeBuiltInCompatUnderUser("deepseek-v4-flash", {
      requiresReasoningContentOnAssistantMessages: false,
    });
    expect(merged?.requiresReasoningContentOnAssistantMessages).toBe(false);
    expect(merged?.thinkingFormat).toBe("deepseek");
  });

  test("useBuiltInCompat: false disables whole built-in profile", () => {
    const off = { useBuiltInCompat: false as const, contextWindow: 200_000 };
    expect(mergeBuiltInCompatUnderUser("deepseek-v4-flash", off)).toBeUndefined();
    expect(withBuiltInCompatUnderUser("deepseek-v4-flash", off)).toEqual(off);
    expect(builtInCompatForModelId("deepseek-v4-flash", off)).toBeUndefined();

    const meta = resolveRegistrationMeta({
      modelId: "deepseek-v4-flash",
      api: "openai-completions",
      baseUrl: "https://example.com",
      userMeta: { useBuiltInCompat: false },
    });
    expect(meta.thinkingFormat).toBeUndefined();
    expect(meta.thinkingLevelMap).toBeUndefined();
    expect(meta.requiresReasoningContentOnAssistantMessages).toBeUndefined();
    // protocol tier still applies for scalars
    expect(meta.contextWindow).toBe(128_000);
  });

  test("useBuiltInCompat: true re-enables under a parent false (via merged userMeta)", () => {
    // Simulate model layer true winning over provider false after user merge.
    const user = { useBuiltInCompat: true as const };
    expect(withBuiltInCompatUnderUser("deepseek-v4-flash", user)?.thinkingFormat).toBe(
      "deepseek",
    );
  });

  test("withBuiltInCompatUnderUser keeps user scalars and adds built-in compat", () => {
    const full = withBuiltInCompatUnderUser("deepseek-v4-flash", {
      contextWindow: 1_000_000,
      reasoning: true,
    });
    expect(full).toMatchObject({
      contextWindow: 1_000_000,
      reasoning: true,
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
    });
    // switch-notify style summary must not say 默认协议档
    expect(summarizeModelMeta(full)).toContain("thinkingFormat=deepseek");
    expect(summarizeModelMeta(full)).not.toBe("默认协议档");
  });

  test("withBuiltInCompatUnderUser is identity when no profile matches", () => {
    const user = { reasoning: false, maxTokens: 8_192 };
    expect(withBuiltInCompatUnderUser("claude-sonnet-4", user)).toEqual(user);
    expect(builtInCompatForModelId("claude-sonnet-4")).toBeUndefined();
  });

  test("resolveEffectiveModelMeta stays user-only; withBuiltIn adds profile", () => {
    const config: Pick<PiSwitchConfig, "providerOverrides" | "defaultModelMeta"> = {
      defaultModelMeta: { reasoning: true },
    };
    const provider = { id: "1", piName: "p", displayName: "p" };
    const userOnly = resolveEffectiveModelMeta(config, provider, "deepseek-v4-flash");
    expect(userOnly).toEqual({ reasoning: true });
    expect(userOnly?.thinkingFormat).toBeUndefined();
    const display = withBuiltInCompatUnderUser("deepseek-v4-flash", userOnly);
    expect(display?.thinkingFormat).toBe("deepseek");
    expect(display?.reasoning).toBe(true);
  });

  test("profiles table only contains known keys", () => {
    expect(Object.keys(BUILT_IN_COMPAT_PROFILES).sort()).toEqual(["deepseek*", "qwen*"]);
  });
});

describe("resolveRegistrationMeta + built-in", () => {
  test("deepseek gets built-in compat without user override", () => {
    // Issue #63: without a trusted maxTokens authority, registration meta omits
    // maxTokens (unresolved). Built-in only fills compat fields.
    const meta = resolveRegistrationMeta({
      modelId: "deepseek-v4-flash",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
    });
    expect(meta.thinkingFormat).toBe("deepseek");
    expect(meta.requiresReasoningContentOnAssistantMessages).toBe(true);
    expect(meta.thinkingLevelMap?.xhigh).toBe("max");
    expect(meta.contextWindow).toBe(128_000);
    expect(meta.maxTokens).toBeUndefined();
    expect(meta.reasoning).toBe(false);

    // With exact-model maxTokens, full registration meta is eligible.
    const full = resolveRegistrationMeta({
      modelId: "deepseek-v4-flash",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      userMeta: { maxTokens: 32_000 },
    });
    expect(full.maxTokens).toBe(32_000);
    expect(full.thinkingFormat).toBe("deepseek");
  });

  test("user thinkingFormat overrides built-in", () => {
    const meta = resolveRegistrationMeta({
      modelId: "deepseek-v4-flash",
      api: "openai-completions",
      baseUrl: "https://example.com",
      userMeta: { thinkingFormat: "openai" },
    });
    expect(meta.thinkingFormat).toBe("openai");
    expect(meta.requiresReasoningContentOnAssistantMessages).toBe(true);
  });

  test("non-matching model has no compat from built-in", () => {
    const meta = resolveRegistrationMeta({
      modelId: "claude-sonnet-4",
      api: "anthropic-messages",
      baseUrl: "https://example.com",
    });
    expect(meta.thinkingFormat).toBeUndefined();
    expect(meta.thinkingLevelMap).toBeUndefined();
  });

  test("qwen gets format-only built-in", () => {
    const meta = resolveRegistrationMeta({
      modelId: "qwen3-coder-plus",
      api: "openai-completions",
      baseUrl: "https://example.com",
    });
    expect(meta.thinkingFormat).toBe("qwen");
    expect(meta.requiresReasoningContentOnAssistantMessages).toBeUndefined();
  });
});

describe("buildProviderConfig + built-in registration", () => {
  test("registers deepseek with nested compat without user modelMeta", () => {
    // #63: supply trusted maxTokens so the model can register; built-in fills compat.
    const cfg = buildProviderConfig(
      mk({ id: "ds", appType: "hermes", api: "openai-completions" }),
      ["deepseek-v4-flash"],
      { rules: [], modelMeta: { maxTokens: 32_000 } },
    );
    const m = (cfg?.models as any[])[0];
    expect(m).toBeDefined();
    expect(m.thinkingLevelMap).toEqual({
      minimal: "high",
      low: "high",
      medium: "high",
      high: "high",
      xhigh: "max",
    });
    // Provider wire (#66) may add Chat defaults on unknown relays.
    expect(m.compat).toMatchObject({
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
    });
    expect(m.thinkingFormat).toBeUndefined();
  });

  test("user modelMeta still wins over built-in", () => {
    const cfg = buildProviderConfig(
      mk({ id: "ds", appType: "hermes", api: "openai-completions" }),
      ["deepseek-v4-flash"],
      {
        rules: [],
        modelMeta: { maxTokens: 32_000, thinkingFormat: "openai" },
      },
    );
    const m = (cfg?.models as any[])[0];
    expect(m).toBeDefined();
    expect(m.compat.thinkingFormat).toBe("openai");
    expect(m.compat.requiresReasoningContentOnAssistantMessages).toBe(true);
  });
});

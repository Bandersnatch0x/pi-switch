import { describe, expect, test } from "bun:test";
import {
  resolveCapabilitiesFor,
  resolveRegistrationDecisionFor,
  resolveSessionCompatibilityTarget,
  type SessionCompatibilityDeps,
} from "../extensions/runtime-facades.ts";
import type { EffectiveProviderCompatibility } from "../src/provider-config-views.ts";
import type { CcProvider, PiSwitchSelection } from "../src/types.ts";
import type {
  PiThinkingRuntimeCapability,
  ProviderReasoningProfile,
} from "../src/capabilities/thinking-projection.ts";

function provider(partial: Partial<CcProvider> = {}): CcProvider {
  return {
    id: "p1",
    piName: "ps-codex-p1",
    displayName: "provider one",
    appType: "codex",
    api: "openai-responses",
    baseUrl: "https://example.com",
    apiKey: "key",
    authHeader: true,
    configModels: ["gpt-5"],
    meta: {},
    isCurrentInCc: false,
    ...partial,
  };
}

/** 3-member deps stub — the point of the narrow interface (vs faking full Runtime). */
function deps(
  providers: CcProvider[],
  selection: PiSwitchSelection | undefined,
  compat: EffectiveProviderCompatibility = {},
): SessionCompatibilityDeps {
  return {
    lastGoodProviders: providers,
    readSelectionCached: () => selection,
    effectiveCompatibilityFor: () => compat,
  };
}

describe("resolveSessionCompatibilityTarget (pure)", () => {
  test("matches provider by dbId + appType", () => {
    const p = provider();
    const result = resolveSessionCompatibilityTarget(
      deps([p], { dbId: "p1", model: "gpt-5", appType: "codex" }, { claudeCodeCompat: true }),
    );
    expect(result.provider?.id).toBe("p1");
    expect(result.modelId).toBe("gpt-5");
    expect(result.compatibility).toEqual({ claudeCodeCompat: true });
  });

  test("appType mismatch rejects dbId match", () => {
    const p = provider();
    const result = resolveSessionCompatibilityTarget(
      deps([p], { dbId: "p1", model: "gpt-5", appType: "claude" }),
    );
    expect(result.provider).toBeUndefined();
    // Selection facts still surface for the caller's fallback heuristics.
    expect(result.dbId).toBe("p1");
    expect(result.modelId).toBe("gpt-5");
  });

  test("falls back to piName match when dbId misses", () => {
    const p = provider();
    const result = resolveSessionCompatibilityTarget(
      deps([p], { dbId: "stale-id", model: "gpt-5", provider: "ps-codex-p1" }),
    );
    expect(result.provider?.piName).toBe("ps-codex-p1");
  });

  test("no selection yields empty compatibility", () => {
    const result = resolveSessionCompatibilityTarget(deps([provider()], undefined));
    expect(result.provider).toBeUndefined();
    expect(result.compatibility).toEqual({});
  });

  test("modelId falls back to provider's first config model when selection lacks model", () => {
    const p = provider({ configModels: ["m-a", "m-b"] });
    const result = resolveSessionCompatibilityTarget(
      deps([p], { dbId: "p1", model: undefined as unknown as string, appType: "codex" }),
    );
    // ?? fallback fires only on null/undefined (empty string is preserved as-is)
    expect(result.modelId).toBe("m-a");
  });
});

describe("resolveRegistrationDecisionFor (pure)", () => {
  test("trusted user maxTokens resolves registration meta", () => {
    const decision = resolveRegistrationDecisionFor(provider(), "gpt-5", {
      modelMetaFactsFor: () => ({
        userMeta: { maxTokens: 32_000, reasoning: true },
        userMapScopes: {},
      }),
      modelsDevFor: () => undefined,
    });
    expect(decision.maxTokensUnresolved).toBe(false);
    expect(decision.meta?.maxTokens).toBe(32_000);
    expect(decision.meta?.reasoning).toBe(true);
  });

  test("no trusted authority flags maxTokens unresolved (issue #63)", () => {
    const decision = resolveRegistrationDecisionFor(provider(), "unknown-model", {
      modelMetaFactsFor: () => ({
        userMeta: undefined,
        userMapScopes: {},
      }),
      modelsDevFor: () => undefined,
    });
    expect(decision.maxTokensUnresolved).toBe(true);
    expect(decision.meta).toBeUndefined();
  });

  test("binds profile, runtime, tuple, and exact-model map into one decision", () => {
    const target = provider();
    const profile: ProviderReasoningProfile = {
      tuple: {
        appType: target.appType,
        providerId: target.id,
        api: "openai-responses",
        baseUrl: target.baseUrl,
        modelId: "gpt-5",
      },
      profileVersion: "catalog@1",
      control: { type: "effort" },
      variants: [
        { name: "max", native: { type: "effort", value: "max" } },
        { name: "ultra", native: { type: "effort", value: "ultra" } },
      ],
      source: "codex-model-catalog",
      observedAt: "2026-08-17T00:00:00.000Z",
    };
    const runtime: PiThinkingRuntimeCapability = {
      version: "0.81.1",
      runtimeVerified: true,
      payloadVerified: true,
      supportedControls: ["effort"],
      providerDefault: "supported",
      off: "indistinguishable-from-provider-default",
    };

    const decision = resolveRegistrationDecisionFor(target, "gpt-5", {
      modelMetaFactsFor: () => ({
        userMeta: {
          maxTokens: 32_000,
          reasoning: true,
          thinkingLevelMap: { max: "ultra" },
        },
        userMapScopes: { max: "exact-model" },
      }),
      modelsDevFor: () => undefined,
      thinkingFor: () => ({ profile, runtime }),
    });

    expect(decision.thinkingProjection?.tuple).toMatchObject({
      appType: "codex",
      providerId: "p1",
      modelId: "gpt-5",
    });
    expect(decision.thinkingProjection?.status).toBe("lossy");
    expect(decision.meta?.thinkingLevelMap?.max).toBe("ultra");
  });

  test("retains legacy built-in maps but diagnoses an unverified Pi runtime", () => {
    const target = provider({ api: "openai-completions" });
    const decision = resolveRegistrationDecisionFor(
      target,
      "deepseek-v4-flash",
      {
        modelMetaFactsFor: () => ({
          userMeta: { maxTokens: 32_000, reasoning: true },
          userMapScopes: {},
        }),
        modelsDevFor: () => undefined,
        piVersion: () => "0.80.0",
      },
    );

    expect(decision.meta?.thinkingLevelMap?.xhigh).toBe("max");
    expect(decision.thinkingProjection?.status).toBe("unverified");
    expect(decision.thinkingProjection?.warnings.join("\n")).toContain(
      "built-in thinking map",
    );
  });
});

describe("resolveCapabilitiesFor (pure)", () => {
  test("user config layer wins for maxTokens", () => {
    const p = provider();
    const resolved = resolveCapabilitiesFor(p, "gpt-5", {
      config: {
        providerOverrides: {
          [p.id]: { modelMeta: { maxTokens: 16_000 } },
        },
      },
      modelsDevFor: () => undefined,
    });
    expect(resolved.maxTokens.value).toBe(16_000);
    expect(resolved.maxTokens.source).toBe("user-override");
  });

  test("empty config with no models.dev leaves maxTokens without user source", () => {
    const resolved = resolveCapabilitiesFor(provider(), "gpt-5", {
      config: {},
      modelsDevFor: () => undefined,
    });
    expect(resolved.maxTokens.source).not.toBe("user-override");
  });
});

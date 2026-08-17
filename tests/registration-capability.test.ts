import { describe, expect, test } from "bun:test";
import { assembleCapabilityLayers } from "../src/capabilities/layers.ts";
import {
  formatCapabilityDecision,
  resolveRegistrationCapability,
  trustedMaxTokensHint,
} from "../src/capabilities/registration.ts";
import { resolveModelCapabilities } from "../src/capabilities/resolve.ts";
import type {
  PiThinkingRuntimeCapability,
  ProviderReasoningProfile,
} from "../src/capabilities/thinking-projection.ts";

describe("resolveRegistrationCapability (#63)", () => {
  test("unknown model: maxTokens unresolved, reasoning conservative false", () => {
    const decision = resolveRegistrationCapability({
      modelId: "relay-unknown",
      api: "openai-completions",
      baseUrl: "https://relay.example/v1",
    });

    expect(decision.maxTokensUnresolved).toBe(true);
    expect(decision.meta).toBeUndefined();
    expect(decision.resolved.maxTokens.source).toBe("unresolved");
    expect(decision.reasoningConservative).toBe(true);
    expect(decision.resolved.reasoning).toMatchObject({
      value: false,
      source: "conservative-default",
    });
    // contextWindow may still use protocol structural floor
    expect(decision.resolved.contextWindow.source).toBe("protocol-default");
  });

  test("exact-model maxTokens override restores meta without writing conservative reasoning", () => {
    const decision = resolveRegistrationCapability({
      modelId: "relay-unknown",
      api: "openai-completions",
      baseUrl: "https://relay.example/v1",
      userMeta: { maxTokens: 16_384 },
    });

    expect(decision.maxTokensUnresolved).toBe(false);
    expect(decision.meta).toEqual({
      contextWindow: 128_000,
      maxTokens: 16_384,
      reasoning: false,
    });
    expect(decision.reasoningConservative).toBe(true);
  });

  test("models.dev last-good supplies maxTokens and reasoning", () => {
    const decision = resolveRegistrationCapability({
      modelId: "known",
      api: "anthropic-messages",
      baseUrl: "https://relay.example",
      modelsDev: {
        maxTokens: 8_192,
        reasoning: true,
        observedAt: "2020-01-01T00:00:00Z",
        source: "models-dev",
      },
    });

    expect(decision.maxTokensUnresolved).toBe(false);
    expect(decision.meta?.maxTokens).toBe(8_192);
    expect(decision.meta?.reasoning).toBe(true);
    expect(decision.resolved.maxTokens.source).toBe("models-dev");
    expect(decision.reasoningConservative).toBe(false);
  });

  test("carries thinking projection and registers only its projected map", () => {
    const tuple = {
      appType: "codex",
      providerId: "relay-primary",
      api: "openai-responses" as const,
      baseUrl: "https://relay.example/v1",
      modelId: "gpt-5.6-sol",
    };
    const profile: ProviderReasoningProfile = {
      tuple,
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

    const decision = resolveRegistrationCapability({
      modelId: tuple.modelId,
      api: tuple.api,
      baseUrl: tuple.baseUrl,
      userMeta: {
        maxTokens: 128_000,
        reasoning: true,
        thinkingLevelMap: { max: "ultra" },
      },
      thinking: {
        tuple,
        profile,
        runtime,
        userMapScope: "exact-model",
      },
    });

    expect(decision.thinkingProjection).toBeDefined();
    expect(decision.thinkingProjection?.status).toBe("lossy");
    expect(decision.thinkingProjection?.tupleKey).toContain("relay-primary");
    expect(decision.meta?.thinkingLevelMap).toEqual(
      decision.thinkingProjection?.map,
    );
    expect(decision.meta?.thinkingLevelMap?.max).toBe("ultra");
    expect(decision.thinkingProjection?.unrepresented).toEqual([
      { type: "effort", value: "max" },
    ]);
  });

  test("reasoning false prevents every automatic and user thinking projection", () => {
    const tuple = {
      appType: "codex",
      providerId: "relay-primary",
      api: "openai-responses" as const,
      baseUrl: "https://relay.example/v1",
      modelId: "gpt-5.6-sol",
    };
    const profile: ProviderReasoningProfile = {
      tuple,
      profileVersion: "catalog@1",
      control: { type: "effort" },
      variants: [{ name: "high", native: { type: "effort", value: "high" } }],
      source: "codex-model-catalog",
      observedAt: "2026-08-17T00:00:00.000Z",
    };

    const decision = resolveRegistrationCapability({
      modelId: tuple.modelId,
      api: tuple.api,
      baseUrl: tuple.baseUrl,
      userMeta: {
        maxTokens: 32_000,
        reasoning: false,
        thinkingLevelMap: { high: "high" },
      },
      thinking: {
        tuple,
        profile,
        runtime: {
          version: "0.84.2",
          runtimeVerified: true,
          payloadVerified: true,
          supportedControls: ["effort"],
          providerDefault: "supported",
          off: "supported",
        },
        userMapScope: "exact-model",
      },
    });

    expect(decision.meta?.reasoning).toBeFalse();
    expect(decision.meta?.thinkingLevelMap).toBeUndefined();
    expect(decision.thinkingProjection).toBeUndefined();
  });

  test("built-in opt-out suppresses reviewed profiles but keeps catalog evidence", () => {
    const tuple = {
      appType: "codex",
      providerId: "relay-primary",
      api: "openai-responses" as const,
      baseUrl: "https://relay.example/v1",
      modelId: "gpt-5.6-sol",
    };
    const profile: ProviderReasoningProfile = {
      tuple,
      profileVersion: "profile@1",
      control: { type: "effort" },
      variants: [{ name: "high", native: { type: "effort", value: "high" } }],
      source: "built-in",
      observedAt: "2026-08-17T00:00:00.000Z",
    };
    const input = {
      modelId: tuple.modelId,
      api: tuple.api,
      baseUrl: tuple.baseUrl,
      userMeta: {
        maxTokens: 32_000,
        reasoning: true,
        useBuiltInCompat: false,
      },
      thinking: {
        tuple,
        profile,
        runtime: {
          version: "0.84.2",
          runtimeVerified: true,
          payloadVerified: true,
          supportedControls: ["effort"] as const,
          providerDefault: "supported" as const,
          off: "supported" as const,
        },
        userMapScope: "none" as const,
      },
    };

    const optedOut = resolveRegistrationCapability(input);
    const catalog = resolveRegistrationCapability({
      ...input,
      thinking: {
        ...input.thinking,
        profile: { ...profile, source: "codex-model-catalog" },
      },
    });

    expect(optedOut.thinkingProjection).toBeUndefined();
    expect(optedOut.meta?.thinkingLevelMap).toBeUndefined();
    expect(catalog.thinkingProjection?.status).toBe("exact");
    expect(catalog.meta?.thinkingLevelMap?.high).toBe("high");
  });

  test("does not canonicalize an unrelated endpoint without thinking facts", () => {
    const decision = resolveRegistrationCapability({
      modelId: "plain-chat-model",
      api: "openai-completions",
      baseUrl: "https://relay.example/v1?api-version=legacy",
      userMeta: { maxTokens: 16_384 },
      thinking: {
        tuple: {
          appType: "custom",
          providerId: "legacy-relay",
          api: "openai-completions",
          baseUrl: "https://relay.example/v1?api-version=legacy",
          modelId: "plain-chat-model",
        },
        runtime: {
          version: "unknown",
          runtimeVerified: false,
          payloadVerified: false,
          supportedControls: [],
          providerDefault: "supported",
          off: "unsupported",
        },
        userMapScope: "none",
      },
    });

    expect(decision.meta?.maxTokens).toBe(16_384);
    expect(decision.thinkingProjection).toBeUndefined();
  });

  test("all four APIs refuse protocol maxTokens floors", () => {
    for (const api of [
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
      "google-generative-ai",
    ] as const) {
      const decision = resolveRegistrationCapability({
        modelId: "x",
        api,
        baseUrl: "https://relay.example",
      });
      expect(decision.maxTokensUnresolved).toBe(true);
      expect(decision.resolved.maxTokens.source).toBe("unresolved");
    }
  });

  test("protocol image support supplies the registration vision floor", () => {
    const input = {
      modelId: "unknown-anthropic-model",
      api: "anthropic-messages" as const,
      baseUrl: "https://relay.example",
    };
    const assembled = resolveModelCapabilities(assembleCapabilityLayers(input));
    const decision = resolveRegistrationCapability(input);

    expect(assembled.vision).toMatchObject({
      value: true,
      source: "protocol-default",
    });
    expect(decision.resolved.vision).toEqual(assembled.vision);
  });

  test("formatCapabilityDecision is redacted and actionable", () => {
    const decision = resolveRegistrationCapability({
      modelId: "m",
      api: "openai-completions",
      baseUrl: "https://relay.example/v1?key=secret",
    });
    const line = formatCapabilityDecision("m", decision, "codex/relay");
    expect(line).toContain("maxTokens=unresolved");
    expect(line).toContain("conservative false");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("key=");
  });
});

describe("trustedMaxTokensHint (#63 override prefill)", () => {
  test("only models.dev and CC Switch meta are offered as a pinnable value", () => {
    expect(trustedMaxTokensHint({ value: 384_000, source: "models-dev" })).toEqual({
      value: 384_000,
      source: "models-dev",
    });
    expect(trustedMaxTokensHint({ value: 8_192, source: "cc-meta" })).toEqual({
      value: 8_192,
      source: "cc-meta",
    });

    // user-override is already the user's own value — nothing to sync from.
    // The rest are guesses or absence, which #63 refuses to present as authority.
    for (const source of [
      "user-override",
      "model-id-tag",
      "host-adaptation",
      "protocol-default",
      "conservative-default",
      "unresolved",
    ] as const) {
      expect(trustedMaxTokensHint({ value: 4_096, source })).toBeUndefined();
    }
  });

  test("a trusted source without a usable number yields no hint", () => {
    expect(
      trustedMaxTokensHint({ value: undefined, source: "models-dev" }),
    ).toBeUndefined();
    expect(trustedMaxTokensHint({ value: 0, source: "cc-meta" })).toBeUndefined();
  });

  test("stale last-good models.dev is still pinnable (that is the point)", () => {
    expect(
      trustedMaxTokensHint({
        value: 8_192,
        source: "models-dev",
        stale: true,
      }),
    ).toEqual({ value: 8_192, source: "models-dev", stale: true });
  });
});

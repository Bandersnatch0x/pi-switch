import { describe, expect, test } from "bun:test";
import {
  parseCodexReasoningCatalog,
  resolveProviderReasoningProfile,
} from "../src/capabilities/reasoning-profile-registry.ts";
import type {
  CcProvider,
  PiApi,
} from "../src/types.ts";

function provider(partial: Partial<CcProvider> = {}): CcProvider {
  return {
    id: "provider-a",
    piName: "provider-a",
    displayName: "Provider A",
    appType: "codex",
    api: "openai-responses",
    baseUrl: "https://relay.example/v1",
    apiKey: "key",
    authHeader: true,
    configModels: ["gpt-5.6-sol"],
    meta: {},
    isCurrentInCc: false,
    ...partial,
  };
}

describe("Codex reasoning catalog ingestion", () => {
  test("preserves catalog order, deduplicates efforts, and keeps unknown values/descriptions", () => {
    const result = parseCodexReasoningCatalog(
      {
        modelCatalog: {
          models: [
            {
              slug: "gpt-5.6-sol",
              default_reasoning_level: " medium ",
              supported_reasoning_levels: [
                { effort: " low ", description: "fast" },
                { effort: "medium", description: "balanced" },
                { effort: "LOW", description: "duplicate keeps first" },
                { effort: "ultra", description: "delegating" },
              ],
            },
          ],
        },
      },
      "2026-08-17T00:00:00.000Z",
    );

    expect(result.warnings).toEqual([]);
    expect(result.catalog?.models["gpt-5.6-sol"]).toEqual({
      defaultVariant: "medium",
      control: { type: "effort" },
      variants: [
        { value: "low", description: "fast" },
        { value: "medium", description: "balanced" },
        { value: "ultra", description: "delegating" },
      ],
    });
    expect(result.catalog?.observedAt).toBe("2026-08-17T00:00:00.000Z");
  });

  test("accepts legacy model identity and reports malformed optional catalog without hiding the provider", () => {
    const result = parseCodexReasoningCatalog(
      {
        modelCatalog: {
          models: [
            { model: "legacy-model", supported_reasoning_levels: "high" },
            { slug: "broken", supported_reasoning_levels: [null] },
          ],
        },
      },
      "2026-08-17T00:00:00.000Z",
    );

    expect(result.catalog?.models["legacy-model"]).toBeUndefined();
    expect(result.warnings.join("\n")).toContain("supported_reasoning_levels");
    expect(result.warnings.join("\n")).toContain("broken");
  });

  test("missing optional catalog is silent", () => {
    expect(
      parseCodexReasoningCatalog({}, "2026-08-17T00:00:00.000Z"),
    ).toEqual({ warnings: [] });
  });
});

describe("provider reasoning profile registry", () => {
  test("exact user profile overrides snapshot metadata and materializes the provider tuple", () => {
    const source = provider({
      appType: "hermes",
      api: "openai-completions",
      reasoningCatalog: {
        source: "provider-model-metadata",
        observedAt: "2026-08-16T00:00:00.000Z",
        models: {
          "custom-reasoner": {
            control: { type: "effort" },
            variants: [{ value: "high" }],
          },
        },
      },
    });

    const profile = resolveProviderReasoningProfile(source, "custom-reasoner", {
      profileVersion: "relay-contract/v1",
      control: { type: "fixed", enabled: true },
      variants: [],
      observedAt: "2026-08-17T12:00:00.000Z",
    });

    expect(profile).toMatchObject({
      tuple: {
        appType: "hermes",
        providerId: "provider-a",
        api: "openai-completions",
        baseUrl: "https://relay.example/v1",
        modelId: "custom-reasoner",
      },
      profileVersion: "relay-contract/v1",
      control: { type: "fixed", enabled: true },
      source: "user",
      observedAt: "2026-08-17T12:00:00.000Z",
    });
  });

  test("turns a catalog entry into an exact tuple-scoped profile", () => {
    const parsed = parseCodexReasoningCatalog(
      {
        modelCatalog: {
          models: [
            {
              slug: "gpt-5.6-sol",
              default_reasoning_level: "low",
              supported_reasoning_levels: [
                { effort: "low", description: "fast" },
                { effort: "ultra", description: "delegating" },
              ],
            },
          ],
        },
      },
      "2026-08-17T00:00:00.000Z",
    );
    const profile = resolveProviderReasoningProfile(
      provider({ reasoningCatalog: parsed.catalog }),
      "gpt-5.6-sol",
    );

    expect(profile).toMatchObject({
      tuple: {
        appType: "codex",
        providerId: "provider-a",
        api: "openai-responses",
        baseUrl: "https://relay.example/v1",
        modelId: "gpt-5.6-sol",
      },
      control: { type: "effort" },
      source: "codex-model-catalog",
      observedAt: "2026-08-17T00:00:00.000Z",
    });
    expect(profile?.variants).toEqual([
      { name: "low", native: { type: "effort", value: "low" }, piLevel: "low", effectiveLevel: "low", description: "fast" },
      { name: "ultra", native: { type: "effort", value: "ultra" }, description: "delegating" },
    ]);
    expect(profile?.defaultVariant).toBe("low");
  });

  test("provider model metadata wins over reviewed built-ins without Codex provenance", () => {
    const profile = resolveProviderReasoningProfile(
      provider({
        appType: "hermes",
        api: "openai-completions",
        reasoningCatalog: {
          source: "provider-model-metadata",
          observedAt: "2026-08-17T00:00:00.000Z",
          models: {
            "glm-5.2": {
              control: { type: "fixed", enabled: true },
              variants: [],
            },
          },
        },
      }),
      "glm-5.2",
    );

    expect(profile).toMatchObject({
      source: "provider-model-metadata",
      control: { type: "fixed", enabled: true },
    });
    expect(profile?.profileVersion).toMatch(/^provider-model-metadata\/v1\//);
  });

  test("provider metadata preserves native GLM toggle variants", () => {
    const profile = resolveProviderReasoningProfile(
      provider({
        appType: "glm",
        api: "openai-completions",
        reasoningCatalog: {
          source: "provider-model-metadata",
          observedAt: "2026-08-18T00:00:00.000Z",
          models: {
            "glm-4.6": {
              control: { type: "toggle" },
              variants: [
                {
                  name: "off",
                  native: { type: "toggle", enabled: false },
                  piLevel: "off",
                  effectiveLevel: "off",
                },
                {
                  name: "high",
                  native: { type: "toggle", enabled: true },
                  piLevel: "high",
                  effectiveLevel: "high",
                },
              ],
            },
          },
        },
      }),
      "glm-4.6",
    );

    expect(profile?.control).toEqual({ type: "toggle" });
    expect(profile?.variants).toEqual([
      {
        name: "off",
        native: { type: "toggle", enabled: false },
        piLevel: "off",
        effectiveLevel: "off",
      },
      {
        name: "high",
        native: { type: "toggle", enabled: true },
        piLevel: "high",
        effectiveLevel: "high",
      },
    ]);
  });

  test.each([
    {
      label: "DeepSeek composite",
      appType: "deepseek",
      api: "openai-completions" as const,
      modelId: "deepseek-v4",
      control: {
        type: "composite" as const,
        controls: [{ type: "toggle" as const }, { type: "effort" as const }],
      },
      variants: [
        {
          name: "off",
          native: {
            type: "composite" as const,
            values: [{ type: "toggle" as const, enabled: false }],
          },
          piLevel: "off" as const,
          effectiveLevel: "off" as const,
        },
        {
          name: "high",
          native: {
            type: "composite" as const,
            values: [
              { type: "toggle" as const, enabled: true },
              { type: "effort" as const, value: "high" },
            ],
          },
          piLevel: "high" as const,
          effectiveLevel: "high" as const,
        },
      ],
    },
    {
      label: "Anthropic budget",
      appType: "claude",
      api: "anthropic-messages" as const,
      modelId: "claude-3-7-sonnet",
      control: { type: "budget_tokens" as const, minTokens: 1024 },
      variants: [
        {
          name: "high",
          native: { type: "budget_tokens" as const, tokens: 16_384 },
          piLevel: "high" as const,
          effectiveLevel: "high" as const,
        },
      ],
    },
    {
      label: "Gemini budget",
      appType: "gemini",
      api: "google-generative-ai" as const,
      modelId: "gemini-2.5-pro",
      control: {
        type: "budget_tokens" as const,
        minTokens: 128,
        maxTokensExclusive: 32_769,
      },
      variants: [
        {
          name: "off",
          native: { type: "budget_tokens" as const, tokens: 0 },
          piLevel: "off" as const,
          effectiveLevel: "off" as const,
        },
        {
          name: "high",
          native: { type: "budget_tokens" as const, tokens: 32_768 },
          piLevel: "high" as const,
          effectiveLevel: "high" as const,
        },
      ],
    },
  ])("provider metadata preserves $label variants", (fixture) => {
    const profile = resolveProviderReasoningProfile(
      provider({
        appType: fixture.appType,
        api: fixture.api,
        reasoningCatalog: {
          source: "provider-model-metadata",
          observedAt: "2026-08-18T00:00:00.000Z",
          models: {
            [fixture.modelId]: {
              control: fixture.control,
              variants: fixture.variants,
            },
          },
        },
      }),
      fixture.modelId,
    );

    expect(profile).toMatchObject({
      source: "provider-model-metadata",
      control: fixture.control,
      variants: fixture.variants,
    });
  });

  test("does not leak a catalog across provider, API, or endpoint tuples", () => {
    const parsed = parseCodexReasoningCatalog(
      {
        modelCatalog: {
          models: [
            {
              slug: "same-model",
              supported_reasoning_levels: [{ effort: "ultra" }],
            },
          ],
        },
      },
      "2026-08-17T00:00:00.000Z",
    );
    const source = provider({ reasoningCatalog: parsed.catalog });

    expect(resolveProviderReasoningProfile(source, "same-model")?.tuple.baseUrl).toBe(
      "https://relay.example/v1",
    );
    expect(
      resolveProviderReasoningProfile(
        provider({ baseUrl: "https://other.example/v1", reasoningCatalog: parsed.catalog }),
        "same-model",
      )?.tuple.baseUrl,
    ).toBe("https://other.example/v1");
    expect(
      resolveProviderReasoningProfile(
        provider({ api: "openai-completions", reasoningCatalog: parsed.catalog }),
        "same-model",
      )?.tuple.api,
    ).toBe("openai-completions");
    expect(
      resolveProviderReasoningProfile(
        provider({ id: "provider-b", reasoningCatalog: undefined }),
        "same-model",
      ),
    ).toBeUndefined();
  });

  test.each([
    ["claude", "anthropic-messages", "claude-3-7-sonnet", "budget_tokens"],
    ["claude", "anthropic-messages", "claude-opus-4-7", "effort"],
    ["hermes", "openai-completions", "deepseek-v4", "composite"],
    ["hermes", "openai-completions", "deepseek-r1", "fixed"],
    ["hermes", "openai-completions", "glm-5.2", "composite"],
    ["hermes", "openai-completions", "glm-4.7", "toggle"],
    ["gemini", "google-generative-ai", "gemini-2.5-pro", "budget_tokens"],
    ["gemini", "google-generative-ai", "gemini-3-pro-preview", "effort"],
  ] as const)("resolves reviewed %s/%s profile for %s", (appType, api, modelId, control) => {
    const profile = resolveProviderReasoningProfile(
      provider({ appType, api: api as PiApi, configModels: [modelId] }),
      modelId,
    );
    expect(profile?.control.type).toBe(control);
    expect(profile?.tuple.modelId).toBe(modelId);
    expect(profile?.source).toBe("built-in");
  });

  test("preserves GLM 5.2 minimal on the wire while recording its effective off outcome", () => {
    const profile = resolveProviderReasoningProfile(
      provider({
        appType: "hermes",
        api: "openai-completions",
        configModels: ["glm-5.2"],
      }),
      "glm-5.2",
    );
    const minimal = profile?.variants.find((variant) => variant.piLevel === "minimal");

    expect(minimal).toEqual({
      name: "minimal",
      piLevel: "minimal",
      native: {
        type: "composite",
        values: [
          { type: "toggle", enabled: true },
          { type: "effort", value: "minimal" },
        ],
      },
      effectiveLevel: "off",
    });
  });

  test("does not infer a family profile from a model name on the wrong API", () => {
    expect(
      resolveProviderReasoningProfile(
        provider({ appType: "gemini", api: "google-generative-ai" }),
        "deepseek-v4",
      ),
    ).toBeUndefined();
  });
});

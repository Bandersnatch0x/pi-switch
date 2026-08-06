import { test, expect, describe } from "bun:test";
import { buildProviderConfig } from "../src/register.ts";
import { resolveProviderWireCompat } from "../src/provider-wire-compat.ts";
import type { CcProvider } from "../src/types.ts";
import type { ModelsDevCapabilities } from "../src/capabilities/models-dev.ts";

function mk(partial: Partial<CcProvider> & Pick<CcProvider, "id" | "appType">): CcProvider {
  return {
    piName: `ps-${partial.appType}-${partial.id}`,
    displayName: partial.displayName ?? `name-${partial.id}`,
    api: "anthropic-messages",
    baseUrl: "https://example.com",
    apiKey: "k",
    authHeader: true,
    configModels: ["m1"],
    meta: {},
    isCurrentInCc: false,
    ...partial,
  };
}

/** Trusted maxTokens authority so unknown models can register under #63. */
const TRUSTED_MAX = { maxTokens: 64_000 } as const;
const md = (partial: Partial<ModelsDevCapabilities> = {}): ModelsDevCapabilities => ({
  maxTokens: 8_192,
  observedAt: "2026-07-31T00:00:00Z",
  source: "models-dev",
  ...partial,
});

describe("buildProviderConfig", () => {
  test("adds the Codex window fingerprint required by official-client relays", () => {
    const cfg = buildProviderConfig(
      mk({ id: "codex", appType: "codex", api: "openai-responses" }),
      ["gpt-5.6-sol"],
      {
        rules: [
          {
            name: "codex-cli",
            apis: ["openai-responses"],
            headers: {
              "User-Agent": "codex_cli_rs/{codexVersion} ({osInfo}) Terminal",
              originator: "{codexOriginator}",
            },
          },
        ],
        vars: {
          codexVersion: "0.146.0",
          osInfo: "Windows 10.0; x64",
          codexOriginator: "codex_cli_rs",
          codexWindowId: "019b4c56-ae8b-7e5d-a65a-c0b64a3ddf80",
        },
        modelMeta: { maxTokens: 128_000 },
      },
    );

    expect(cfg?.headers?.["X-Codex-Window-ID"]).toBe(
      "019b4c56-ae8b-7e5d-a65a-c0b64a3ddf80",
    );
  });

  test("switchable provider yields config with models when maxTokens is known", () => {
    const cfg = buildProviderConfig(mk({ id: "1", appType: "claude" }), ["gpt"], {
      rules: [],
      modelMeta: TRUSTED_MAX,
    });
    expect(cfg).toBeDefined();
    expect(cfg?.baseUrl).toBe("https://example.com");
    expect((cfg?.models as any[]).length).toBe(1);
    expect((cfg?.models as any[])[0].id).toBe("gpt");
  });

  test("non-switchable provider yields undefined", () => {
    const cfg = buildProviderConfig(
      mk({ id: "2", appType: "claude", api: null, parseError: "unsupported" }),
      ["m"],
      { rules: [], modelMeta: TRUSTED_MAX },
    );
    expect(cfg).toBeUndefined();
  });

  test("falls back to configModels when no ids given", () => {
    const cfg = buildProviderConfig(mk({ id: "3", appType: "claude" }), [], {
      rules: [],
      modelMeta: TRUSTED_MAX,
    });
    expect((cfg?.models as any[])[0].id).toBe("m1");
  });

  test("per-api structural meta without inventing protocol maxTokens floors (#63)", () => {
    // Without a trusted maxTokens authority, no protocol 32K/64K/128K is injected
    // and the model is not registered.
    for (const api of [
      "anthropic-messages",
      "openai-responses",
      "openai-completions",
      "google-generative-ai",
    ] as const) {
      const bare = buildProviderConfig(
        mk({ id: api, appType: "claude", api }),
        ["unknown-model"],
        { rules: [] },
      );
      expect(bare).toBeUndefined();
    }

    // With explicit maxTokens, protocol still supplies contextWindow / input shape.
    const anthropic = buildProviderConfig(
      mk({ id: "a", appType: "claude", api: "anthropic-messages" }),
      ["m"],
      { rules: [], modelMeta: { maxTokens: 64_000, reasoning: true } },
    );
    const am = (anthropic?.models as any[])[0];
    expect(am.contextWindow).toBe(200_000);
    expect(am.maxTokens).toBe(64_000);
    expect(am.input).toEqual(["text", "image"]);
    expect(am.reasoning).toBe(true);

    const gemini = buildProviderConfig(
      mk({ id: "g", appType: "gemini", api: "google-generative-ai" }),
      ["m"],
      { rules: [], modelMeta: { maxTokens: 64_000 } },
    );
    expect((gemini?.models as any[])[0].contextWindow).toBe(1_000_000);

    const chat = buildProviderConfig(
      mk({ id: "c", appType: "hermes", api: "openai-completions" }),
      ["m"],
      { rules: [], modelMeta: { maxTokens: 32_000 } },
    );
    const cm = (chat?.models as any[])[0];
    expect(cm.contextWindow).toBe(128_000);
    expect(cm.input).toEqual(["text"]);
    // reasoning unknown → conservative false (not protocol true)
    expect(cm.reasoning).toBe(false);
  });

  test("modelMeta override disables reasoning (GLM-via-claude fix)", () => {
    const cfg = buildProviderConfig(
      mk({ id: "glm", appType: "claude", api: "anthropic-messages" }),
      ["glm-5.2"],
      { rules: [], modelMeta: { reasoning: false, maxTokens: 64_000 } },
    );
    const m = (cfg?.models as any[])[0];
    expect(m.reasoning).toBe(false);
    expect(m.contextWindow).toBe(200_000);
    expect(m.input).toEqual(["text", "image"]);
  });

  test("modelMeta override can raise contextWindow / maxTokens", () => {
    const cfg = buildProviderConfig(
      mk({ id: "big", appType: "claude", api: "anthropic-messages" }),
      ["m"],
      {
        rules: [],
        modelMeta: { contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true },
      },
    );
    const m = (cfg?.models as any[])[0];
    expect(m.contextWindow).toBe(1_000_000);
    expect(m.maxTokens).toBe(128_000);
    expect(m.reasoning).toBe(true);
  });

  test("modelMetaFor gives each model its own meta", () => {
    const cfg = buildProviderConfig(
      mk({ id: "per", appType: "claude", api: "anthropic-messages" }),
      ["glm-4.6", "claude-sonnet-4"],
      {
        rules: [],
        modelMeta: { reasoning: true, maxTokens: 64_000 },
        modelMetaFor: (id) =>
          id === "glm-4.6" ? { reasoning: false, maxTokens: 8_192 } : undefined,
      },
    );
    const models = cfg?.models as any[];
    expect(models[0].reasoning).toBe(false);
    expect(models[0].maxTokens).toBe(8_192);
    expect(models[1].reasoning).toBe(true);
    expect(models[1].maxTokens).toBe(64_000);
  });

  test("unknown model without maxTokens authority is not registered (#63)", () => {
    const cfg = buildProviderConfig(
      mk({ id: "def", appType: "claude", api: "anthropic-messages" }),
      ["m"],
      { rules: [] },
    );
    expect(cfg).toBeUndefined();
  });

  test("exact-model maxTokens override restores registration (#63)", () => {
    const cfg = buildProviderConfig(
      mk({ id: "def", appType: "claude", api: "anthropic-messages" }),
      ["m"],
      { rules: [], modelMeta: { maxTokens: 16_000 } },
    );
    expect(cfg).toBeDefined();
    expect((cfg?.models as any[])[0].maxTokens).toBe(16_000);
    // reasoning unknown → conservative false
    expect((cfg?.models as any[])[0].reasoning).toBe(false);
  });

  test("[1M] tag sets contextWindow=1M; maxTokens still needs authority", () => {
    const bare = buildProviderConfig(
      mk({ id: "ds", appType: "hermes", api: "openai-completions" }),
      ["deepseek-v4-flash[1M]"],
      { rules: [] },
    );
    expect(bare).toBeUndefined();

    const cfg = buildProviderConfig(
      mk({ id: "ds", appType: "hermes", api: "openai-completions" }),
      ["deepseek-v4-flash[1M]"],
      { rules: [], modelMeta: { maxTokens: 32_000 } },
    );
    const m = (cfg?.models as any[])[0];
    expect(m.contextWindow).toBe(1_000_000);
    expect(m.maxTokens).toBe(32_000);
    expect(m.reasoning).toBe(false);
  });

  test("lowercase [1m] also hits when maxTokens is known", () => {
    const cfg = buildProviderConfig(
      mk({ id: "ds", appType: "hermes", api: "openai-completions" }),
      ["deepseek-v4-flash[1m]"],
      { rules: [], modelMeta: { maxTokens: 32_000 } },
    );
    expect((cfg?.models as any[])[0].contextWindow).toBe(1_000_000);
  });

  test("sibling without tag keeps protocol tier window when maxTokens known", () => {
    const cfg = buildProviderConfig(
      mk({ id: "ds", appType: "hermes", api: "openai-completions" }),
      ["deepseek-v4-flash[1M]", "deepseek-v4-flash"],
      { rules: [], modelMeta: { maxTokens: 32_000 } },
    );
    const models = cfg?.models as any[];
    expect(models[0].contextWindow).toBe(1_000_000);
    expect(models[1].contextWindow).toBe(128_000);
  });

  test("user modelMeta.contextWindow beats [1M] tag", () => {
    const cfg = buildProviderConfig(
      mk({ id: "ds", appType: "hermes", api: "openai-completions" }),
      ["deepseek-v4-flash[1M]"],
      { rules: [], modelMeta: { contextWindow: 512_000, maxTokens: 32_000 } },
    );
    expect((cfg?.models as any[])[0].contextWindow).toBe(512_000);
  });

  test("[1M] tag beats models.dev 200k; lookup key is tagged id", () => {
    const seen: string[] = [];
    const cfg = buildProviderConfig(
      mk({ id: "ds", appType: "hermes", api: "openai-completions" }),
      ["deepseek-v4-flash[1M]"],
      {
        rules: [],
        modelsDevFor: (id) => {
          seen.push(id);
          return md({
            contextWindow: 200_000,
            maxTokens: 8_192,
            reasoning: false,
          });
        },
      },
    );
    expect(seen).toEqual(["deepseek-v4-flash[1M]"]);
    const m = (cfg?.models as any[])[0];
    expect(m.contextWindow).toBe(1_000_000);
    expect(m.maxTokens).toBe(8_192);
  });

  test("stale models.dev last-good still registers maxTokens (#63)", () => {
    const cfg = buildProviderConfig(
      mk({ id: "stale", appType: "hermes", api: "openai-completions" }),
      ["relay-model"],
      {
        rules: [],
        modelsDevFor: () =>
          md({
            maxTokens: 4_096,
            observedAt: "2020-01-01T00:00:00Z",
          }),
      },
    );
    expect((cfg?.models as any[])[0].maxTokens).toBe(4_096);
  });

  test("cc-switch meta maxTokens is a trusted authority (#63)", () => {
    const cfg = buildProviderConfig(
      mk({
        id: "cc",
        appType: "claude",
        api: "anthropic-messages",
        meta: { maxTokens: 12_000, reasoning: true },
      }),
      ["m"],
      { rules: [] },
    );
    const m = (cfg?.models as any[])[0];
    expect(m.maxTokens).toBe(12_000);
    expect(m.reasoning).toBe(true);
  });

  test("DeepSeek V4 Flash meta registers as thinkingLevelMap + nested compat", () => {
    const deepseekMeta = {
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
      thinkingLevelMap: {
        minimal: "high",
        low: "high",
        medium: "high",
        high: "high",
        xhigh: "max",
      },
    };
    const cfg = buildProviderConfig(
      mk({ id: "ds", appType: "hermes", api: "openai-completions" }),
      ["deepseek-v4-flash"],
      { rules: [], modelMeta: deepseekMeta },
    );
    const m = (cfg?.models as any[])[0];
    expect(m.reasoning).toBe(true);
    expect(m.contextWindow).toBe(1_000_000);
    expect(m.maxTokens).toBe(384_000);
    expect(m.thinkingLevelMap).toEqual(deepseekMeta.thinkingLevelMap);
    expect(m.compat).toMatchObject({
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
      supportsStore: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
    });
    expect(m.thinkingFormat).toBeUndefined();
  });

  test("same model id can register different windows/compat via modelMetaFor", () => {
    const cfgA = buildProviderConfig(
      mk({ id: "a", appType: "hermes", api: "openai-completions", displayName: "relay-a" }),
      ["deepseek-v4-flash"],
      {
        rules: [],
        modelMeta: {
          contextWindow: 1_000_000,
          maxTokens: 32_000,
          thinkingFormat: "deepseek",
          requiresReasoningContentOnAssistantMessages: true,
        },
      },
    );
    const cfgB = buildProviderConfig(
      mk({ id: "b", appType: "hermes", api: "openai-completions", displayName: "relay-b" }),
      ["deepseek-v4-flash"],
      {
        rules: [],
        modelMeta: { contextWindow: 128_000, maxTokens: 16_000, thinkingFormat: "openai" },
      },
    );
    const a = (cfgA?.models as any[])[0];
    const b = (cfgB?.models as any[])[0];
    expect(a.id).toBe(b.id);
    expect(a.contextWindow).toBe(1_000_000);
    expect(a.compat).toMatchObject({
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
      supportsStore: false,
    });
    expect(b.contextWindow).toBe(128_000);
    expect(b.compat).toMatchObject({ thinkingFormat: "openai", supportsStore: false });
  });

  test("unknown Chat relay defaults all Chat wire fields conservatively (#66)", () => {
    const cfg = buildProviderConfig(
      mk({
        id: "chat-relay",
        appType: "codex",
        api: "openai-completions",
        baseUrl: "https://relay.example/v1",
      }),
      ["relay-model"],
      { rules: [], modelMeta: TRUSTED_MAX },
    );

    expect(cfg?.models[0]?.compat).toMatchObject({
      supportsStore: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
    });
  });

  test("Chat Provider wire remaining fields reach every registered model (#66)", () => {
    const relay = mk({
      id: "chat-relay",
      appType: "codex",
      api: "openai-completions",
      baseUrl: "https://relay.example/v1",
    });
    const providerWireCompat = resolveProviderWireCompat({
      provider: relay,
      override: {
        api: "openai-completions",
        supportsStore: false,
        supportsUsageInStreaming: false,
        supportsStrictMode: false,
        requiresToolResultName: true,
        requiresAssistantAfterToolResult: true,
      },
    });
    const cfg = buildProviderConfig(relay, ["a", "b"], {
      rules: [],
      providerWireCompat,
    });
    for (const model of cfg?.models ?? []) {
      expect(model.compat).toMatchObject({
        supportsStore: false,
        supportsUsageInStreaming: false,
        supportsStrictMode: false,
        requiresToolResultName: true,
        requiresAssistantAfterToolResult: true,
      });
    }
  });

  test("explicit Provider supportsStore true and false reach every registered model", () => {
    const relay = mk({
      id: "chat-relay",
      appType: "codex",
      api: "openai-completions",
      baseUrl: "https://relay.example/v1",
    });

    for (const supportsStore of [true, false]) {
      const providerWireCompat = resolveProviderWireCompat({
        provider: relay,
        override: { api: "openai-completions", supportsStore },
      });
      const cfg = buildProviderConfig(relay, ["model-a", "model-b"], {
        rules: [],
        modelMeta: TRUSTED_MAX,
        providerWireCompat,
      });

      expect(cfg?.models.map((model) => model.compat?.supportsStore)).toEqual([
        supportsStore,
        supportsStore,
      ]);
    }
  });

  test("official OpenAI does not receive supportsStore; Anthropic relay gets Anthropic defaults (#65)", () => {
    const official = buildProviderConfig(
      mk({
        id: "official-openai",
        appType: "codex",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
      }),
      ["gpt-5"],
      { rules: [], modelMeta: TRUSTED_MAX },
    );
    const anthropic = buildProviderConfig(
      mk({
        id: "anthropic-relay",
        appType: "claude",
        api: "anthropic-messages",
        baseUrl: "https://relay.example",
      }),
      ["claude-model"],
      { rules: [], modelMeta: TRUSTED_MAX },
    );

    expect(official?.models[0]).toBeDefined();
    expect(anthropic?.models[0]).toBeDefined();
    expect(official?.models[0]?.compat?.supportsStore).toBeUndefined();
    // Unknown Anthropic relay: conservative false for all three (#65).
    expect(anthropic?.models[0]?.compat).toMatchObject({
      supportsEagerToolInputStreaming: false,
      supportsCacheControlOnTools: false,
      supportsLongCacheRetention: false,
    });
    expect(anthropic?.models[0]?.compat?.supportsStore).toBeUndefined();
  });

  test("Anthropic Provider wire overrides reach every registered model (#65)", () => {
    const relay = mk({
      id: "anthropic-relay",
      appType: "claude",
      api: "anthropic-messages",
      baseUrl: "https://relay.example",
    });
    const providerWireCompat = resolveProviderWireCompat({
      provider: relay,
      override: {
        api: "anthropic-messages",
        supportsEagerToolInputStreaming: false,
        supportsCacheControlOnTools: true,
        supportsLongCacheRetention: false,
      },
    });
    const cfg = buildProviderConfig(relay, ["model-a", "model-b"], {
      rules: [],
      providerWireCompat,
    });

    for (const model of cfg?.models ?? []) {
      expect(model.compat).toMatchObject({
        supportsEagerToolInputStreaming: false,
        supportsCacheControlOnTools: true,
        supportsLongCacheRetention: false,
      });
      expect(model.compat?.supportsStore).toBeUndefined();
    }
  });

  test("official Anthropic does not emit Anthropic wire overrides (#65)", () => {
    const cfg = buildProviderConfig(
      mk({
        id: "official-anthropic",
        appType: "claude",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      }),
      ["claude-sonnet"],
      { rules: [] },
    );
    expect(cfg?.models[0]?.compat?.supportsEagerToolInputStreaming).toBeUndefined();
    expect(cfg?.models[0]?.compat?.supportsCacheControlOnTools).toBeUndefined();
    expect(cfg?.models[0]?.compat?.supportsLongCacheRetention).toBeUndefined();
  });

  test("omitting providerWireCompat applies defaults only; providerWireOverride restores user fact", () => {
    const relay = mk({
      id: "chat-relay",
      appType: "codex",
      api: "openai-completions",
      baseUrl: "https://relay.example/v1",
    });

    // Footgun lock: bare opts never consult providerOverrides — only defaults.
    const defaultsOnly = buildProviderConfig(relay, ["relay-model"], {
      rules: [],
      modelMeta: TRUSTED_MAX,
    });
    expect(defaultsOnly?.models[0]?.compat).toMatchObject({
      supportsStore: false,
    });

    const withOverride = buildProviderConfig(relay, ["relay-model"], {
      rules: [],
      modelMeta: TRUSTED_MAX,
      providerWireOverride: {
        api: "openai-completions",
        supportsStore: true,
      },
    });
    expect(withOverride?.models[0]?.compat).toMatchObject({
      supportsStore: true,
    });
  });
});

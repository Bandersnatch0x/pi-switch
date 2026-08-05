import { test, expect, describe } from "bun:test";
import { buildProviderConfig } from "../src/register.ts";
import { resolveProviderWireCompat } from "../src/provider-wire-compat.ts";
import type { CcProvider } from "../src/types.ts";

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
      },
    );

    expect(cfg?.headers?.["X-Codex-Window-ID"]).toBe(
      "019b4c56-ae8b-7e5d-a65a-c0b64a3ddf80",
    );
  });

  test("switchable provider yields config with models", () => {
    const cfg = buildProviderConfig(mk({ id: "1", appType: "claude" }), ["gpt"], {
      rules: [],
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
      { rules: [] },
    );
    expect(cfg).toBeUndefined();
  });

  test("falls back to configModels when no ids given", () => {
    const cfg = buildProviderConfig(mk({ id: "3", appType: "claude" }), [], {
      rules: [],
    });
    expect((cfg?.models as any[])[0].id).toBe("m1");
  });

  test("per-api tiered meta (review #4)", () => {
    const anthropic = buildProviderConfig(
      mk({ id: "a", appType: "claude", api: "anthropic-messages" }),
      ["m"],
      { rules: [] },
    );
    const am = (anthropic?.models as any[])[0];
    expect(am.contextWindow).toBe(200_000);
    expect(am.maxTokens).toBe(64_000);
    expect(am.input).toEqual(["text", "image"]);
    expect(am.reasoning).toBe(true);

    const gemini = buildProviderConfig(
      mk({ id: "g", appType: "gemini", api: "google-generative-ai" }),
      ["m"],
      { rules: [] },
    );
    expect((gemini?.models as any[])[0].contextWindow).toBe(1_000_000);

    const chat = buildProviderConfig(
      mk({ id: "c", appType: "hermes", api: "openai-completions" }),
      ["m"],
      { rules: [] },
    );
    const cm = (chat?.models as any[])[0];
    expect(cm.contextWindow).toBe(128_000);
    expect(cm.input).toEqual(["text"]);
    expect(cm.reasoning).toBe(false);
  });

  test("modelMeta override disables reasoning (GLM-via-claude fix)", () => {
    // A claude-protocol provider whose upstream is actually GLM (dooongai-style
    // relay) rejects the `reasoning` request param. Per-provider modelMeta lets
    // the user turn it off without disabling thinking globally.
    const cfg = buildProviderConfig(
      mk({ id: "glm", appType: "claude", api: "anthropic-messages" }),
      ["glm-5.2"],
      { rules: [], modelMeta: { reasoning: false } },
    );
    const m = (cfg?.models as any[])[0];
    expect(m.reasoning).toBe(false);
    // other tier defaults are preserved
    expect(m.contextWindow).toBe(200_000);
    expect(m.input).toEqual(["text", "image"]);
  });

  test("modelMeta override can raise contextWindow / maxTokens", () => {
    const cfg = buildProviderConfig(
      mk({ id: "big", appType: "claude", api: "anthropic-messages" }),
      ["m"],
      { rules: [], modelMeta: { contextWindow: 1_000_000, maxTokens: 128_000 } },
    );
    const m = (cfg?.models as any[])[0];
    expect(m.contextWindow).toBe(1_000_000);
    expect(m.maxTokens).toBe(128_000);
    // reasoning still follows api tier when not overridden
    expect(m.reasoning).toBe(true);
  });

  test("modelMetaFor gives each model its own meta", () => {
    const cfg = buildProviderConfig(
      mk({ id: "per", appType: "claude", api: "anthropic-messages" }),
      ["glm-4.6", "claude-sonnet-4"],
      {
        rules: [],
        modelMeta: { reasoning: true },
        modelMetaFor: (id) =>
          id === "glm-4.6" ? { reasoning: false, maxTokens: 8_192 } : undefined,
      },
    );
    const models = cfg?.models as any[];
    expect(models[0].reasoning).toBe(false);
    expect(models[0].maxTokens).toBe(8_192);
    // falls back to opts.modelMeta when the resolver returns nothing
    expect(models[1].reasoning).toBe(true);
  });

  test("no modelMeta keeps api-tier defaults", () => {
    const cfg = buildProviderConfig(
      mk({ id: "def", appType: "claude", api: "anthropic-messages" }),
      ["m"],
      { rules: [] },
    );
    const m = (cfg?.models as any[])[0];
    expect(m.reasoning).toBe(true);
    expect(m.contextWindow).toBe(200_000);
  });

  test("[1M] tag sets contextWindow=1M without polluting maxTokens/reasoning", () => {
    const cfg = buildProviderConfig(
      mk({ id: "ds", appType: "hermes", api: "openai-completions" }),
      ["deepseek-v4-flash[1M]"],
      { rules: [] },
    );
    const m = (cfg?.models as any[])[0];
    expect(m.contextWindow).toBe(1_000_000);
    expect(m.maxTokens).toBe(32_000);
    expect(m.reasoning).toBe(false);
  });

  test("lowercase [1m] also hits", () => {
    const cfg = buildProviderConfig(
      mk({ id: "ds", appType: "hermes", api: "openai-completions" }),
      ["deepseek-v4-flash[1m]"],
      { rules: [] },
    );
    expect((cfg?.models as any[])[0].contextWindow).toBe(1_000_000);
  });

  test("sibling without tag keeps protocol tier window", () => {
    const cfg = buildProviderConfig(
      mk({ id: "ds", appType: "hermes", api: "openai-completions" }),
      ["deepseek-v4-flash[1M]", "deepseek-v4-flash"],
      { rules: [] },
    );
    const models = cfg?.models as any[];
    expect(models[0].contextWindow).toBe(1_000_000);
    expect(models[1].contextWindow).toBe(128_000);
  });

  test("user modelMeta.contextWindow beats [1M] tag", () => {
    const cfg = buildProviderConfig(
      mk({ id: "ds", appType: "hermes", api: "openai-completions" }),
      ["deepseek-v4-flash[1M]"],
      { rules: [], modelMeta: { contextWindow: 512_000 } },
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
          return {
            contextWindow: 200_000,
            maxTokens: 8_192,
            reasoning: false,
            observedAt: "2026-07-31T00:00:00Z",
            source: "models-dev",
          };
        },
      },
    );
    expect(seen).toEqual(["deepseek-v4-flash[1M]"]);
    const m = (cfg?.models as any[])[0];
    expect(m.contextWindow).toBe(1_000_000);
    // maxTokens still from models.dev (tag only sets contextWindow)
    expect(m.maxTokens).toBe(8_192);
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
    expect(m.compat).toEqual({
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
      supportsStore: false,
    });
    // Never emit legacy top-level thinkingFormat
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
        modelMeta: { contextWindow: 128_000, thinkingFormat: "openai" },
      },
    );
    const a = (cfgA?.models as any[])[0];
    const b = (cfgB?.models as any[])[0];
    expect(a.id).toBe(b.id);
    expect(a.contextWindow).toBe(1_000_000);
    expect(a.compat).toEqual({
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
      supportsStore: false,
    });
    expect(b.contextWindow).toBe(128_000);
    expect(b.compat).toEqual({ thinkingFormat: "openai", supportsStore: false });
  });

  test("unknown Chat relay defaults supportsStore to false", () => {
    const cfg = buildProviderConfig(
      mk({
        id: "chat-relay",
        appType: "codex",
        api: "openai-completions",
        baseUrl: "https://relay.example/v1",
      }),
      ["relay-model"],
      { rules: [] },
    );

    expect(cfg?.models[0]?.compat).toMatchObject({ supportsStore: false });
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
        providerWireCompat,
      });

      expect(cfg?.models.map((model) => model.compat?.supportsStore)).toEqual([
        supportsStore,
        supportsStore,
      ]);
    }
  });

  test("official OpenAI and non-Chat APIs do not receive a model compat override", () => {
    const official = buildProviderConfig(
      mk({
        id: "official-openai",
        appType: "codex",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
      }),
      ["gpt-5"],
      { rules: [] },
    );
    const anthropic = buildProviderConfig(
      mk({
        id: "anthropic-relay",
        appType: "claude",
        api: "anthropic-messages",
        baseUrl: "https://relay.example",
      }),
      ["claude-model"],
      { rules: [] },
    );

    expect(official?.models[0]?.compat?.supportsStore).toBeUndefined();
    expect(anthropic?.models[0]?.compat?.supportsStore).toBeUndefined();
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
    });
    expect(defaultsOnly?.models[0]?.compat).toMatchObject({
      supportsStore: false,
    });

    const withOverride = buildProviderConfig(relay, ["relay-model"], {
      rules: [],
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

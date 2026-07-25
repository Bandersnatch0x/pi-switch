import { test, expect, describe } from "bun:test";
import { buildProviderConfig } from "../src/register.ts";
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
});

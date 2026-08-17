import { describe, expect, test } from "bun:test";
import { resolvePiThinkingRuntimeCapability } from "../src/capabilities/thinking-runtime.ts";
import type { ProviderReasoningProfile } from "../src/capabilities/thinking-projection.ts";

function profile(
  control: ProviderReasoningProfile["control"],
  api: ProviderReasoningProfile["tuple"]["api"],
  modelId = "model",
): ProviderReasoningProfile {
  return {
    tuple: {
      appType: "test",
      providerId: "p1",
      api,
      baseUrl: "https://example.com/v1",
      modelId,
    },
    profileVersion: "fixture@1",
    control,
    variants: [],
    source: "built-in",
    observedAt: "2026-08-17T00:00:00.000Z",
  };
}

describe("Pi thinking runtime capability matrix", () => {
  test("only payload-verified Pi releases enable the matching OpenAI effort adapter", () => {
    for (const version of ["0.81.1", "0.84.2"]) {
      const verified = resolvePiThinkingRuntimeCapability({
        version,
        profile: profile({ type: "effort" }, "openai-responses"),
      });
      expect(verified).toMatchObject({
        version,
        payloadVerified: true,
        supportedControls: ["effort"],
      });
    }

    const old = resolvePiThinkingRuntimeCapability({
      version: "0.80.0",
      profile: profile({ type: "effort" }, "openai-responses"),
    });
    expect(old.payloadVerified).toBe(false);
    expect(old.supportedControls).toEqual([]);

    const adjacent = resolvePiThinkingRuntimeCapability({
      version: "0.84.1",
      profile: profile({ type: "effort" }, "openai-responses"),
    });
    expect(adjacent.payloadVerified).toBe(false);

    const unknown = resolvePiThinkingRuntimeCapability({
      profile: profile({ type: "effort" }, "openai-responses"),
    });
    expect(unknown.version).toBe("unknown");
    expect(unknown.payloadVerified).toBe(false);
  });

  test("distinguishes a verified runtime with an unsupported control from an unknown runtime", () => {
    const unsupportedControl = resolvePiThinkingRuntimeCapability({
      version: "0.84.2",
      profile: profile({ type: "toggle" }, "openai-responses"),
    });
    expect(unsupportedControl).toMatchObject({
      runtimeVerified: true,
      payloadVerified: false,
      supportedControls: [],
    });

    const unknownRuntime = resolvePiThinkingRuntimeCapability({
      version: "0.84.1",
      profile: profile({ type: "toggle" }, "openai-responses"),
    });
    expect(unknownRuntime).toMatchObject({
      runtimeVerified: false,
      payloadVerified: false,
    });
  });

  test("reports Codex Responses off as indistinguishable from provider default", () => {
    const codexCatalog = profile({ type: "effort" }, "openai-responses");
    codexCatalog.source = "codex-model-catalog";

    expect(
      resolvePiThinkingRuntimeCapability({
        version: "0.84.2",
        profile: codexCatalog,
      }),
    ).toMatchObject({
      payloadVerified: true,
      supportedControls: ["effort"],
      providerDefault: "supported",
      off: "indistinguishable-from-provider-default",
    });

    const providerMetadata = profile({ type: "effort" }, "openai-responses");
    providerMetadata.source = "provider-model-metadata";
    expect(
      resolvePiThinkingRuntimeCapability({
        version: "0.84.2",
        profile: providerMetadata,
      }).off,
    ).toBe("supported");

    const exactUser = profile({ type: "effort" }, "openai-responses");
    exactUser.tuple.appType = "codex";
    exactUser.source = "user";
    expect(
      resolvePiThinkingRuntimeCapability({
        version: "0.84.2",
        profile: exactUser,
      }).off,
    ).toBe("indistinguishable-from-provider-default");
  });

  test("gates Anthropic adaptive and Chat composite controls on their exact tuple dialect", () => {
    const adaptive = profile({ type: "effort" }, "anthropic-messages");
    expect(
      resolvePiThinkingRuntimeCapability({
        version: "0.81.1",
        profile: adaptive,
        anthropic: { forceAdaptiveThinking: true },
      }),
    ).toMatchObject({ payloadVerified: true, supportedControls: ["effort"] });
    expect(
      resolvePiThinkingRuntimeCapability({
        version: "0.81.1",
        profile: adaptive,
        anthropic: { forceAdaptiveThinking: false },
      }).payloadVerified,
    ).toBe(false);

    const manual = profile(
      { type: "budget_tokens", minTokens: 1024 },
      "anthropic-messages",
    );
    expect(
      resolvePiThinkingRuntimeCapability({
        version: "0.81.1",
        profile: manual,
        anthropic: { forceAdaptiveThinking: false },
      }),
    ).toMatchObject({
      payloadVerified: true,
      supportedControls: ["budget_tokens"],
    });
    expect(
      resolvePiThinkingRuntimeCapability({
        version: "0.81.1",
        profile: manual,
        anthropic: { forceAdaptiveThinking: true },
      }).payloadVerified,
    ).toBe(false);

    const composite = profile(
      { type: "composite", controls: [{ type: "toggle" }, { type: "effort" }] },
      "openai-completions",
    );
    expect(
      resolvePiThinkingRuntimeCapability({
        version: "0.81.1",
        profile: composite,
        chat: { thinkingFormat: "deepseek", supportsReasoningEffort: true },
      }),
    ).toMatchObject({ payloadVerified: true, supportedControls: ["composite"] });
    expect(
      resolvePiThinkingRuntimeCapability({
        version: "0.81.1",
        profile: composite,
        chat: { thinkingFormat: "deepseek" },
      }).payloadVerified,
    ).toBe(false);

    const glm = resolvePiThinkingRuntimeCapability({
      version: "0.81.1",
      profile: composite,
      chat: { thinkingFormat: "zai", supportsReasoningEffort: true },
    });
    expect(glm).toMatchObject({
      payloadVerified: true,
      supportedControls: ["composite"],
      providerDefault: "unsupported",
      off: "supported",
    });
  });

  test("keeps Gemini budget and effort rows separate", () => {
    const budget = resolvePiThinkingRuntimeCapability({
      version: "0.81.1",
      profile: profile({ type: "budget_tokens", minTokens: 128 }, "google-generative-ai", "gemini-2.5-pro"),
    });
    expect(budget).toMatchObject({
      payloadVerified: true,
      supportedControls: ["budget_tokens"],
      providerDefault: "unsupported",
      off: "supported",
    });

    const effort = resolvePiThinkingRuntimeCapability({
      version: "0.81.1",
      profile: profile({ type: "effort" }, "google-generative-ai", "gemini-3-pro-preview"),
    });
    expect(effort).toMatchObject({
      payloadVerified: true,
      supportedControls: ["effort"],
      providerDefault: "unsupported",
      off: "unsupported",
    });
  });
});

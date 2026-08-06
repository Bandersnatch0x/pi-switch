import { describe, expect, test } from "bun:test";
import {
  parseProviderWireCompat,
  providerWireCompatForRegistration,
  resolveProviderWireCompat,
} from "../src/provider-wire-compat.ts";
import type { CcProvider } from "../src/types.ts";

function provider(
  api: CcProvider["api"] = "openai-completions",
  baseUrl = "https://relay.example/v1",
): CcProvider {
  return {
    id: "provider-1",
    piName: "ps-codex-provider-1",
    displayName: "relay",
    appType: "codex",
    api,
    baseUrl,
    apiKey: "test-key",
    authHeader: true,
    configModels: ["relay-model"],
    meta: {},
    isCurrentInCc: false,
  };
}

describe("parseProviderWireCompat", () => {
  test("preserves explicit true, explicit false, and field absence", () => {
    expect(parseProviderWireCompat(undefined)).toBeUndefined();
    expect(
      parseProviderWireCompat({
        api: "openai-completions",
        supportsStore: true,
      }),
    ).toEqual({ api: "openai-completions", supportsStore: true });
    expect(
      parseProviderWireCompat({
        api: "openai-completions",
        supportsStore: false,
      }),
    ).toEqual({ api: "openai-completions", supportsStore: false });
    expect(parseProviderWireCompat({ api: "openai-completions" })).toEqual({
      api: "openai-completions",
    });

    expect(
      parseProviderWireCompat({
        api: "anthropic-messages",
        supportsEagerToolInputStreaming: false,
        supportsCacheControlOnTools: true,
      }),
    ).toEqual({
      api: "anthropic-messages",
      supportsEagerToolInputStreaming: false,
      supportsCacheControlOnTools: true,
    });
  });

  test("rejects null, non-Chat APIs, unknown keys, and wrong types", () => {
    const invalid = [
      null,
      { api: "openai-responses", supportsStore: true },
      { api: "openai-completions", supportsStore: null },
      { api: "openai-completions", supportsStore: "yes" },
      { api: "openai-completions", supportsStore: true, extra: false },
      { supportsStore: true },
      { api: "anthropic-messages", supportsEagerToolInputStreaming: null },
      { api: "anthropic-messages", supportsEagerToolInputStreaming: "yes" },
      { api: "anthropic-messages", extra: true },
      { supportsEagerToolInputStreaming: true },
    ];
    for (const value of invalid) {
      expect(() => parseProviderWireCompat(value)).toThrow();
    }
  });
});

describe("resolveProviderWireCompat", () => {
  test("uses an explicit Provider override without truthy cleanup", () => {
    const falseResult = resolveProviderWireCompat({
      provider: provider(),
      override: { api: "openai-completions", supportsStore: false },
    });
    const trueResult = resolveProviderWireCompat({
      provider: provider(),
      override: { api: "openai-completions", supportsStore: true },
    });

    expect(falseResult).toMatchObject({
      value: false,
      source: "user-provider",
      scope: "provider",
      conflicts: [],
    });
    expect(trueResult).toMatchObject({
      value: true,
      source: "user-provider",
      scope: "provider",
      conflicts: [],
    });
    expect(providerWireCompatForRegistration(falseResult)).toEqual({
      supportsStore: false,
    });
    expect(providerWireCompatForRegistration(trueResult)).toEqual({
      supportsStore: true,
    });
  });

  test("keeps the official OpenAI adapter native when no override exists", () => {
    const result = resolveProviderWireCompat({
      provider: provider("openai-completions", "https://api.openai.com/v1"),
    });

    expect(result).toMatchObject({
      value: true,
      source: "official-adapter",
      scope: "provider",
      conflicts: [],
    });
    expect(providerWireCompatForRegistration(result)).toBeUndefined();
  });

  test("uses a conservative false registration for an unknown relay", () => {
    const result = resolveProviderWireCompat({ provider: provider() });

    expect(result).toMatchObject({
      value: false,
      source: "conservative-default",
      scope: "provider",
      conflicts: [],
    });
    expect(providerWireCompatForRegistration(result)).toEqual({
      supportsStore: false,
    });
  });

  test("surfaces an explicit override that conflicts with the official adapter fact", () => {
    const result = resolveProviderWireCompat({
      provider: provider("openai-completions", "https://api.openai.com/v1"),
      override: { api: "openai-completions", supportsStore: false },
    });

    expect(result && "value" in result ? result.value : undefined).toBe(false);
    expect(result?.conflicts).toEqual([
      {
        field: "supportsStore",
        effective: false,
        effectiveSource: "user-provider",
        overridden: true,
        overriddenSource: "official-adapter",
      },
    ]);
  });

  test("soft-fails on a stale discriminator for non-matching APIs", () => {
    // Leftover Chat compat on a non-Chat (or API-changed) provider must not throw
    // so doctor / info / switch stay operational.
    expect(
      resolveProviderWireCompat({
        provider: provider("openai-responses"),
        override: { api: "openai-completions", supportsStore: true },
      }),
    ).toBeUndefined();
    // Stale Chat override on Anthropic is ignored; Anthropic still resolves
    // its own conservative defaults.
    const anthropic = resolveProviderWireCompat({
      provider: provider("anthropic-messages"),
      override: { api: "openai-completions", supportsStore: false },
    });
    expect(anthropic?.api).toBe("anthropic-messages");
    expect(anthropic?.source).toBe("conservative-default");
  });
});

describe("Anthropic Provider wire compat (#65)", () => {
  test("parses three independent boolean fields without truthy cleanup", () => {
    expect(
      parseProviderWireCompat({
        api: "anthropic-messages",
        supportsEagerToolInputStreaming: false,
        supportsCacheControlOnTools: false,
        supportsLongCacheRetention: true,
      }),
    ).toEqual({
      api: "anthropic-messages",
      supportsEagerToolInputStreaming: false,
      supportsCacheControlOnTools: false,
      supportsLongCacheRetention: true,
    });
  });

  test("unknown Anthropic relay defaults all three to conservative false", () => {
    const result = resolveProviderWireCompat({
      provider: provider("anthropic-messages", "https://relay.example"),
    });
    expect(result?.api).toBe("anthropic-messages");
    expect(result?.source).toBe("conservative-default");
    if (result?.api !== "anthropic-messages") throw new Error("expected anthropic");
    expect(result.fields).toEqual({
      supportsEagerToolInputStreaming: {
        value: false,
        source: "conservative-default",
      },
      supportsCacheControlOnTools: {
        value: false,
        source: "conservative-default",
      },
      supportsLongCacheRetention: {
        value: false,
        source: "conservative-default",
      },
    });
    expect(providerWireCompatForRegistration(result)).toEqual({
      supportsEagerToolInputStreaming: false,
      supportsCacheControlOnTools: false,
      supportsLongCacheRetention: false,
    });
  });

  test("official Anthropic keeps adapter native (no registration override)", () => {
    const result = resolveProviderWireCompat({
      provider: provider("anthropic-messages", "https://api.anthropic.com"),
    });
    expect(result).toMatchObject({
      api: "anthropic-messages",
      source: "official-adapter",
      scope: "provider",
    });
    expect(providerWireCompatForRegistration(result)).toBeUndefined();
  });

  test("explicit overrides resolve independently and surface official conflicts", () => {
    const result = resolveProviderWireCompat({
      provider: provider("anthropic-messages", "https://api.anthropic.com"),
      override: {
        api: "anthropic-messages",
        supportsEagerToolInputStreaming: false,
        supportsCacheControlOnTools: true,
        // long retention absent → official true
      },
    });
    expect(result?.api).toBe("anthropic-messages");
    if (result?.api !== "anthropic-messages") throw new Error("expected anthropic");
    expect(result.fields.supportsEagerToolInputStreaming).toEqual({
      value: false,
      source: "user-provider",
    });
    expect(result.fields.supportsCacheControlOnTools).toEqual({
      value: true,
      source: "user-provider",
    });
    expect(result.fields.supportsLongCacheRetention).toEqual({
      value: true,
      source: "official-adapter",
    });
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({
        field: "supportsEagerToolInputStreaming",
        effective: false,
        overridden: true,
      }),
    );
    // Only non-official fields are emitted for registration.
    expect(providerWireCompatForRegistration(result)).toEqual({
      supportsEagerToolInputStreaming: false,
      supportsCacheControlOnTools: true,
    });
  });

  test("Chat store and Anthropic fields do not cross-apply", () => {
    const chat = resolveProviderWireCompat({
      provider: provider("openai-completions"),
      override: {
        api: "anthropic-messages",
        supportsEagerToolInputStreaming: false,
      },
    });
    // Stale Anthropic override on Chat is ignored → Chat conservative default.
    expect(chat?.api).toBe("openai-completions");
    expect(chat && "value" in chat ? chat.value : undefined).toBe(false);

    expect(() =>
      parseProviderWireCompat({
        api: "openai-completions",
        supportsEagerToolInputStreaming: false,
      }),
    ).toThrow(/unknown key/);
    expect(() =>
      parseProviderWireCompat({
        api: "anthropic-messages",
        supportsStore: false,
      }),
    ).toThrow(/unknown key/);
  });
});

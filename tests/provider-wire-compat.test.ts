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
      parseProviderWireCompat({ api: "openai-completions", supportsStore: true }),
    ).toEqual({ api: "openai-completions", supportsStore: true });
    expect(
      parseProviderWireCompat({ api: "openai-completions", supportsStore: false }),
    ).toEqual({ api: "openai-completions", supportsStore: false });
    expect(parseProviderWireCompat({ api: "openai-completions" })).toEqual({
      api: "openai-completions",
    });
  });

  test("rejects null, non-Chat APIs, unknown keys, and wrong types", () => {
    const invalid = [
      null,
      { api: "openai-responses", supportsStore: true },
      { api: "anthropic-messages", supportsStore: true },
      { api: "openai-completions", supportsStore: null },
      { api: "openai-completions", supportsStore: "yes" },
      { api: "openai-completions", supportsStore: true, extra: false },
      { supportsStore: true },
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

    expect(result?.value).toBe(false);
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

  test("does not apply to another API and rejects a discriminator mismatch", () => {
    expect(
      resolveProviderWireCompat({ provider: provider("anthropic-messages") }),
    ).toBeUndefined();
    expect(() =>
      resolveProviderWireCompat({
        provider: provider("openai-responses"),
        override: { api: "openai-completions", supportsStore: true },
      }),
    ).toThrow(/does not match provider api/i);
  });
});

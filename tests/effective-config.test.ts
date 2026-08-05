import { describe, expect, spyOn, test } from "bun:test";
import {
  registerCommands,
  runEffectiveConfigCommand,
} from "../extensions/commands.ts";
import {
  createEffectiveConfigSummary,
  formatEffectiveConfigSummary,
} from "../src/effective-config.ts";
import type { BuiltProviderConfig } from "../src/register.ts";
import { resolveProviderWireCompat } from "../src/provider-wire-compat.ts";
import type { CcProvider } from "../src/types.ts";

function provider(): CcProvider {
  return {
    id: "provider-1",
    piName: "ps-codex-provider-1",
    displayName: "relay",
    appType: "codex",
    api: "openai-responses",
    baseUrl: "https://user:password@example.com/v1?token=secret#private",
    apiKey: "literal-secret-value",
    authHeader: true,
    configModels: ["gpt-5"],
    meta: {},
    isCurrentInCc: false,
  };
}

function builtConfig(): BuiltProviderConfig {
  return {
    name: "relay",
    baseUrl: "https://user:password@example.com/v1?token=secret#private",
    apiKey: "literal-secret-value",
    api: "openai-responses",
    authHeader: true,
    headers: {
      Authorization: "Bearer hidden",
      "User-Agent": "codex-cli/1.0",
      "x-api-key": "hidden",
    },
    models: [
      {
        id: "gpt-5",
        name: "gpt-5",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 400_000,
        maxTokens: 32_000,
        thinkingLevelMap: { high: "high" },
        compat: {
          thinkingFormat: "openai",
          requiresReasoningContentOnAssistantMessages: true,
        },
      },
    ],
  };
}

describe("effective config summary", () => {
  test("shows effective fields without secret values or endpoint credentials", () => {
    const summary = createEffectiveConfigSummary({
      source: "active",
      provider: provider(),
      modelId: "gpt-5",
      config: builtConfig(),
      fingerprint: "codex",
    });
    const text = formatEffectiveConfigSummary(summary);

    expect(summary.headerNames).toEqual(["User-Agent"]);
    expect(text).toContain("endpoint: https://example.com/v1");
    expect(text).toContain("apiKey=literal");
    expect(text).toContain("contextWindow=400000");
    expect(text).toContain("thinkingFormat=openai");
    expect(text).toContain("thinkingLevelMap=1");
    expect(text).toContain("requiresReasoningContentOnAssistantMessages=true");
    expect(text).not.toContain("literal-secret-value");
    expect(text).not.toContain("password");
    expect(text).not.toContain("token=secret");
    expect(text).not.toContain("Bearer hidden");
  });

  test("shows Provider supportsStore value, scope, and authority source", () => {
    const chatProvider = {
      ...provider(),
      api: "openai-completions" as const,
      baseUrl: "https://relay.example/v1",
    };
    const config = {
      ...builtConfig(),
      api: "openai-completions" as const,
      baseUrl: chatProvider.baseUrl,
      models: [
        {
          ...builtConfig().models[0]!,
          compat: { supportsStore: false },
        },
      ],
    };
    const providerWireCompat = resolveProviderWireCompat({ provider: chatProvider });
    const summary = createEffectiveConfigSummary({
      source: "active",
      provider: chatProvider,
      modelId: "gpt-5",
      config,
      providerWireCompat,
    });
    const text = formatEffectiveConfigSummary(summary);

    expect(summary.providerWireCompat).toMatchObject({
      api: "openai-completions",
      supportsStore: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
      scope: "provider",
      source: "conservative-default",
    });
    expect(text).toContain("store=false");
    expect(text).toContain("usageStream=false");
    expect(text).toContain("strict=false");
    expect(text).toContain("scope=provider source=conservative-default");
  });

  test("shows Anthropic Provider wire fields, scope, and authority source (#65)", () => {
    const anthropicProvider = {
      ...provider(),
      api: "anthropic-messages" as const,
      appType: "claude",
      baseUrl: "https://relay.example",
    };
    const config = {
      ...builtConfig(),
      api: "anthropic-messages" as const,
      baseUrl: anthropicProvider.baseUrl,
      models: [
        {
          ...builtConfig().models[0]!,
          compat: {
            supportsEagerToolInputStreaming: false,
            supportsCacheControlOnTools: false,
            supportsLongCacheRetention: false,
          },
        },
      ],
    };
    const providerWireCompat = resolveProviderWireCompat({
      provider: anthropicProvider,
    });
    const summary = createEffectiveConfigSummary({
      source: "active",
      provider: anthropicProvider,
      modelId: "claude-model",
      config,
      providerWireCompat,
    });
    const text = formatEffectiveConfigSummary(summary);

    expect(summary.providerWireCompat).toMatchObject({
      api: "anthropic-messages",
      supportsEagerToolInputStreaming: false,
      supportsCacheControlOnTools: false,
      supportsLongCacheRetention: false,
      scope: "provider",
      source: "conservative-default",
    });
    expect(text).toContain("eager=false");
    expect(text).toContain("cacheOnTools=false");
    expect(text).toContain("longRetention=false");
  });

  test("command prefers the active runtime model and registers ps-info", () => {
    const notifications: string[] = [];
    const logs = spyOn(console, "log").mockImplementation(() => undefined);
    const currentProvider = provider();
    const rt = {
      config: { aliasCcs: false },
      headerRules: [],
      state: { readSelection: () => undefined },
      reloadConfig() {
        return this.config;
      },
      reloadHeaderRules() {
        return this.headerRules;
      },
      refreshSnapshot: () => ({ providers: [currentProvider] }),
      headerOverrideOpts: () => ({
        overrideHeaders: { "User-Agent": "codex-cli/1.0" },
      }),
      headerVars: () => ({}),
      rejectSink: () => undefined,
      // Trusted maxTokens so registration is eligible under issue #63.
      modelMetaFor: () => ({ contextWindow: 400_000, maxTokens: 32_000 }),
      providerWireCompatFor: () => undefined,
      modelsDevFor: () => undefined,
      capabilitiesFor: () => ({
        contextWindow: { value: 400_000, source: "user-override" },
        maxTokens: { value: 32_000, source: "user-override" },
        reasoning: { value: true, source: "user-override" },
        vision: { value: false, source: "conservative-default" },
        conflicts: [],
      }),
      tupleCompatFor: () => undefined,
    };
    const ctx = {
      model: { provider: currentProvider.piName, id: "gpt-5" },
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus() {},
      },
    };

    runEffectiveConfigCommand(rt as never, ctx as never);
    logs.mockRestore();

    const joined = notifications.join("\n");
    expect(joined).toContain("source: current session");
    expect(joined).toContain("headers: User-Agent");
    expect(joined).not.toContain("literal-secret-value");

    const registered: string[] = [];
    registerCommands(
      { registerCommand: (name: string) => registered.push(name) } as never,
      rt as never,
      { install() {}, activate: async () => ({}) } as never,
    );
    expect(registered).toContain("ps-info");
  });
});

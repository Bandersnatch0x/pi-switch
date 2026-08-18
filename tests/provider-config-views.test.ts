import { describe, expect, test } from "bun:test";
import { ProviderConfigViews } from "../src/provider-config-views.ts";
import type { CcProvider, PiSwitchConfig } from "../src/types.ts";

function provider(partial: Partial<CcProvider> = {}): CcProvider {
  return {
    id: "relay-1",
    piName: "ps-relay-1",
    displayName: "Relay One",
    appType: "claude",
    api: "anthropic-messages",
    baseUrl: "https://anyrouter.top/v1",
    apiKey: "test-key",
    authHeader: true,
    configModels: ["model-1"],
    meta: {},
    isCurrentInCc: false,
    ...partial,
  };
}

describe("ProviderConfigViews effective compatibility", () => {
  test("resolves global defaults and provider overrides into one effective value", () => {
    let config: PiSwitchConfig = {
      claudeCodeCompat: { mode: "auto" },
      geminiToolCompat: { mode: "always" },
    };
    const views = new ProviderConfigViews(() => config);
    const claude = provider();
    const gemini = provider({
      id: "gemini-relay",
      piName: "ps-gemini-relay",
      appType: "gemini",
      api: "google-generative-ai",
      baseUrl: "https://gemini-relay.example/v1",
    });

    expect(views.effectiveCompatibilityFor(claude)).toEqual({
      claudeCodeCompat: true,
    });
    expect(views.effectiveCompatibilityFor(gemini)).toEqual({
      geminiToolCompat: true,
    });

    config = {
      claudeCodeCompat: { mode: "always" },
      geminiToolCompat: { mode: "always" },
      providerOverrides: {
        claude: { [claude.id]: { claudeCodeCompat: false } },
        gemini: { [gemini.id]: { geminiToolCompat: false } },
      },
    };

    expect(views.effectiveCompatibilityFor(claude)).toEqual({});
    expect(views.effectiveCompatibilityFor(gemini)).toEqual({});
  });
});

import { describe, expect, test } from "bun:test";
import { resolveProviderReasoningProfile } from "../src/capabilities/reasoning-profile-registry.ts";
import type { FsLike } from "../src/json-file.ts";
import { ProviderConfigViews } from "../src/provider-config-views.ts";
import { resolveProviderOverride } from "../src/provider-override.ts";
import {
  readPiSwitchConfig,
  writeExactModelReasoningProfile,
} from "../src/settings.ts";
import type { CcProvider } from "../src/types.ts";

function memFs(initial: Record<string, string> = {}): FsLike & {
  store: Record<string, string>;
} {
  const store = { ...initial };
  return {
    store,
    existsSync: (path) => path in store,
    readFileSync: (path) => {
      if (!(path in store)) throw new Error("missing");
      return store[path]!;
    },
    writeFileSync: (path, data) => {
      store[path] = data;
    },
    renameSync: (from, to) => {
      store[to] = store[from]!;
      delete store[from];
    },
  };
}

const provider: CcProvider = {
  id: "relay-1",
  piName: "ps-hermes-relay-1",
  displayName: "Relay One",
  appType: "hermes",
  api: "openai-completions",
  baseUrl: "https://relay.example/v1",
  apiKey: "key",
  authHeader: true,
  configModels: ["custom-reasoner"],
  meta: {},
  isCurrentInCc: false,
};

describe("exact user reasoning profile", () => {
  test("round-trips through config and wins at the tuple-scoped registry seam", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        providerOverrides: {
          hermes: {
            "relay-1": {
              modelOverrides: {
                "custom-reasoner": {
                  maxTokens: 64_000,
                  compat: {
                    api: "openai-completions",
                    supportsReasoningEffort: false,
                  },
                },
              },
            },
          },
        },
      }),
    });

    expect(
      writeExactModelReasoningProfile(
        { fs, configPath: "/c.json", pid: 7 },
        provider,
        "custom-reasoner",
        {
          profileVersion: "relay-contract/v1",
          control: { type: "fixed", enabled: true },
          variants: [],
          observedAt: "2026-08-18T00:00:00.000Z",
        },
      ),
    ).toEqual({ ok: true });

    const config = readPiSwitchConfig(fs, "/c.json");
    const entry = resolveProviderOverride(config.providerOverrides, provider)
      ?.modelOverrides?.["custom-reasoner"];
    expect(entry?.maxTokens).toBe(64_000);
    expect(entry?.compat).toMatchObject({ supportsReasoningEffort: false });
    expect(entry?.reasoningProfile?.control).toEqual({
      type: "fixed",
      enabled: true,
    });

    const views = new ProviderConfigViews(() => config);
    const profile = resolveProviderReasoningProfile(
      provider,
      "custom-reasoner",
      views.reasoningProfileFor(provider, "custom-reasoner"),
    );
    expect(profile).toMatchObject({
      tuple: {
        providerId: "relay-1",
        api: "openai-completions",
        modelId: "custom-reasoner",
      },
      source: "user",
      profileVersion: "relay-contract/v1",
    });
  });

  test("rejects broad scopes and malformed external profile definitions", () => {
    const fixedProfile = {
      profileVersion: "relay-contract/v1",
      control: { type: "fixed", enabled: true },
      variants: [],
      observedAt: "2026-08-18T00:00:00.000Z",
    };
    const invalidDocuments = [
      {
        defaultModelMeta: { reasoningProfile: fixedProfile },
      },
      {
        providerOverrides: {
          hermes: {
            "relay-1": { reasoningProfile: fixedProfile },
          },
        },
      },
      {
        providerOverrides: {
          hermes: {
            "relay-1": {
              modelOverrides: {
                "custom-*": { reasoningProfile: fixedProfile },
              },
            },
          },
        },
      },
      {
        providerOverrides: {
          hermes: {
            "relay-1": {
              modelOverrides: {
                "custom-reasoner": {
                  reasoningProfile: {
                    profileVersion: "relay-contract/v1",
                    control: { type: "budget_tokens", minTokens: 1024 },
                    variants: [
                      {
                        name: "low",
                        native: { type: "budget_tokens", tokens: 512 },
                      },
                    ],
                    observedAt: "2026-08-18T00:00:00.000Z",
                  },
                },
              },
            },
          },
        },
      },
    ];

    for (const [index, document] of invalidDocuments.entries()) {
      const fs = memFs({ [`/bad-${index}.json`]: JSON.stringify(document) });
      expect(() => readPiSwitchConfig(fs, `/bad-${index}.json`)).toThrow(
        /reasoning.?profile/i,
      );
    }
  });
});

import { describe, expect, test } from "bun:test";
import { ProviderConfigViews } from "../src/provider-config-views.ts";
import type { CcProvider, PiSwitchConfig } from "../src/types.ts";

const PROVIDER: CcProvider = {
  id: "p1",
  piName: "ps-codex-p1",
  displayName: "provider one",
  appType: "codex",
  api: "openai-responses",
  baseUrl: "https://relay.example/v1",
  apiKey: "key",
  authHeader: true,
  configModels: ["gpt-5"],
  meta: {},
  isCurrentInCc: false,
};

describe("ProviderConfigViews registration model-meta provenance", () => {
  test("reports the highest layer that contributes thinkingLevelMap", () => {
    let config: PiSwitchConfig = {
      defaultModelMeta: { thinkingLevelMap: { low: "default-low" } },
      providerOverrides: {
        p1: {
          modelMeta: { thinkingLevelMap: { medium: "provider-medium" } },
          modelOverrides: {
            "gpt-*": { thinkingLevelMap: { high: "glob-high" } },
            "gpt-5": { thinkingLevelMap: { max: "exact-max" } },
          },
        },
      },
    };
    const views = new ProviderConfigViews(() => config);

    expect(views.registrationModelMetaFor(PROVIDER, "gpt-5")).toEqual({
      userMapScopes: {
        low: "default",
        medium: "provider",
        max: "exact-model",
      },
      userMeta: {
        thinkingLevelMap: {
          low: "default-low",
          medium: "provider-medium",
          max: "exact-max",
        },
      },
    });

    delete config.providerOverrides?.p1?.modelOverrides?.["gpt-5"];
    expect(views.registrationModelMetaFor(PROVIDER, "gpt-5")).toEqual({
      userMapScopes: {
        low: "default",
        medium: "provider",
        high: "model-glob",
      },
      userMeta: {
        thinkingLevelMap: {
          low: "default-low",
          medium: "provider-medium",
          high: "glob-high",
        },
      },
    });

    delete config.providerOverrides?.p1?.modelOverrides;
    expect(views.registrationModelMetaFor(PROVIDER, "gpt-5")).toEqual({
      userMapScopes: {
        low: "default",
        medium: "provider",
      },
      userMeta: {
        thinkingLevelMap: {
          low: "default-low",
          medium: "provider-medium",
        },
      },
    });

    delete config.providerOverrides?.p1?.modelMeta;
    expect(views.registrationModelMetaFor(PROVIDER, "gpt-5")).toEqual({
      userMapScopes: { low: "default" },
      userMeta: { thinkingLevelMap: { low: "default-low" } },
    });

    config = {};
    expect(views.registrationModelMetaFor(PROVIDER, "gpt-5")).toEqual({
      userMeta: undefined,
      userMapScopes: {},
    });
  });
});

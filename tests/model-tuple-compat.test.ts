import { describe, expect, test } from "bun:test";
import {
  parseChatTupleCompat,
  resolveChatTupleCompat,
  tupleCompatForRegistration,
} from "../src/model-tuple-compat.ts";
import { buildProviderConfig } from "../src/register.ts";
import type { CcProvider } from "../src/types.ts";
import {
  readPiSwitchConfig,
  writeChatTupleCompat,
  type FsLike,
} from "../src/settings.ts";
import { resolveProviderOverride } from "../src/provider-override.ts";

function memFs(files: Record<string, string> = {}): FsLike {
  const store = { ...files };
  return {
    existsSync: (path) => Object.prototype.hasOwnProperty.call(store, path),
    readFileSync: (path) => {
      if (!Object.prototype.hasOwnProperty.call(store, path)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return store[path]!;
    },
    writeFileSync: (path, data) => {
      store[path] = String(data);
    },
    renameSync: (from, to) => {
      store[to] = store[from]!;
      delete store[from];
    },
    unlinkSync: (path) => {
      delete store[path];
    },
  };
}

function provider(
  partial: Partial<CcProvider> & Pick<CcProvider, "id"> = { id: "p1" },
): CcProvider {
  return {
    piName: `ps-codex-${partial.id}`,
    displayName: "relay",
    appType: "codex",
    api: "openai-completions",
    baseUrl: "https://relay.example/v1",
    apiKey: "k",
    authHeader: true,
    configModels: ["relay-model"],
    meta: {},
    isCurrentInCc: false,
    ...partial,
  };
}

describe("parseChatTupleCompat", () => {
  test("preserves explicit booleans, enums, and field absence", () => {
    expect(parseChatTupleCompat(undefined)).toBeUndefined();
    expect(
      parseChatTupleCompat({
        api: "openai-completions",
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
        thinkingFormat: "openai",
        requiresReasoningContentOnAssistantMessages: true,
      }),
    ).toEqual({
      api: "openai-completions",
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      thinkingFormat: "openai",
      requiresReasoningContentOnAssistantMessages: true,
    });
    expect(parseChatTupleCompat({ api: "openai-completions" })).toEqual({
      api: "openai-completions",
    });
  });

  test("rejects non-Chat APIs, unknown keys, and bad enums", () => {
    const invalid = [
      null,
      { api: "openai-responses", supportsDeveloperRole: true },
      { api: "openai-completions", maxTokensField: "max_output_tokens" },
      { api: "openai-completions", thinkingFormat: "nope" },
      { api: "openai-completions", supportsDeveloperRole: "yes" },
      { api: "openai-completions", extra: true },
      { supportsDeveloperRole: true },
    ];
    for (const value of invalid) {
      expect(() => parseChatTupleCompat(value)).toThrow();
    }
  });
});

describe("resolveChatTupleCompat", () => {
  test("tuple wins; legacy flat deprecates; conflict throws", () => {
    const resolved = resolveChatTupleCompat({
      modelId: "relay-model",
      providerApi: "openai-completions",
      tuple: {
        api: "openai-completions",
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
      },
    });
    expect(resolved?.fields.supportsDeveloperRole).toMatchObject({
      value: false,
      source: "user-exact-tuple",
      scope: "exact-model",
    });
    expect(resolved?.fields.maxTokensField?.value).toBe("max_tokens");
    expect(tupleCompatForRegistration(resolved)).toEqual({
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
    });

    const legacy = resolveChatTupleCompat({
      modelId: "relay-model",
      providerApi: "openai-completions",
      legacyFlat: { thinkingFormat: "deepseek", supportsDeveloperRole: true },
    });
    expect(legacy?.fields.thinkingFormat).toMatchObject({
      value: "deepseek",
      source: "legacy-flat",
      deprecated: true,
    });
    expect(legacy?.deprecations.length).toBeGreaterThan(0);

    const same = resolveChatTupleCompat({
      modelId: "relay-model",
      providerApi: "openai-completions",
      tuple: { api: "openai-completions", thinkingFormat: "openai" },
      legacyFlat: { thinkingFormat: "openai" },
    });
    expect(same?.fields.thinkingFormat?.source).toBe("user-exact-tuple");
    expect(same?.deprecations).toHaveLength(1);

    expect(() =>
      resolveChatTupleCompat({
        modelId: "relay-model",
        providerApi: "openai-completions",
        tuple: { api: "openai-completions", thinkingFormat: "openai" },
        legacyFlat: { thinkingFormat: "deepseek" },
      }),
    ).toThrow(/conflict/);
  });

  test("official OpenAI keeps developer native without emitting registration override", () => {
    const resolved = resolveChatTupleCompat({
      modelId: "gpt-5",
      providerApi: "openai-completions",
      officialOpenAi: true,
    });
    expect(resolved?.fields.supportsDeveloperRole).toMatchObject({
      value: true,
      source: "official-adapter",
    });
    expect(tupleCompatForRegistration(resolved)).toBeUndefined();
  });

  test("non-Chat APIs do not resolve Chat tuple", () => {
    expect(
      resolveChatTupleCompat({
        modelId: "m",
        providerApi: "anthropic-messages",
      }),
    ).toBeUndefined();
  });
});

describe("settings + registration for Chat tuple compat", () => {
  test("loads exact-model compat and rejects provider/global scope", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        providerOverrides: {
          codex: {
            p1: {
              modelOverrides: {
                "relay-model": {
                  compat: {
                    api: "openai-completions",
                    supportsDeveloperRole: false,
                    supportsReasoningEffort: false,
                    maxTokensField: "max_tokens",
                  },
                },
              },
            },
          },
        },
      }),
    });
    const cfg = readPiSwitchConfig(fs, "/c.json");
    const entry = resolveProviderOverride(cfg.providerOverrides, provider({ id: "p1" }));
    expect(entry?.modelOverrides?.["relay-model"]?.compat).toEqual({
      api: "openai-completions",
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
    });

    expect(() =>
      readPiSwitchConfig(
        memFs({
          "/bad.json": JSON.stringify({
            providerOverrides: {
              p1: {
                compat: {
                  api: "openai-completions",
                  supportsDeveloperRole: false,
                },
              },
            },
          }),
        }),
        "/bad.json",
      ),
    ).toThrow(/modelOverrides/);
  });

  test("writeChatTupleCompat persists and clears only compat", () => {
    const fs = memFs({
      "/c.json": JSON.stringify({
        providerOverrides: {
          codex: {
            p1: {
              modelOverrides: {
                "relay-model": { reasoning: false, maxTokens: 8192 },
              },
            },
          },
        },
      }),
    });
    const p = provider({ id: "p1", appType: "codex" });
    expect(
      writeChatTupleCompat(
        fs,
        "/c.json",
        p,
        "relay-model",
        {
          api: "openai-completions",
          supportsDeveloperRole: false,
          maxTokensField: "max_completion_tokens",
        },
        1,
      ),
    ).toEqual({ ok: true });

    const loaded = resolveProviderOverride(
      readPiSwitchConfig(fs, "/c.json").providerOverrides,
      p,
    );
    expect(loaded?.modelOverrides?.["relay-model"]?.compat?.supportsDeveloperRole).toBe(
      false,
    );
    expect(loaded?.modelOverrides?.["relay-model"]?.reasoning).toBe(false);

    expect(writeChatTupleCompat(fs, "/c.json", p, "relay-model", null, 1)).toEqual({
      ok: true,
    });
    const cleared = resolveProviderOverride(
      readPiSwitchConfig(fs, "/c.json").providerOverrides,
      p,
    );
    expect(cleared?.modelOverrides?.["relay-model"]?.compat).toBeUndefined();
    expect(cleared?.modelOverrides?.["relay-model"]?.reasoning).toBe(false);
  });

  test("registration maps tuple fields into model.compat without leaking to sibling models", () => {
    const p = provider({ id: "p1" });
    const cfg = buildProviderConfig(p, ["relay-model", "other-model"], {
      rules: [],
      modelMeta: { maxTokens: 8192 },
      tupleCompatFor: (id) =>
        id === "relay-model"
          ? {
              tuple: {
                api: "openai-completions",
                supportsDeveloperRole: false,
                supportsReasoningEffort: false,
                maxTokensField: "max_tokens",
                thinkingFormat: "openai",
                requiresReasoningContentOnAssistantMessages: true,
              },
            }
          : undefined,
    });
    const models = cfg?.models as Array<{ id: string; compat?: Record<string, unknown> }>;
    // Provider wire (#62) adds supportsStore=false for unknown Chat relays;
    // exact-model tuple (#64) fields still apply only to the targeted model.
    expect(models[0]?.compat).toEqual({
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "openai",
      requiresReasoningContentOnAssistantMessages: true,
      supportsStore: false,
    });
    expect(models[1]?.compat).toEqual({ supportsStore: false });
    expect(models[1]?.compat).not.toHaveProperty("supportsDeveloperRole");
  });

  test("official OpenAI registration does not downgrade developer role", () => {
    const cfg = buildProviderConfig(
      provider({
        id: "openai",
        baseUrl: "https://api.openai.com/v1",
      }),
      ["gpt-5"],
      { rules: [], modelMeta: { maxTokens: 128000 } },
    );
    expect((cfg?.models as any[])[0].compat?.supportsDeveloperRole).toBeUndefined();
  });
});

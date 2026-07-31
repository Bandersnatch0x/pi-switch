import { test, expect, describe } from "bun:test";
import { parseProviderRow, makePiName, trimModelId, isSwitchable, uniquifyPiNames, MANAGED_AUTH_PARSE_ERROR } from "../src/parse/index.ts";
import { parseGemini } from "../src/parse/gemini.ts";
import { normalizeOpenAiBaseUrlForPi } from "../src/parse/common.ts";
import type { ProviderRow } from "../src/types.ts";

function row(partial: Partial<ProviderRow> & Pick<ProviderRow, "id" | "app_type" | "name" | "settings_config">): ProviderRow {
  return {
    is_current: 0,
    ...partial,
  };
}

describe("makePiName / trimModelId", () => {
  test("piName prefers displayName slug", () => {
    const id = "448d0e64-aaaa-bbbb-cccc-ddddeeeeffff";
    expect(makePiName("elysiver-claude", "claude", id)).toBe("elysiver-claude");
    expect(makePiName("Elysiver Claude", "claude", id)).toBe("elysiver-claude");
  });

  test("piName keeps CJK in slug", () => {
    const id = "448d0e64-aaaa-bbbb-cccc-ddddeeeeffff";
    expect(makePiName("火山Agentplan", "claude", id)).toBe("火山agentplan");
  });

  test("piName falls back to ps-<appType>-<dbId> when name empty", () => {
    const id = "448d0e64-aaaa-bbbb-cccc-ddddeeeeffff";
    expect(makePiName("", "codex", id)).toBe(`ps-codex-${id}`);
    expect(makePiName("   ", "codex", id)).toBe(`ps-codex-${id}`);
  });

  test("uniquifyPiNames suffixes collisions", () => {
    const out = uniquifyPiNames([
      { id: "aaaabbbb", piName: "shared" },
      { id: "ccccdddd", piName: "shared" },
      { id: "eeeeffff", piName: "unique" },
    ]);
    expect(out[0].piName).toBe("shared");
    expect(out[1].piName).toBe("shared-ccccdddd");
    expect(out[2].piName).toBe("unique");
  });

    test("model id only trims", () => {
    expect(trimModelId("  claude-fable-5[1M]  ")).toBe("claude-fable-5[1M]");
    expect(trimModelId("DeepSeek-V4-Pro")).toBe("DeepSeek-V4-Pro");
  });
});

describe("parse claude", () => {
  test("parses env credentials", () => {
    const p = parseProviderRow(
      row({
        id: "c1",
        app_type: "claude",
        name: "100xlabs",
        settings_config: JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "https://sub.100xlabs.space/v1",
            ANTHROPIC_AUTH_TOKEN: "tok",
            ANTHROPIC_MODEL: "claude-fable-5[1M]",
          },
        }),
      }),
    );
    expect(isSwitchable(p)).toBe(true);
    expect(p.api).toBe("anthropic-messages");
    expect(p.authHeader).toBe(true);
    expect(p.configModels).toContain("claude-fable-5[1M]");
    expect(p.piName).toBe("100xlabs");
    expect(p.baseUrl).toBe("https://sub.100xlabs.space/v1");
  });
});

describe("parse codex", () => {
  test("parses TOML wire_api and base_url", () => {
    const toml = `
model = "gpt-5"
model_provider = "custom"
wire_api = "responses"

[model_providers.custom]
base_url = "https://new.sbai.shop/v1"
`;
    const p = parseProviderRow(
      row({
        id: "x1",
        app_type: "codex",
        name: "sbai",
        settings_config: JSON.stringify({
          auth: { OPENAI_API_KEY: "sk-test" },
          config: toml,
        }),
      }),
    );
    expect(isSwitchable(p)).toBe(true);
    expect(p.api).toBe("openai-responses");
    expect(p.baseUrl).toBe("https://new.sbai.shop/v1");
    expect(p.configModels).toContain("gpt-5");
  });
});

describe("parse hermes", () => {
  test("parses models array", () => {
    const p = parseProviderRow(
      row({
        id: "h1",
        app_type: "hermes",
        name: "h",
        settings_config: JSON.stringify({
          base_url: "https://api.example.com",
          api_key: "k",
          api_mode: "anthropic_messages",
          models: [{ id: "m1" }, { id: "m2" }],
        }),
      }),
    );
    expect(isSwitchable(p)).toBe(true);
    expect(p.api).toBe("anthropic-messages");
    expect(p.configModels).toEqual(["m1", "m2"]);
  });
});

describe("unsupported apiFormat", () => {
  test("marks not switchable", () => {
    const p = parseProviderRow(
      row({
        id: "u1",
        app_type: "claude",
        name: "x",
        settings_config: JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "https://x.com",
            ANTHROPIC_API_KEY: "k",
          },
        }),
        meta: JSON.stringify({ apiFormat: "totally-unknown-proto" }),
      }),
    );
    expect(isSwitchable(p)).toBe(false);
    expect(p.parseError).toContain("unsupported apiFormat");
  });
});

describe("opencode agents-only", () => {
  test("missing endpoint stays visible", () => {
    const p = parseProviderRow(
      row({
        id: "o1",
        app_type: "opencode",
        name: "agents",
        settings_config: JSON.stringify({ agents: { foo: {} } }),
      }),
    );
    expect(p.parseError).toBe("missing endpoint");
    expect(isSwitchable(p)).toBe(false);
    expect(p.displayName).toBe("agents");
  });
});

describe("generic unknown type", () => {
  test("still produces a row", () => {
    const p = parseProviderRow(
      row({
        id: "g1",
        app_type: "openclaw",
        name: "claw",
        settings_config: JSON.stringify({
          env: { FOO_BASE_URL: "https://a.com", FOO_API_KEY: "k" },
        }),
      }),
    );
    expect(p.appType).toBe("openclaw");
    expect(isSwitchable(p)).toBe(true);
  });
});

describe("parse gemini authHeader", () => {
  function gemini(baseUrl: string) {
    return parseGemini({
      env: { GOOGLE_GEMINI_BASE_URL: baseUrl, GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-2.5" },
    });
  }

  test("native googleapis host → authHeader false (x-goog-api-key)", () => {
    expect(gemini("https://generativelanguage.googleapis.com").authHeader).toBe(false);
  });

  test("third-party gateway host → authHeader true (Bearer)", () => {
    expect(gemini("https://api.siliconflow.cn").authHeader).toBe(true);
  });

  test("missing baseUrl defaults to Bearer", () => {
    expect(parseGemini({ env: { GEMINI_API_KEY: "k" } }).authHeader).toBe(true);
  });

  test("appends /v1beta when host-only so Pi google client hits the API path", () => {
    expect(gemini("https://elysia.h-e.top").baseUrl).toBe("https://elysia.h-e.top/v1beta");
    expect(gemini("https://generativelanguage.googleapis.com").baseUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
  });

  test("preserves an explicit version segment", () => {
    expect(gemini("https://elysia.h-e.top/v1beta").baseUrl).toBe("https://elysia.h-e.top/v1beta");
    expect(gemini("https://elysia.h-e.top/v1").baseUrl).toBe("https://elysia.h-e.top/v1");
    expect(gemini("https://elysia.h-e.top/v1alpha/").baseUrl).toBe(
      "https://elysia.h-e.top/v1alpha",
    );
  });
});

describe("openai host-only baseUrl → /v1 normalization", () => {
  test("claude + openai_chat host-only → /v1 (regression: ddddddd glm-5.2 404)", () => {
    const p = parseProviderRow(
      row({
        id: "d1",
        app_type: "claude",
        name: "ddddddd",
        settings_config: JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "https://glm.ddddddd.cyou",
            ANTHROPIC_AUTH_TOKEN: "test-token",
            ANTHROPIC_MODEL: "glm-5.2",
          },
        }),
        meta: JSON.stringify({ apiFormat: "openai_chat" }),
      }),
    );
    expect(isSwitchable(p)).toBe(true);
    expect(p.api).toBe("openai-completions");
    expect(p.baseUrl).toBe("https://glm.ddddddd.cyou/v1");
    expect(p.configModels).toContain("glm-5.2");
  });

  test("claude + openai_chat explicit /v1 is preserved", () => {
    const p = parseProviderRow(
      row({
        id: "d2",
        app_type: "claude",
        name: "x",
        settings_config: JSON.stringify({
          env: { ANTHROPIC_BASE_URL: "https://glm.ddddddd.cyou/v1", ANTHROPIC_AUTH_TOKEN: "k", ANTHROPIC_MODEL: "glm-5.2" },
        }),
        meta: JSON.stringify({ apiFormat: "openai_chat" }),
      }),
    );
    expect(p.baseUrl).toBe("https://glm.ddddddd.cyou/v1");
  });

  test("claude + openai_responses host-only then /v1", () => {
    const p = parseProviderRow(
      row({
        id: "d3",
        app_type: "claude",
        name: "x",
        settings_config: JSON.stringify({
          env: { ANTHROPIC_BASE_URL: "https://api.example.com", ANTHROPIC_AUTH_TOKEN: "k" },
        }),
        meta: JSON.stringify({ apiFormat: "openai_responses" }),
      }),
    );
    expect(p.api).toBe("openai-responses");
    expect(p.baseUrl).toBe("https://api.example.com/v1");
  });

  test("claude anthropic-messages host-only stays unchanged (no /v1 injection)", () => {
    const p = parseProviderRow(
      row({
        id: "d4",
        app_type: "claude",
        name: "x",
        settings_config: JSON.stringify({
          env: { ANTHROPIC_BASE_URL: "https://x.example.com", ANTHROPIC_AUTH_TOKEN: "k" },
        }),
      }),
    );
    expect(p.api).toBe("anthropic-messages");
    expect(p.baseUrl).toBe("https://x.example.com");
  });

  test("codex host-only base_url then /v1 (openai-responses default)", () => {
    const toml = 'model = "gpt-5"\nmodel_provider = "custom"\nwire_api = "responses"\n\n[model_providers.custom]\nbase_url = "https://api.example.com"\n';
    const p = parseProviderRow(
      row({
        id: "d5",
        app_type: "codex",
        name: "x",
        settings_config: JSON.stringify({ auth: { OPENAI_API_KEY: "sk-test" }, config: toml }),
      }),
    );
    expect(p.api).toBe("openai-responses");
    expect(p.baseUrl).toBe("https://api.example.com/v1");
  });

  test("hermes host-only base_url then /v1 (responses api_mode)", () => {
    const p = parseProviderRow(
      row({
        id: "d6",
        app_type: "hermes",
        name: "x",
        settings_config: JSON.stringify({
          base_url: "https://api.example.com",
          api_key: "k",
          api_mode: "responses",
          models: [{ id: "m1" }],
        }),
      }),
    );
    expect(p.api).toBe("openai-responses");
    expect(p.baseUrl).toBe("https://api.example.com/v1");
  });

  test("hermes host-only base_url then /v1 (default openai-completions)", () => {
    const p = parseProviderRow(
      row({
        id: "d7",
        app_type: "hermes",
        name: "x",
        settings_config: JSON.stringify({
          base_url: "https://api.example.com",
          api_key: "k",
          models: [{ id: "m1" }],
        }),
      }),
    );
    expect(p.api).toBe("openai-completions");
    expect(p.baseUrl).toBe("https://api.example.com/v1");
  });

  test("generic host-only env BASE_URL then /v1 (default openai-completions)", () => {
    const p = parseProviderRow(
      row({
        id: "d8",
        app_type: "openclaw",
        name: "x",
        settings_config: JSON.stringify({
          env: { FOO_BASE_URL: "https://a.com", FOO_API_KEY: "k" },
        }),
      }),
    );
    expect(p.api).toBe("openai-completions");
    expect(p.baseUrl).toBe("https://a.com/v1");
  });

  test("explicit /v2 version segment is preserved (not forced to /v1)", () => {
    const p = parseProviderRow(
      row({
        id: "d9",
        app_type: "claude",
        name: "x",
        settings_config: JSON.stringify({
          env: { ANTHROPIC_BASE_URL: "https://x.com/v2", ANTHROPIC_AUTH_TOKEN: "k" },
        }),
        meta: JSON.stringify({ apiFormat: "openai_chat" }),
      }),
    );
    expect(p.baseUrl).toBe("https://x.com/v2");
  });

  test("custom path prefix is preserved (never guess /v1 placement)", () => {
    const p = parseProviderRow(
      row({
        id: "d10",
        app_type: "claude",
        name: "x",
        settings_config: JSON.stringify({
          env: { ANTHROPIC_BASE_URL: "https://x.com/custom-prefix", ANTHROPIC_AUTH_TOKEN: "k" },
        }),
        meta: JSON.stringify({ apiFormat: "openai_chat" }),
      }),
    );
    expect(p.baseUrl).toBe("https://x.com/custom-prefix");
  });
});

describe("managed auth (Official/OAuth) entries", () => {
  test("claude Official: empty config object → human-readable reason", () => {
    const p = parseProviderRow(
      row({ id: "o1", app_type: "claude", name: "Claude Official", settings_config: "{}" }),
    );
    expect(isSwitchable(p)).toBe(false);
    expect(p.parseError).toBe(MANAGED_AUTH_PARSE_ERROR);
  });

  test("gemini Official: nested empty objects → managed", () => {
    const p = parseProviderRow(
      row({
        id: "o2",
        app_type: "gemini",
        name: "Google Official",
        settings_config: JSON.stringify({ env: {}, config: {} }),
      }),
    );
    expect(p.parseError).toBe(MANAGED_AUTH_PARSE_ERROR);
  });

  test("codex Official: OAuth tokens without API key → managed", () => {
    const p = parseProviderRow(
      row({
        id: "o3",
        app_type: "codex",
        name: "OpenAI Official",
        settings_config: JSON.stringify({
          auth: {
            auth_mode: "oauth",
            OPENAI_API_KEY: null,
            tokens: { id_token: "x", access_token: "x", refresh_token: "x", account_id: "a" },
            last_refresh: "2026-07-01T00:00:00Z",
          },
          config: 'model = "gpt-5"\n',
        }),
      }),
    );
    expect(p.parseError).toBe(MANAGED_AUTH_PARSE_ERROR);
  });

  test("grokbuild Official: config-only TOML without base_url/api_key → managed", () => {
    const p = parseProviderRow(
      row({
        id: "o4",
        app_type: "grokbuild",
        name: "Grok Official",
        settings_config: JSON.stringify({ config: '# managed by cc-switch\nmodel = "grok-4"\n' }),
      }),
    );
    expect(p.parseError).toBe(MANAGED_AUTH_PARSE_ERROR);
  });

  test("normal misconfig is NOT flagged as managed", () => {
    const p = parseProviderRow(
      row({
        id: "n1",
        app_type: "claude",
        name: "half-configured",
        settings_config: JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "tok" } }),
      }),
    );
    expect(p.parseError).toBe("missing ANTHROPIC_BASE_URL");
  });

  test("codex with both OAuth tokens and a working key stays switchable", () => {
    const toml = `
model_provider = "custom"
wire_api = "responses"

[model_providers.custom]
base_url = "https://api.example.com/v1"
`;
    const p = parseProviderRow(
      row({
        id: "n2",
        app_type: "codex",
        name: "hybrid",
        settings_config: JSON.stringify({
          auth: { OPENAI_API_KEY: "sk-x", tokens: { access_token: "t", refresh_token: "r" } },
          config: toml,
        }),
      }),
    );
    expect(isSwitchable(p)).toBe(true);
    expect(p.parseError).toBeUndefined();
  });

  test("codex with API key + leftover OAuth tokens but broken TOML keeps the real error", () => {
    const p = parseProviderRow(
      row({
        id: "n3",
        app_type: "codex",
        name: "key-with-stale-tokens",
        settings_config: JSON.stringify({
          auth: { OPENAI_API_KEY: "sk-x", tokens: { access_token: "t", refresh_token: "r" } },
          config: 'model = "gpt-5"\n',
        }),
      }),
    );
    expect(isSwitchable(p)).toBe(false);
    expect(p.parseError).not.toBe(MANAGED_AUTH_PARSE_ERROR);
  });

  test("bare {env:{}} shell is classified as managed", () => {
    const p = parseProviderRow(
      row({ id: "o5", app_type: "claude", name: "shell", settings_config: JSON.stringify({ env: {} }) }),
    );
    expect(p.parseError).toBe(MANAGED_AUTH_PARSE_ERROR);
  });
});

describe("grokbuild multi-block ambiguity guard", () => {
  function grok(toml: string) {
    return parseProviderRow(
      row({ id: "g1", app_type: "grokbuild", name: "g", settings_config: JSON.stringify({ config: toml }) }),
    );
  }

  test("distinct base_url across model blocks → parseError, never silently pick first", () => {
    const p = grok(`
[model."a"]
base_url = "https://a.example.com"
api_key = "k1"

[model."b"]
base_url = "https://b.example.com"
api_key = "k1"
`);
    expect(isSwitchable(p)).toBe(false);
    expect(p.parseError).toContain("base_url");
  });

  test("distinct api_key across blocks → parseError", () => {
    const p = grok(`
[model."a"]
base_url = "https://a.example.com"
api_key = "k1"

[model."b"]
base_url = "https://a.example.com"
api_key = "k2"
`);
    expect(isSwitchable(p)).toBe(false);
    expect(p.parseError).toContain("api_key");
  });

  test("same value repeated across blocks is fine", () => {
    const p = grok(`
default = "a"

[model."a"]
base_url = "https://a.example.com/"
api_key = "k1"

[model."b"]
base_url = "https://a.example.com"
api_key = "k1"
`);
    expect(isSwitchable(p)).toBe(true);
    // grokbuild defaults to openai-responses → host-only baseUrl gets /v1 (SPEC §5.11).
    expect(p.baseUrl).toBe("https://a.example.com/v1");
  });
});

describe("normalizeOpenAiBaseUrlForPi", () => {
  test("appends /v1 to host-only URLs", () => {
    expect(normalizeOpenAiBaseUrlForPi("https://glm.example.cyou")).toBe("https://glm.example.cyou/v1");
    expect(normalizeOpenAiBaseUrlForPi("https://glm.example.cyou/")).toBe("https://glm.example.cyou/v1");
  });

  test("preserves explicit version and custom prefixes", () => {
    expect(normalizeOpenAiBaseUrlForPi("https://api.example.com/v1")).toBe("https://api.example.com/v1");
    expect(normalizeOpenAiBaseUrlForPi("https://api.example.com/v2")).toBe("https://api.example.com/v2");
    expect(normalizeOpenAiBaseUrlForPi("https://api.example.com/openai/v1")).toBe("https://api.example.com/openai/v1");
    expect(normalizeOpenAiBaseUrlForPi("https://api.example.com/custom-prefix")).toBe("https://api.example.com/custom-prefix");
  });

  test("empty string stays empty", () => {
    expect(normalizeOpenAiBaseUrlForPi("")).toBe("");
    expect(normalizeOpenAiBaseUrlForPi("   ")).toBe("");
  });

  test("invalid URL preserved as-is (no prefix guessing)", () => {
    expect(normalizeOpenAiBaseUrlForPi("not a url")).toBe("not a url");
    expect(normalizeOpenAiBaseUrlForPi("example.com/v1")).toBe("example.com/v1");
  });

  test("host-only with port gets /v1, port preserved", () => {
    expect(normalizeOpenAiBaseUrlForPi("https://relay.local:8080")).toBe("https://relay.local:8080/v1");
    expect(normalizeOpenAiBaseUrlForPi("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000/v1");
  });

  test("query on host-only URL survives the append", () => {
    expect(normalizeOpenAiBaseUrlForPi("https://relay.example.com?team=a")).toBe("https://relay.example.com/v1?team=a");
  });
});

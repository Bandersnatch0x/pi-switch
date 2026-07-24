import { test, expect, describe } from "bun:test";
import { parseProviderRow, makePiName, trimModelId, isSwitchable } from "../src/parse/index.ts";
import type { ProviderRow } from "../src/types.ts";

function row(partial: Partial<ProviderRow> & Pick<ProviderRow, "id" | "app_type" | "name" | "settings_config">): ProviderRow {
  return {
    is_current: 0,
    ...partial,
  };
}

describe("makePiName / trimModelId", () => {
  test("piName uses full dbId", () => {
    const id = "448d0e64-aaaa-bbbb-cccc-ddddeeeeffff";
    expect(makePiName("codex", id)).toBe(`ps-codex-${id}`);
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
    expect(p.piName).toBe("ps-claude-c1");
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

import {
  describe,
  expect,
  test,
} from "bun:test";
import {
  applyGeminiToolCompatToPayload,
  emptyToolCallReason,
  hasEmptyToolCallArgs,
  isGeminiPayload,
  isOfficialGoogleBaseUrl,
  parseGeminiToolCompatConfig,
  sanitizeForOpenApi,
  shouldApplyGeminiToolCompat,
} from "../src/compat/gemini-tool-compat.ts";

// ─── isGeminiPayload ────────────────────────────────────────────────────

describe("isGeminiPayload", () => {
  test("true for Gemini-shaped payload", () => {
    expect(isGeminiPayload({ model: "x", contents: [], config: {} })).toBe(true);
  });
  test("false for anthropic payload", () => {
    expect(isGeminiPayload({ model: "x", messages: [], system: "" })).toBe(false);
  });
  test("false for openai payload", () => {
    expect(isGeminiPayload({ model: "x", messages: [], tools: [] })).toBe(false);
  });
  test("false for null/undefined", () => {
    expect(isGeminiPayload(null)).toBe(false);
    expect(isGeminiPayload(undefined)).toBe(false);
  });
});

// ─── sanitizeForOpenApi ─────────────────────────────────────────────────

describe("sanitizeForOpenApi", () => {
  test("strips $schema and $defs", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: { Foo: {} },
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    };
    const result = sanitizeForOpenApi(schema) as Record<string, unknown>;
    expect("$schema" in result).toBe(false);
    expect("$defs" in result).toBe(false);
    expect(result.type).toBe("object");
    expect(result.required).toEqual(["a"]);
  });
  test("preserves nested properties", () => {
    const schema = {
      type: "object",
      properties: {
        nested: {
          $schema: "x",
          $id: "y",
          type: "string",
        },
      },
    };
    const result = sanitizeForOpenApi(schema) as Record<string, unknown>;
    const nested = (result.properties as Record<string, unknown>).nested as Record<string, unknown>;
    expect("$schema" in nested).toBe(false);
    expect("$id" in nested).toBe(false);
    expect(nested.type).toBe("string");
  });
  test("passes through non-objects", () => {
    expect(sanitizeForOpenApi("string")).toBe("string");
    expect(sanitizeForOpenApi(42)).toBe(42);
    expect(sanitizeForOpenApi(null)).toBe(null);
  });
});

// ─── applyGeminiToolCompatToPayload ─────────────────────────────────────

describe("applyGeminiToolCompatToPayload", () => {
  const geminiPayload = {
    model: "gemini-2.0-flash",
    contents: [],
    config: {
      tools: [
        {
          functionDeclarations: [
            {
              name: "read",
              description: "Read a file",
              parametersJsonSchema: {
                $schema: "https://json-schema.org/draft/2020-12/schema",
                $defs: { Foo: {} },
                type: "object",
                properties: {
                  file_path: { type: "string" },
                },
                required: ["file_path"],
              },
            },
          ],
        },
      ],
    },
  };

  function injectedMode(result: unknown): unknown {
    const config = (result as Record<string, unknown>).config as Record<string, unknown>;
    const toolConfig = config.toolConfig as Record<string, unknown>;
    const fcConfig = toolConfig.functionCallingConfig as Record<string, unknown>;
    return fcConfig.mode;
  }

  test("injects AUTO toolConfig when missing", () => {
    expect(injectedMode(applyGeminiToolCompatToPayload(geminiPayload))).toBe("AUTO");
  });

  test("defaults to AUTO for Gemini 3+ too (VALIDATED unreliable through proxies)", () => {
    const payload = { ...geminiPayload, model: "gemini-3.5-flash" };
    expect(injectedMode(applyGeminiToolCompatToPayload(payload))).toBe("AUTO");
  });

  test("forceToolConfigMode VALIDATED is honored", () => {
    const result = applyGeminiToolCompatToPayload(geminiPayload, {
      forceToolConfigMode: "VALIDATED",
    });
    expect(injectedMode(result)).toBe("VALIDATED");
  });

  test("converts parametersJsonSchema to parameters", () => {
    const result = applyGeminiToolCompatToPayload(geminiPayload) as Record<string, unknown>;
    const config = result.config as Record<string, unknown>;
    const tools = config.tools as Array<Record<string, unknown>>;
    const fd = tools[0].functionDeclarations as Array<Record<string, unknown>>;
    expect("parameters" in fd[0]).toBe(true);
    expect("parametersJsonSchema" in fd[0]).toBe(false);
    const params = fd[0].parameters as Record<string, unknown>;
    expect("$schema" in params).toBe(false);
    expect("$defs" in params).toBe(false);
    expect(params.type).toBe("object");
    expect(params.required).toEqual(["file_path"]);
  });

  test("does not double-convert if parameters already exists", () => {
    const payload = {
      model: "gemini-2.0-flash",
      contents: [],
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: "read",
                description: "Read",
                parameters: { type: "object", properties: {}, required: [] },
                parametersJsonSchema: { type: "object", properties: {}, required: [] },
              },
            ],
          },
        ],
      },
    };
    const result = applyGeminiToolCompatToPayload(payload) as Record<string, unknown>;
    const config = result.config as Record<string, unknown>;
    const tools = config.tools as Array<Record<string, unknown>>;
    const fd = tools[0].functionDeclarations as Array<Record<string, unknown>>;
    // parameters already exists → don't overwrite it, but parametersJsonSchema still gets deleted
    expect("parameters" in fd[0]).toBe(true);
    expect("parametersJsonSchema" in fd[0]).toBe(false);
  });

  test("skips conversion when convertSchema=false", () => {
    const result = applyGeminiToolCompatToPayload(geminiPayload, { convertSchema: false }) as Record<string, unknown>;
    const config = result.config as Record<string, unknown>;
    const tools = config.tools as Array<Record<string, unknown>>;
    const fd = tools[0].functionDeclarations as Array<Record<string, unknown>>;
    expect("parametersJsonSchema" in fd[0]).toBe(true);
    expect("parameters" in fd[0]).toBe(false);
  });

  test("respects existing toolConfig", () => {
    const payload = {
      ...geminiPayload,
      config: {
        ...geminiPayload.config,
        toolConfig: { functionCallingConfig: { mode: "NONE" } },
      },
    };
    expect(injectedMode(applyGeminiToolCompatToPayload(payload))).toBe("NONE"); // not overwritten
  });

  test("tolerates malformed tools entries without throwing", () => {
    const payload = {
      model: "gemini-2.0-flash",
      contents: [],
      config: {
        tools: [
          null,
          "not-an-object",
          {},
          { functionDeclarations: "not-an-array" },
          { functionDeclarations: [null, 42, { name: "ok", parametersJsonSchema: { type: "object" } }] },
        ],
      },
    };
    const result = applyGeminiToolCompatToPayload(payload) as Record<string, unknown>;
    const config = result.config as Record<string, unknown>;
    expect(config.toolConfig).toBeDefined();
    const tools = config.tools as Array<unknown>;
    const lastFd = (tools[4] as Record<string, unknown>).functionDeclarations as Array<unknown>;
    const decl = lastFd[2] as Record<string, unknown>;
    expect("parameters" in decl).toBe(true);
    expect("parametersJsonSchema" in decl).toBe(false);
  });

  test("returns original payload if not Gemini", () => {
    const anthropic = { model: "claude-3", messages: [], system: "" };
    const result = applyGeminiToolCompatToPayload(anthropic);
    expect(result).toBe(anthropic);
  });

  test("returns original payload if no tools", () => {
    const payload = { model: "gemini-2.0-flash", contents: [], config: {} };
    const result = applyGeminiToolCompatToPayload(payload);
    expect(result).toBe(payload);
  });
});

// ─── hasEmptyToolCallArgs ────────────────────────────────────────────────

describe("hasEmptyToolCallArgs", () => {
  test("true for empty object on read", () => {
    expect(hasEmptyToolCallArgs({}, "read")).toBe(true);
  });
  test("true for null on read", () => {
    expect(hasEmptyToolCallArgs(null, "read")).toBe(true);
  });
  test("true for undefined on bash", () => {
    expect(hasEmptyToolCallArgs(undefined, "bash")).toBe(true);
  });
  test("false for non-empty on read", () => {
    expect(hasEmptyToolCallArgs({ file_path: "/foo" }, "read")).toBe(false);
  });
  test("true for all-empty-value object on read", () => {
    expect(hasEmptyToolCallArgs({ file_path: "" }, "read")).toBe(true);
  });
  test("false when optional param present but required missing (pi-ai validation covers it)", () => {
    // Documented scope limit: the guard only catches fully-empty calls.
    expect(hasEmptyToolCallArgs({ limit: 100 }, "read")).toBe(false);
  });
  test("false for unknown tool", () => {
    expect(hasEmptyToolCallArgs({}, "custom_tool")).toBe(false);
  });
  test("false for ls (no required params)", () => {
    expect(hasEmptyToolCallArgs({}, "ls")).toBe(false);
  });
});

// ─── emptyToolCallReason ─────────────────────────────────────────────────

describe("emptyToolCallReason", () => {
  test("includes tool name", () => {
    const reason = emptyToolCallReason("read");
    expect(reason).toContain("read");
    expect(reason).toContain("empty or missing");
  });
});

// ─── isOfficialGoogleBaseUrl ─────────────────────────────────────────────

describe("isOfficialGoogleBaseUrl", () => {
  test("true for official endpoints", () => {
    expect(isOfficialGoogleBaseUrl("https://generativelanguage.googleapis.com")).toBe(true);
    expect(isOfficialGoogleBaseUrl("https://generativelanguage.googleapis.com/v1beta")).toBe(true);
    expect(isOfficialGoogleBaseUrl("https://googleapis.com")).toBe(true);
  });
  test("true for empty/null (pi falls back to the official default)", () => {
    expect(isOfficialGoogleBaseUrl(null)).toBe(true);
    expect(isOfficialGoogleBaseUrl(undefined)).toBe(true);
    expect(isOfficialGoogleBaseUrl("")).toBe(true);
    expect(isOfficialGoogleBaseUrl("   ")).toBe(true);
  });
  test("false for proxies", () => {
    expect(isOfficialGoogleBaseUrl("https://elysia.h-e.top/v1beta")).toBe(false);
    expect(isOfficialGoogleBaseUrl("https://api.siliconflow.cn")).toBe(false);
  });
  test("false for lookalike hosts", () => {
    expect(isOfficialGoogleBaseUrl("https://googleapis.com.evil.net")).toBe(false);
    expect(isOfficialGoogleBaseUrl("https://notgoogleapis.com")).toBe(false);
  });
  test("false for unparseable URLs (fail-open toward applying compat)", () => {
    expect(isOfficialGoogleBaseUrl("not a url")).toBe(false);
  });
});

// ─── shouldApplyGeminiToolCompat ────────────────────────────────────────

describe("shouldApplyGeminiToolCompat", () => {
  test("auto mode + Gemini API + proxy baseUrl → true", () => {
    expect(shouldApplyGeminiToolCompat({ api: "google-generative-ai", baseUrl: "https://elysia.h-e.top/v1beta" })).toBe(true);
  });
  test("auto mode + official googleapis baseUrl → false (no fix needed there)", () => {
    expect(
      shouldApplyGeminiToolCompat({
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      }),
    ).toBe(false);
  });
  test("auto mode + null baseUrl → false (pi uses the official default endpoint)", () => {
    expect(shouldApplyGeminiToolCompat({ api: "google-generative-ai", baseUrl: null })).toBe(false);
  });
  test("auto mode + non-Gemini API → false", () => {
    expect(shouldApplyGeminiToolCompat({ api: "anthropic-messages", baseUrl: "https://x.com" })).toBe(false);
  });
  test("never mode → false", () => {
    expect(shouldApplyGeminiToolCompat({ mode: "never", api: "google-generative-ai", baseUrl: "https://x.com" })).toBe(false);
  });
  test("providerForce=true overrides mode never for Gemini API", () => {
    expect(shouldApplyGeminiToolCompat({ mode: "never", api: "google-generative-ai", baseUrl: null, providerForce: true })).toBe(true);
  });
  test("providerForce=true on non-Gemini API is a no-op", () => {
    expect(
      shouldApplyGeminiToolCompat({
        mode: "never",
        api: "anthropic-messages",
        baseUrl: "https://x.com",
        providerForce: true,
      }),
    ).toBe(false);
  });
  test("providerForce=true with null api is a no-op", () => {
    expect(
      shouldApplyGeminiToolCompat({
        api: null,
        baseUrl: "https://x.com",
        providerForce: true,
      }),
    ).toBe(false);
  });
  test("providerForce=false overrides everything", () => {
    expect(shouldApplyGeminiToolCompat({ api: "google-generative-ai", baseUrl: "https://x.com", providerForce: false })).toBe(false);
  });
  test("auto mode hosts filter: exact hostname matches", () => {
    expect(
      shouldApplyGeminiToolCompat({
        api: "google-generative-ai",
        baseUrl: "https://elysia.h-e.top/v1beta",
        hosts: ["elysia.h-e.top"],
      }),
    ).toBe(true);
  });
  test("auto mode hosts filter: parent domain matches", () => {
    expect(
      shouldApplyGeminiToolCompat({
        api: "google-generative-ai",
        baseUrl: "https://elysia.h-e.top/v1beta",
        hosts: ["h-e.top"],
      }),
    ).toBe(true);
  });
  test("auto mode hosts filter: substring no longer matches (hostMatches semantics)", () => {
    expect(
      shouldApplyGeminiToolCompat({
        api: "google-generative-ai",
        baseUrl: "https://elysia.h-e.top/v1beta",
        hosts: ["elysia"],
      }),
    ).toBe(false);
  });
  test("auto mode hosts filter: lookalike suffix does not match", () => {
    expect(
      shouldApplyGeminiToolCompat({
        api: "google-generative-ai",
        baseUrl: "https://google.com.evil.net",
        hosts: ["google.com"],
      }),
    ).toBe(false);
  });
  test("auto mode hosts filter: non-listed proxy → false (hosts is an allowlist)", () => {
    expect(
      shouldApplyGeminiToolCompat({
        api: "google-generative-ai",
        baseUrl: "https://other-proxy.example.com",
        hosts: ["elysia.h-e.top"],
      }),
    ).toBe(false);
  });
  test("always mode ignores hosts filter and official-host check", () => {
    expect(
      shouldApplyGeminiToolCompat({
        mode: "always",
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com",
        hosts: ["elysia.h-e.top"],
      }),
    ).toBe(true);
  });
  test("always mode still requires Gemini API", () => {
    expect(
      shouldApplyGeminiToolCompat({
        mode: "always",
        api: "anthropic-messages",
        baseUrl: "https://x.com",
      }),
    ).toBe(false);
  });
  test("null api → false", () => {
    expect(shouldApplyGeminiToolCompat({ api: null, baseUrl: "https://x.com" })).toBe(false);
  });
});

// ─── parseGeminiToolCompatConfig ─────────────────────────────────────────

describe("parseGeminiToolCompatConfig", () => {
  test("parses full config", () => {
    const c = parseGeminiToolCompatConfig({
      mode: "always",
      hosts: ["elysia", "", "  ", "h-e.top"],
      forceToolConfigMode: "VALIDATED",
      blockEmptyToolCalls: false,
      convertSchema: false,
    });
    expect(c).toEqual({
      mode: "always",
      hosts: ["elysia", "h-e.top"],
      forceToolConfigMode: "VALIDATED",
      blockEmptyToolCalls: false,
      convertSchema: false,
    });
  });
  test("returns undefined for non-object", () => {
    expect(parseGeminiToolCompatConfig(null)).toBeUndefined();
    expect(parseGeminiToolCompatConfig("x")).toBeUndefined();
    expect(parseGeminiToolCompatConfig([])).toBeUndefined();
  });
  test("drops invalid enums", () => {
    const c = parseGeminiToolCompatConfig({
      mode: "sometimes",
      forceToolConfigMode: "STRICT",
      hosts: [1, "ok"],
    });
    expect(c?.mode).toBeUndefined();
    expect(c?.forceToolConfigMode).toBeUndefined();
    expect(c?.hosts).toEqual(["ok"]);
  });
  test("empty hosts array becomes undefined", () => {
    const c = parseGeminiToolCompatConfig({ hosts: [] });
    expect(c?.hosts).toBeUndefined();
  });
});

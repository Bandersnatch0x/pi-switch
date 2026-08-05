import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installDeveloperRoleCompat } from "../extensions/developer-role-compat.ts";
import {
  applyDeveloperRoleCompatToPayload,
  type DeveloperRoleCompatModel,
  normalizeDeveloperRoleItems,
  resolveDeveloperRoleCompatApi,
} from "../src/compat/developer-role-compat.ts";
import type { Runtime } from "../extensions/runtime.ts";

describe("resolveDeveloperRoleCompatApi", () => {
  test("resolves OpenAI APIs for providers registered by pi-switch", () => {
    expect(
      resolveDeveloperRoleCompatApi(
        { api: "openai-completions", provider: "ps-relay" },
        ["ps-relay"],
      ),
    ).toBe("openai-completions");
    expect(
      resolveDeveloperRoleCompatApi(
        { api: "openai-responses", provider: "ps-relay" },
        ["ps-relay"],
      ),
    ).toBe("openai-responses");
  });

  test("does not affect providers outside pi-switch", () => {
    expect(
      resolveDeveloperRoleCompatApi(
        { api: "openai-responses", provider: "openai" },
        ["ps-relay"],
      ),
    ).toBeUndefined();
  });

  test("preserves developer role when the model explicitly supports it", () => {
    expect(
      resolveDeveloperRoleCompatApi(
        {
          api: "openai-responses",
          provider: "ps-relay",
          compat: { supportsDeveloperRole: true },
        },
        ["ps-relay"],
      ),
    ).toBeUndefined();
  });

  test("rejects non-OpenAI APIs and missing models", () => {
    expect(
      resolveDeveloperRoleCompatApi(
        { api: "anthropic-messages", provider: "ps-relay" },
        ["ps-relay"],
      ),
    ).toBeUndefined();
    expect(
      resolveDeveloperRoleCompatApi(
        { api: "google-generative-ai", provider: "ps-relay" },
        ["ps-relay"],
      ),
    ).toBeUndefined();
    expect(resolveDeveloperRoleCompatApi(undefined, ["ps-relay"])).toBeUndefined();
  });
});

describe("normalizeDeveloperRoleItems", () => {
  test("converts developer to system without mutating input", () => {
    const messages = [
      { role: "developer" as const, content: "You are helpful." },
      { role: "user" as const, content: "Hi" },
    ];

    expect(normalizeDeveloperRoleItems(messages)).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ]);
    expect(messages[0].role).toBe("developer");
  });

  test("returns the original array when no role changes", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "Q" },
      { role: "assistant", content: "A" },
      { role: "tool", content: "result", tool_call_id: "1" },
    ];

    expect(normalizeDeveloperRoleItems(messages)).toBe(messages);
  });

  test("handles empty arrays and skips non-object entries", () => {
    const empty: unknown[] = [];
    expect(normalizeDeveloperRoleItems(empty)).toBe(empty);
    expect(
      normalizeDeveloperRoleItems([null, { role: "developer", content: "dev" }]),
    ).toEqual([null, { role: "system", content: "dev" }]);
  });
});

describe("applyDeveloperRoleCompatToPayload", () => {
  test("converts developer in Chat Completions messages", () => {
    const payload = {
      model: "deepseek-v4-flash",
      messages: [
        { role: "developer", content: "You are helpful." },
        { role: "user", content: "Hi" },
      ],
    };

    expect(applyDeveloperRoleCompatToPayload(payload, "openai-completions")).toEqual({
      ...payload,
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
      ],
    });
    expect(payload.messages[0].role).toBe("developer");
  });

  test("converts developer in Responses input", () => {
    const payload = {
      model: "gpt-5",
      input: [
        { role: "developer", content: "You are helpful." },
        { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
        { role: "user", content: [{ type: "input_text", text: "Hi" }] },
      ],
    };

    expect(applyDeveloperRoleCompatToPayload(payload, "openai-responses")).toEqual({
      ...payload,
      input: [
        { role: "system", content: "You are helpful." },
        { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
        { role: "user", content: [{ type: "input_text", text: "Hi" }] },
      ],
    });
    expect(payload.input[0].role).toBe("developer");
  });

  test("only rewrites the role array selected by the API", () => {
    const payload = {
      messages: [{ role: "developer", content: "chat" }],
      input: [{ role: "developer", content: "responses" }],
    };

    expect(applyDeveloperRoleCompatToPayload(payload, "openai-responses")).toEqual({
      messages: [{ role: "developer", content: "chat" }],
      input: [{ role: "system", content: "responses" }],
    });
  });

  test("returns the original value when no rewrite is needed", () => {
    const payload = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "Hi" },
      ],
    };

    expect(applyDeveloperRoleCompatToPayload(payload, "openai-completions")).toBe(payload);
    expect(applyDeveloperRoleCompatToPayload(null, "openai-completions")).toBeNull();
    expect(applyDeveloperRoleCompatToPayload("string", "openai-responses")).toBe("string");
  });
});

type HookContext = { model: DeveloperRoleCompatModel | undefined };
type HookHandler = (event: { payload: unknown }, context: HookContext) => unknown;

function captureHook(registeredProviderNames = ["ps-relay"]): HookHandler {
  let handler: HookHandler | undefined;
  const pi = {
    on: (event: string, registered: unknown) => {
      if (event === "before_provider_request") handler = registered as HookHandler;
    },
  } as unknown as ExtensionAPI;
  const rt = {
    registeredPsNames: registeredProviderNames,
    config: { debug: false },
  } as Runtime;

  installDeveloperRoleCompat(pi, rt);
  if (!handler) throw new Error("before_provider_request hook was not registered");
  return handler;
}

describe("installDeveloperRoleCompat", () => {
  const payload = {
    model: "gpt-5",
    input: [{ role: "developer", content: "system prompt" }],
  };

  test("converts requests for a registered pi-switch provider", () => {
    const handler = captureHook();
    expect(
      handler(
        { payload },
        { model: { api: "openai-responses", provider: "ps-relay" } },
      ),
    ).toEqual({
      model: "gpt-5",
      input: [{ role: "system", content: "system prompt" }],
    });
  });

  test("leaves official OpenAI and explicit developer-role support unchanged", () => {
    const handler = captureHook();
    expect(
      handler(
        { payload },
        { model: { api: "openai-responses", provider: "openai" } },
      ),
    ).toBe(payload);
    expect(
      handler(
        { payload },
        {
          model: {
            api: "openai-responses",
            provider: "ps-relay",
            compat: { supportsDeveloperRole: true },
          },
        },
      ),
    ).toBe(payload);
  });

  test("leaves Anthropic and Gemini payloads unchanged without shape guessing", () => {
    const handler = captureHook();
    const anthropic = {
      messages: [{ role: "developer", content: "not an OpenAI request" }],
      max_tokens: 1024,
    };
    const gemini = { contents: [], config: {} };

    expect(
      handler(
        { payload: anthropic },
        { model: { api: "anthropic-messages", provider: "ps-relay" } },
      ),
    ).toBe(anthropic);
    expect(
      handler(
        { payload: gemini },
        { model: { api: "google-generative-ai", provider: "ps-relay" } },
      ),
    ).toBe(gemini);
  });
});

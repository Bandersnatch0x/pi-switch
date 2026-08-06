import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createProbeTransport } from "../extensions/probe-commands.ts";
import type { ProbeRequest } from "../src/probe/index.ts";
import { resolveProviderWireCompat } from "../src/provider-wire-compat.ts";
import { buildProviderConfig } from "../src/register.ts";
import type { CcProvider } from "../src/types.ts";
import {
  createStrictRelay,
  type StrictRelayProfile,
  type StrictRelayProtocol,
} from "./helpers/strict-relay.ts";

const PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const satisfies readonly StrictRelayProtocol[];

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const OFFICIAL_PROFILES = {
  "openai-completions": {
    name: "openai-chat-official-capable",
    allowedFields: [
      "model",
      "messages",
      "stream",
      "stream_options",
      "store",
      "max_completion_tokens",
      "tools",
      "reasoning_effort",
    ],
    requiredFields: ["model", "messages", "stream"],
  },
  "openai-responses": {
    name: "openai-responses-official-capable",
    allowedFields: [
      "model",
      "input",
      "stream",
      "store",
      "max_output_tokens",
      "tools",
      "reasoning",
      "include",
    ],
    requiredFields: ["model", "input", "stream"],
  },
  "anthropic-messages": {
    name: "anthropic-messages-official-capable",
    allowedFields: [
      "model",
      "messages",
      "max_tokens",
      "stream",
      "system",
      "tools",
      "thinking",
    ],
    requiredFields: ["model", "messages", "max_tokens", "stream"],
  },
  "google-generative-ai": {
    name: "gemini-generate-content-official-capable",
    allowedFields: [
      "contents",
      "systemInstruction",
      "tools",
      "toolConfig",
      "generationConfig",
    ],
    requiredFields: ["contents"],
  },
} as const satisfies Record<StrictRelayProtocol, StrictRelayProfile>;

const FORBIDDEN_FIELDS = {
  "openai-completions": "store",
  "openai-responses": "store",
  "anthropic-messages": "thinking",
  "google-generative-ai": "generationConfig.thinkingConfig",
} as const satisfies Record<StrictRelayProtocol, string>;

const EXPECTED_PATHS = {
  "openai-completions": "/v1/chat/completions",
  "openai-responses": "/v1/responses",
  "anthropic-messages": "/v1/messages",
  "google-generative-ai": "/models/relay-model:streamGenerateContent",
} as const satisfies Record<StrictRelayProtocol, string>;

const EXPECTED_BODIES = {
  "openai-completions": {
    model: "relay-model",
    messages: [
      { role: "system", content: "probe system" },
      { role: "user", content: "probe request" },
    ],
    stream: true,
    stream_options: { include_usage: true },
    store: false,
    max_completion_tokens: 32,
    tools: [
      {
        type: "function",
        function: {
          name: "probe_echo",
          description: "Echo probe",
          parameters: {
            type: "object",
            properties: { msg: { type: "string" } },
            required: ["msg"],
          },
          strict: false,
        },
      },
    ],
    reasoning_effort: "low",
  },
  "openai-responses": {
    model: "relay-model",
    input: [
      { role: "developer", content: "probe system" },
      {
        role: "user",
        content: [{ type: "input_text", text: "probe request" }],
      },
    ],
    stream: true,
    store: false,
    max_output_tokens: 32,
    tools: [
      {
        type: "function",
        name: "probe_echo",
        description: "Echo probe",
        parameters: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        },
        strict: false,
      },
    ],
    reasoning: { effort: "low", summary: "auto" },
    include: ["reasoning.encrypted_content"],
  },
  "anthropic-messages": {
    model: "relay-model",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "probe request",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
    max_tokens: 2048,
    stream: true,
    system: [
      {
        type: "text",
        text: "probe system",
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [
      {
        name: "probe_echo",
        description: "Echo probe",
        eager_input_streaming: true,
        input_schema: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        },
        cache_control: { type: "ephemeral" },
      },
    ],
    thinking: {
      type: "enabled",
      budget_tokens: 1024,
      display: "summarized",
    },
  },
  "google-generative-ai": {
    contents: [{ parts: [{ text: "probe request" }], role: "user" }],
    systemInstruction: {
      parts: [{ text: "probe system" }],
      role: "user",
    },
    tools: [
      {
        functionDeclarations: [
          {
            name: "probe_echo",
            description: "Echo probe",
            parametersJsonSchema: {
              type: "object",
              properties: { msg: { type: "string" } },
              required: ["msg"],
            },
          },
        ],
      },
    ],
    generationConfig: {
      maxOutputTokens: 32,
      thinkingConfig: { includeThoughts: true, thinkingBudget: -1 },
    },
  },
} as const satisfies Record<StrictRelayProtocol, Record<string, unknown>>;

function modelFor(
  protocol: StrictRelayProtocol,
  baseUrl: string,
): Model<Api> {
  const common = {
    id: "relay-model",
    name: "Relay model",
    baseUrl,
    reasoning: true,
    input: ["text"] as Array<"text" | "image">,
    cost: ZERO_COST,
    contextWindow: 8192,
    maxTokens: 2048,
  };

  switch (protocol) {
    case "openai-completions":
      return {
        ...common,
        api: protocol,
        provider: "openai",
        compat: {
          supportsStore: true,
          supportsUsageInStreaming: true,
          supportsStrictMode: true,
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          maxTokensField: "max_completion_tokens",
        },
      };
    case "openai-responses":
      return { ...common, api: protocol, provider: "openai" };
    case "anthropic-messages":
      return { ...common, api: protocol, provider: "anthropic" };
    case "google-generative-ai":
      return { ...common, api: protocol, provider: "google" };
  }
}

function makeRequest(
  model: Model<Api>,
  target: ProbeRequest["target"] = {
    provider: `ps-${model.provider}`,
    modelId: model.id,
    reasoning: true,
  },
): ProbeRequest {
  return {
    contract: "reasoning",
    target,
    model,
    context: {
      systemPrompt: "probe system",
      messages: [
        { role: "user", content: "probe request", timestamp: 1 },
      ],
      tools: [
        {
          name: "probe_echo",
          description: "Echo probe",
          parameters: {
            type: "object",
            properties: { msg: { type: "string" } },
            required: ["msg"],
          },
        },
      ],
    },
    options: {
      maxTokens: 32,
      reasoning: "low",
      signal: new AbortController().signal,
    },
  };
}

function transport(geminiMode?: "AUTO") {
  return createProbeTransport({
    resolveAuth: async () => ({ ok: true, apiKey: "test-key" }),
    ...(geminiMode
      ? { geminiCompat: { forceToolConfigMode: geminiMode } }
      : {}),
  });
}

function registeredChatModel(
  baseUrl: string,
  supportsStore?: boolean,
  options?: { resolveDefault?: boolean },
): Model<Api> {
  const provider: CcProvider = {
    id: "chat-relay",
    piName: "ps-codex-chat-relay",
    displayName: "Chat relay",
    appType: "codex",
    api: "openai-completions",
    baseUrl,
    apiKey: "test-key",
    authHeader: true,
    configModels: ["relay-model"],
    meta: {},
    isCurrentInCc: false,
  };
  const providerWireCompat =
    typeof supportsStore === "boolean"
      ? resolveProviderWireCompat({
          provider,
          override: { api: "openai-completions", supportsStore },
        })
      : options?.resolveDefault
        ? resolveProviderWireCompat({ provider })
        : undefined;
  const config = buildProviderConfig(provider, ["relay-model"], {
    rules: [],
    // Issue #63: wire characterization needs a trusted maxTokens so the model registers.
    modelMeta: { maxTokens: 64_000 },
    providerWireCompat,
  });
  const model = config?.models[0];
  if (!config || !model) throw new Error("failed to build registered Chat model");
  return {
    ...model,
    api: config.api,
    provider: provider.piName,
    baseUrl: config.baseUrl,
  };
}

function expectedRegisteredChatBody(supportsStore: boolean): Record<string, unknown> {
  const body = structuredClone(
    EXPECTED_BODIES["openai-completions"],
  ) as Record<string, unknown>;
  delete body.store;
  delete body.reasoning_effort;
  if (supportsStore) body.store = false;
  return body;
}

describe("strict relay profile validation", () => {
  test("returns field-level 400 for disallowed, missing, and nested forbidden fields", async () => {
    const cases: Array<{
      profile: StrictRelayProfile;
      body: Record<string, unknown>;
      field: string;
      rule: "not_allowed" | "required" | "forbidden";
    }> = [
      {
        profile: {
          name: "allowed",
          allowedFields: ["model"],
          requiredFields: ["model"],
        },
        body: { model: "relay-model", extra: true },
        field: "extra",
        rule: "not_allowed",
      },
      {
        profile: {
          name: "required",
          allowedFields: ["model"],
          requiredFields: ["model"],
        },
        body: {},
        field: "model",
        rule: "required",
      },
      {
        profile: {
          name: "forbidden-nested",
          allowedFields: ["model", "tools"],
          requiredFields: ["model"],
          forbiddenFields: ["tools[].function.strict"],
        },
        body: {
          model: "relay-model",
          tools: [{ function: { name: "probe_echo", strict: false } }],
        },
        field: "tools[].function.strict",
        rule: "forbidden",
      },
    ];

    for (const entry of cases) {
      const relay = createStrictRelay("openai-completions", entry.profile);
      try {
        const response = await fetch(relay.endpointUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(entry.body),
        });
        const body = (await response.json()) as {
          error: { field: string; rule: string };
        };

        expect(response.status).toBe(400);
        expect(body.error).toMatchObject({
          field: entry.field,
          rule: entry.rule,
        });
      } finally {
        relay.close();
      }
    }
  });
});

describe("Probe Contract request characterization", () => {
  for (const protocol of PROTOCOLS) {
    test(`${protocol} captures an exact official-capable wire body`, async () => {
      const relay = createStrictRelay(protocol, OFFICIAL_PROFILES[protocol]);
      const request = makeRequest(modelFor(protocol, relay.baseUrl));
      const contextBefore = structuredClone(request.context);
      const probeTransport = transport();

      try {
        const first = await probeTransport(request);
        const second = await probeTransport(request);

        expect(first.message).toMatchObject({
          stopReason: "stop",
          content: [{ type: "text", text: "probe_ok" }],
        });
        expect(second.message).toMatchObject({
          stopReason: "stop",
          content: [{ type: "text", text: "probe_ok" }],
        });
        expect(request.context).toEqual(contextBefore);
        expect(relay.rejections).toEqual([]);
        expect(relay.requests).toHaveLength(2);
        expect(relay.requests.map((capture) => capture.pathname)).toEqual([
          EXPECTED_PATHS[protocol],
          EXPECTED_PATHS[protocol],
        ]);
        expect(relay.requests.map((capture) => capture.body)).toEqual([
          EXPECTED_BODIES[protocol],
          EXPECTED_BODIES[protocol],
        ]);
      } finally {
        relay.close();
      }
    });

    test(`${protocol} subset profile exposes its field-level 400 without retry`, async () => {
      const forbiddenField = FORBIDDEN_FIELDS[protocol];
      const relay = createStrictRelay(protocol, {
        ...OFFICIAL_PROFILES[protocol],
        name: `${protocol}-subset`,
        forbiddenFields: [forbiddenField],
      });
      const request = makeRequest(modelFor(protocol, relay.baseUrl));
      const contextBefore = structuredClone(request.context);

      try {
        const result = await transport()(request);

        expect(result.message.stopReason).toBe("error");
        expect(result.message.errorMessage).toContain(forbiddenField);
        expect(request.context).toEqual(contextBefore);
        expect(relay.requests).toHaveLength(1);
        expect(relay.requests[0]?.body).toEqual(EXPECTED_BODIES[protocol]);
        expect(relay.rejections).toEqual([
          { status: 400, field: forbiddenField, rule: "forbidden" },
        ]);
      } finally {
        relay.close();
      }
    });
  }

  test("Gemini compat remains target-scoped and leaves the official Google target unchanged", async () => {
    const relay = createStrictRelay(
      "google-generative-ai",
      OFFICIAL_PROFILES["google-generative-ai"],
    );
    const model = modelFor("google-generative-ai", relay.baseUrl);
    const probeTransport = transport("AUTO");

    try {
      const official = await probeTransport(makeRequest(model));
      const proxy = await probeTransport(
        makeRequest(model, {
          provider: "ps-gemini-proxy",
          modelId: model.id,
          reasoning: true,
          geminiToolCompat: true,
        }),
      );

      expect(official.message.stopReason).toBe("stop");
      expect(proxy.message.stopReason).toBe("stop");
      expect(relay.rejections).toEqual([]);
      expect(relay.requests[0]?.body).toEqual(
        EXPECTED_BODIES["google-generative-ai"],
      );
      expect(relay.requests[1]?.body).toEqual({
        ...EXPECTED_BODIES["google-generative-ai"],
        tools: [
          {
            functionDeclarations: [
              {
                name: "probe_echo",
                description: "Echo probe",
                parameters: {
                  type: "OBJECT",
                  properties: { msg: { type: "STRING" } },
                  required: ["msg"],
                },
              },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: { mode: "AUTO" },
        },
      });
    } finally {
      relay.close();
    }
  });
});

describe("Provider wire compat request characterization", () => {
  test("explicit false and an absent unknown-relay override omit store", async () => {
    for (const supportsStore of [false, undefined] as const) {
      const relay = createStrictRelay(
        "openai-completions",
        OFFICIAL_PROFILES["openai-completions"],
      );
      const request = makeRequest(
        registeredChatModel(relay.baseUrl, supportsStore),
      );
      const contextBefore = structuredClone(request.context);

      try {
        const result = await transport()(request);

        expect(result.message.stopReason).toBe("stop");
        expect(request.context).toEqual(contextBefore);
        expect(relay.requests).toHaveLength(1);
        expect(relay.requests[0]?.body).toEqual(
          expectedRegisteredChatBody(false),
        );
        expect(relay.requests[0]?.body).not.toHaveProperty("store");
        expect(relay.rejections).toEqual([]);
      } finally {
        relay.close();
      }
    }
  });

  test("explicit true emits store:false and exposes one upstream 400 without retry", async () => {
    const relay = createStrictRelay("openai-completions", {
      ...OFFICIAL_PROFILES["openai-completions"],
      name: "chat-relay-without-store",
      forbiddenFields: ["store"],
    });
    const request = makeRequest(registeredChatModel(relay.baseUrl, true));
    const contextBefore = structuredClone(request.context);

    try {
      const result = await transport()(request);

      expect(result.message.stopReason).toBe("error");
      expect(result.message.errorMessage).toContain("store");
      expect(request.context).toEqual(contextBefore);
      expect(relay.requests).toHaveLength(1);
      expect(relay.requests[0]?.body).toEqual(
        expectedRegisteredChatBody(true),
      );
      expect(relay.rejections).toEqual([
        { status: 400, field: "store", rule: "forbidden" },
      ]);
    } finally {
      relay.close();
    }
  });

  test("official OpenAI leaves compat.supportsStore unset and adapter still emits store:false", async () => {
    // Capture body against a local strict relay while resolving as official
    // OpenAI so registration omits supportsStore and pi-ai adapter facts win.
    const relay = createStrictRelay(
      "openai-completions",
      OFFICIAL_PROFILES["openai-completions"],
    );
    const model = registeredChatModel("https://api.openai.com/v1", undefined, {
      resolveDefault: true,
    });
    // Point the live request at the capture relay without changing registration.
    const request = makeRequest({ ...model, baseUrl: relay.baseUrl });
    const contextBefore = structuredClone(request.context);

    try {
      expect((model.compat as { supportsStore?: boolean } | undefined)?.supportsStore).toBeUndefined();

      const result = await transport()(request);

      expect(result.message.stopReason).toBe("stop");
      expect(request.context).toEqual(contextBefore);
      expect(relay.requests).toHaveLength(1);
      // Adapter-native store (not a registration override): body includes store.
      expect(relay.requests[0]?.body).toEqual(expectedRegisteredChatBody(true));
      expect(relay.requests[0]?.body).toHaveProperty("store", false);
      expect(relay.rejections).toEqual([]);
    } finally {
      relay.close();
    }
  });
});

describe("Chat exact-model tuple compat request characterization (#64)", () => {
  test("supportsDeveloperRole=false uses system; true keeps developer", async () => {
    for (const supportsDeveloperRole of [false, true] as const) {
      const relay = createStrictRelay(
        "openai-completions",
        OFFICIAL_PROFILES["openai-completions"],
      );
      const model = modelFor("openai-completions", relay.baseUrl);
      model.compat = {
        ...(model.compat as object),
        supportsDeveloperRole,
        supportsReasoningEffort: true,
        maxTokensField: "max_completion_tokens",
      };
      const request = makeRequest(model);
      try {
        const result = await transport()(request);
        expect(result.message.stopReason).toBe("stop");
        expect(relay.requests).toHaveLength(1);
        const body = relay.requests[0]?.body as {
          messages?: Array<{ role: string }>;
        };
        const systemish = body.messages?.filter(
          (m) => m.role === "system" || m.role === "developer",
        );
        if (supportsDeveloperRole) {
          expect(systemish?.some((m) => m.role === "developer")).toBe(true);
        } else {
          expect(systemish?.every((m) => m.role !== "developer")).toBe(true);
          expect(systemish?.some((m) => m.role === "system")).toBe(true);
        }
      } finally {
        relay.close();
      }
    }
  });

  test("supportsReasoningEffort=false omits reasoning_effort; maxTokensField selects token key", async () => {
    const cases: Array<{
      supportsReasoningEffort: boolean;
      maxTokensField: "max_tokens" | "max_completion_tokens";
    }> = [
      { supportsReasoningEffort: false, maxTokensField: "max_tokens" },
      { supportsReasoningEffort: true, maxTokensField: "max_completion_tokens" },
    ];
    for (const { supportsReasoningEffort, maxTokensField } of cases) {
      const relay = createStrictRelay(
        "openai-completions",
        OFFICIAL_PROFILES["openai-completions"],
      );
      const model = modelFor("openai-completions", relay.baseUrl);
      model.compat = {
        ...(model.compat as object),
        supportsDeveloperRole: false,
        supportsReasoningEffort,
        maxTokensField,
      };
      const request = makeRequest(model);
      try {
        await transport()(request);
        expect(relay.requests).toHaveLength(1);
        const body = relay.requests[0]?.body as Record<string, unknown>;
        if (supportsReasoningEffort) {
          expect(body).toHaveProperty("reasoning_effort");
        } else {
          expect(body).not.toHaveProperty("reasoning_effort");
        }
        if (maxTokensField === "max_tokens") {
          expect(body).toHaveProperty("max_tokens");
          expect(body).not.toHaveProperty("max_completion_tokens");
        } else {
          expect(body).toHaveProperty("max_completion_tokens");
          expect(body).not.toHaveProperty("max_tokens");
        }
      } finally {
        relay.close();
      }
    }
  });
});

function registeredAnthropicModel(
  baseUrl: string,
  override?: {
    supportsEagerToolInputStreaming?: boolean;
    supportsCacheControlOnTools?: boolean;
    supportsLongCacheRetention?: boolean;
  },
): Model<Api> {
  const provider: CcProvider = {
    id: "anthropic-relay",
    piName: "ps-claude-anthropic-relay",
    displayName: "Anthropic relay",
    appType: "claude",
    api: "anthropic-messages",
    baseUrl,
    apiKey: "test-key",
    authHeader: false,
    configModels: ["relay-model"],
    meta: {},
    isCurrentInCc: false,
  };
  const providerWireCompat = resolveProviderWireCompat({
    provider,
    ...(override
      ? {
          override: {
            api: "anthropic-messages" as const,
            ...override,
          },
        }
      : {}),
  });
  const config = buildProviderConfig(provider, ["relay-model"], {
    rules: [],
    // Issue #63: wire characterization needs a trusted maxTokens so the model registers.
    modelMeta: { maxTokens: 64_000 },
    providerWireCompat,
  });
  const model = config?.models[0];
  if (!config || !model) throw new Error("failed to build registered Anthropic model");
  return {
    ...model,
    api: config.api,
    provider: provider.piName,
    baseUrl: config.baseUrl,
  };
}

describe("Anthropic Provider wire compat request characterization (#65)", () => {
  test("unknown relay registers conservative false for all three Anthropic wire fields", () => {
    const model = registeredAnthropicModel("https://relay.example");
    expect(model.compat).toMatchObject({
      supportsEagerToolInputStreaming: false,
      supportsCacheControlOnTools: false,
      supportsLongCacheRetention: false,
    });
    expect((model.compat as Record<string, unknown> | undefined)?.supportsStore).toBeUndefined();
  });

  test("explicit Anthropic wire overrides reach model.compat without Chat store leakage", () => {
    const model = registeredAnthropicModel("https://relay.example", {
      supportsEagerToolInputStreaming: false,
      supportsCacheControlOnTools: true,
      supportsLongCacheRetention: false,
    });
    expect(model.compat).toMatchObject({
      supportsEagerToolInputStreaming: false,
      supportsCacheControlOnTools: true,
      supportsLongCacheRetention: false,
    });
    expect((model.compat as Record<string, unknown> | undefined)?.supportsStore).toBeUndefined();
  });

  test("official Anthropic leaves Anthropic wire fields unset (adapter native)", () => {
    const model = registeredAnthropicModel("https://api.anthropic.com");
    const compat = model.compat as Record<string, unknown> | undefined;
    expect(compat?.supportsEagerToolInputStreaming).toBeUndefined();
    expect(compat?.supportsCacheControlOnTools).toBeUndefined();
    expect(compat?.supportsLongCacheRetention).toBeUndefined();
  });

  test("Anthropic probe still captures messages body; Chat store is not invented", async () => {
    const relay = createStrictRelay(
      "anthropic-messages",
      OFFICIAL_PROFILES["anthropic-messages"],
    );
    const model = registeredAnthropicModel(relay.baseUrl, {
      supportsEagerToolInputStreaming: false,
      supportsCacheControlOnTools: false,
      supportsLongCacheRetention: false,
    });
    const request = makeRequest(model);
    const contextBefore = structuredClone(request.context);

    try {
      const result = await transport()(request);
      expect(result.message.stopReason).toBe("stop");
      expect(request.context).toEqual(contextBefore);
      expect(relay.requests).toHaveLength(1);
      const body = relay.requests[0]?.body as Record<string, unknown>;
      expect(body).toHaveProperty("model");
      expect(body).toHaveProperty("messages");
      expect(body).not.toHaveProperty("store");
      // Long-retention TTL must not appear when supportsLongCacheRetention=false.
      expect(JSON.stringify(body)).not.toMatch(/24h|prompt_cache_retention/i);
      expect(relay.rejections).toEqual([]);
    } finally {
      relay.close();
    }
  });
});

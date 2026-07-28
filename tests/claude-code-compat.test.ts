import { describe, expect, test } from "bun:test";
import {
  AGENT_SDK_SYSTEM_PREFIX,
  applyClaudeCodeCompatHeaders,
  applyClaudeCodeCompatToPayload,
  buildAnthropicUserIdMetadata,
  hostMatches,
  padClaudeCodeToolFingerprint,
  parseClaudeCodeCompatConfig,
  prependSystemPrefix,
  resolveDeviceId,
  resolveSystemPrefixText,
  shouldApplyClaudeCodeCompat,
  transformThinkingForClaudeCodeRelay,
} from "../src/compat/claude-code.ts";

describe("shouldApplyClaudeCodeCompat", () => {
  test("auto enables for anyrouter anthropic", () => {
    expect(
      shouldApplyClaudeCodeCompat({
        mode: "auto",
        api: "anthropic-messages",
        baseUrl: "https://anyrouter.top",
      }),
    ).toBe(true);
  });

  test("auto skips non-anyrouter hosts", () => {
    expect(
      shouldApplyClaudeCodeCompat({
        mode: "auto",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      }),
    ).toBe(false);
  });

  test("auto honors extra hosts", () => {
    expect(
      shouldApplyClaudeCodeCompat({
        mode: "auto",
        hosts: ["relay.example.com"],
        api: "anthropic-messages",
        baseUrl: "https://relay.example.com/v1",
      }),
    ).toBe(true);
  });

  test("never wins over anyrouter", () => {
    expect(
      shouldApplyClaudeCodeCompat({
        mode: "never",
        api: "anthropic-messages",
        baseUrl: "https://anyrouter.top",
      }),
    ).toBe(false);
  });

  test("always applies to anthropic regardless of host", () => {
    expect(
      shouldApplyClaudeCodeCompat({
        mode: "always",
        api: "anthropic-messages",
        baseUrl: "https://example.com",
      }),
    ).toBe(true);
  });

  test("providerForce true/false overrides mode", () => {
    expect(
      shouldApplyClaudeCodeCompat({
        mode: "never",
        api: "anthropic-messages",
        baseUrl: "https://example.com",
        providerForce: true,
      }),
    ).toBe(true);
    expect(
      shouldApplyClaudeCodeCompat({
        mode: "always",
        api: "anthropic-messages",
        baseUrl: "https://anyrouter.top",
        providerForce: false,
      }),
    ).toBe(false);
  });

  test("skips non-anthropic api", () => {
    expect(
      shouldApplyClaudeCodeCompat({
        mode: "always",
        api: "openai-responses",
        baseUrl: "https://anyrouter.top",
      }),
    ).toBe(false);
  });
});

describe("hostMatches", () => {
  test("exact and subdomain", () => {
    expect(hostMatches("https://api.foo.com", ["foo.com"])).toBe(true);
    expect(hostMatches("https://foo.com", ["foo.com"])).toBe(true);
    expect(hostMatches("https://evilfoo.com", ["foo.com"])).toBe(false);
  });
});

describe("prependSystemPrefix", () => {
  test("creates blocks when system empty", () => {
    const out = prependSystemPrefix(undefined, AGENT_SDK_SYSTEM_PREFIX);
    expect(Array.isArray(out)).toBe(true);
    expect((out as { text: string }[])[0].text).toBe(AGENT_SDK_SYSTEM_PREFIX);
  });

  test("prepends to string system", () => {
    const out = prependSystemPrefix("You are pi.", AGENT_SDK_SYSTEM_PREFIX) as {
      text: string;
    }[];
    expect(out[0].text).toBe(AGENT_SDK_SYSTEM_PREFIX);
    expect(out[1].text).toBe("You are pi.");
  });

  test("idempotent when already present", () => {
    const once = prependSystemPrefix("You are pi.", AGENT_SDK_SYSTEM_PREFIX);
    const twice = prependSystemPrefix(once, AGENT_SDK_SYSTEM_PREFIX);
    expect(twice).toEqual(once);
  });
});

describe("applyClaudeCodeCompatToPayload", () => {
  const deviceId = "a".repeat(64);

  test("injects metadata, system prefix, and tool-name stubs", () => {
    const payload = {
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      system: "You are helpful.",
      tools: [{ name: "read", description: "pi", input_schema: { type: "object", properties: {} } }],
    };
    const out = applyClaudeCodeCompatToPayload(payload, {
      deviceId,
      systemPrefix: AGENT_SDK_SYSTEM_PREFIX,
    }) as {
      metadata: { user_id: string };
      system: { text: string }[];
      tools: { name: string }[];
    };
    expect(out.metadata.user_id).toContain(deviceId);
    const parsed = JSON.parse(out.metadata.user_id) as { device_id: string };
    expect(parsed.device_id).toBe(deviceId);
    expect(out.system[0].text).toBe(AGENT_SDK_SYSTEM_PREFIX);
    expect(out.tools.some((t) => t.name === "read")).toBe(true);
    expect(out.tools.some((t) => t.name === "Bash")).toBe(true);
    // First 10 CC fingerprint names are padded (Agent…Grep order).
    expect(out.tools.filter((t) =>
      ["Agent", "Bash", "CronCreate", "CronDelete", "CronList", "Edit", "EnterWorktree", "ExitWorktree", "Glob", "Grep"].includes(t.name),
    ).length).toBe(10);
  });

  test("rewrites unparseable user_id but keeps valid device/session", () => {
    const payload = {
      model: "claude-opus-5",
      messages: [],
      metadata: {
        user_id: JSON.stringify({
          device_id: "b".repeat(64),
          account_uuid: "",
          session_id: "11111111-1111-4111-a111-111111111111",
        }),
      },
    };
    const out = applyClaudeCodeCompatToPayload(payload, {
      deviceId,
      systemPrefix: null,
      injectSystemPrefix: false,
      injectToolFingerprint: false,
    }) as { metadata: { user_id: string } };
    const parsed = JSON.parse(out.metadata.user_id) as {
      device_id: string;
      session_id: string;
    };
    expect(parsed.device_id).toBe("b".repeat(64));
    expect(parsed.session_id).toBe("11111111-1111-4111-a111-111111111111");
  });

  test("ignores non-anthropic payloads", () => {
    const payload = { foo: 1 };
    expect(applyClaudeCodeCompatToPayload(payload, { deviceId })).toBe(payload);
  });
});

describe("buildAnthropicUserIdMetadata", () => {
  test("matches CC shape", () => {
    const s = buildAnthropicUserIdMetadata({
      deviceId: "abc",
      sessionId: "sess",
      accountUuid: "",
    });
    expect(JSON.parse(s)).toEqual({
      device_id: "abc",
      account_uuid: "",
      session_id: "sess",
    });
  });

  test("auto-fills non-empty session_id (anyrouter rejects empty)", () => {
    const s = buildAnthropicUserIdMetadata({ deviceId: "abc" });
    const parsed = JSON.parse(s) as { session_id: string; device_id: string };
    expect(parsed.device_id).toBe("abc");
    expect(parsed.session_id.length).toBeGreaterThan(8);
  });
});

describe("resolveDeviceId", () => {
  test("prefers claude.json userID", () => {
    const id = "b".repeat(64);
    const fs = {
      existsSync: (p: string) => p.endsWith(".claude.json"),
      readFileSync: () => JSON.stringify({ userID: id }),
      writeFileSync: () => {},
    };
    const r = resolveDeviceId({ home: "/home/u", fs, config: { deviceIdSource: "claude-json" } });
    expect(r.deviceId).toBe(id);
    expect(r.source).toBe("claude-json");
  });

  test("generates when missing", () => {
    const written: string[] = [];
    const fs = {
      existsSync: () => false,
      readFileSync: () => {
        throw new Error("nope");
      },
      writeFileSync: (_p: string, data: string) => {
        written.push(data);
      },
    };
    const r = resolveDeviceId({
      home: "/home/u",
      fs,
      config: { deviceIdSource: "generate" },
      randomHex: () => "c".repeat(64),
    });
    expect(r.deviceId).toBe("c".repeat(64));
    expect(r.source).toBe("generate");
    expect(written[0]?.trim()).toBe("c".repeat(64));
  });
});

describe("applyClaudeCodeCompatHeaders", () => {
  test("sets companion headers and merges 1m beta", () => {
    const headers: Record<string, string | null | undefined> = {
      "anthropic-beta": "claude-code-20250219",
    };
    applyClaudeCodeCompatHeaders(headers, { sessionId: "s1" });
    expect(headers["x-app"]).toBe("cli");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers["X-Claude-Code-Session-Id"]).toBe("s1");
    expect(String(headers["anthropic-beta"])).toContain("context-1m-2025-08-07");
    expect(String(headers["anthropic-beta"])).toContain("claude-code-20250219");
  });
});

describe("parseClaudeCodeCompatConfig / resolveSystemPrefixText", () => {
  test("parses config", () => {
    const c = parseClaudeCodeCompatConfig({
      mode: "always",
      hosts: ["x.com"],
      systemPrefix: "agent-sdk",
      injectMetadata: true,
    });
    expect(c?.mode).toBe("always");
    expect(c?.hosts).toEqual(["x.com"]);
    expect(resolveSystemPrefixText("agent-sdk")).toBe(AGENT_SDK_SYSTEM_PREFIX);
    expect(resolveSystemPrefixText("none")).toBeNull();
  });
});

describe("transformThinkingForClaudeCodeRelay", () => {
  test("converts enabled budget thinking to adaptive+effort", () => {
    const body: Record<string, unknown> = {
      thinking: { type: "enabled", budget_tokens: 16000 },
    };
    expect(transformThinkingForClaudeCodeRelay(body)).toBe(true);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "high" });
  });

  test("leaves adaptive alone", () => {
    const body: Record<string, unknown> = {
      thinking: { type: "adaptive" },
    };
    expect(transformThinkingForClaudeCodeRelay(body)).toBe(false);
  });

  test("applyClaudeCodeCompatToPayload rewrites thinking", () => {
    const out = applyClaudeCodeCompatToPayload(
      {
        model: "claude-fable-5",
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled", budget_tokens: 16000 },
        max_tokens: 4096,
      },
      { deviceId: "a".repeat(64), systemPrefix: AGENT_SDK_SYSTEM_PREFIX },
    ) as { thinking: { type: string }; output_config: { effort: string } };
    expect(out.thinking.type).toBe("adaptive");
    expect(out.output_config.effort).toBe("high");
  });
});

describe("padClaudeCodeToolFingerprint", () => {
  test("pads to min CC names and keeps existing", () => {
    const tools = [{ name: "read", description: "x", input_schema: { type: "object", properties: {} } }];
    const out = padClaudeCodeToolFingerprint(tools, 10) as { name: string }[];
    expect(out.some((t) => t.name === "read")).toBe(true);
    expect(out.some((t) => t.name === "Bash")).toBe(true);
    const cc = out.filter((t) =>
      ["Agent", "Bash", "CronCreate", "CronDelete", "CronList", "Edit", "EnterWorktree", "ExitWorktree", "Glob", "Grep"].includes(t.name),
    );
    expect(cc.length).toBe(10);
  });

  test("no-op when enough CC names already present", () => {
    const tools = [
      "Agent", "Bash", "Edit", "Glob", "Grep", "Read", "Write", "WebFetch", "WebSearch", "Skill",
    ].map((name) => ({ name, description: "d", input_schema: { type: "object", properties: {} } }));
    const out = padClaudeCodeToolFingerprint(tools, 10);
    expect(out).toBe(tools);
  });
});

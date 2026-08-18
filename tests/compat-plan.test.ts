import { describe, expect, test } from "bun:test";
import {
  applyCompatibilityPlan,
  buildCompatibilityPlan,
  expandFingerprintHeaders,
} from "../src/compat/plan.ts";
import { AGENT_SDK_SYSTEM_PREFIX } from "../src/compat/claude-code.ts";

const target = {
  provider: "ps-relay",
  modelId: "claude-sonnet",
  fingerprint: "claude-code" as const,
  claudeCodeCompat: true,
};

describe("Compatibility Plan", () => {
  test("is immutable and contains only target-scoped non-secret facts", () => {
    const plan = buildCompatibilityPlan({
      target,
      api: "anthropic-messages",
      headerVars: {
        claudeCodeVersion: "2.1.178",
        anthropicVersion: "2023-06-01",
        anthropicBeta: "claude-code-20250219",
      },
      claudeCompat: { config: {}, systemPrefix: AGENT_SDK_SYSTEM_PREFIX },
    });

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.target)).toBe(true);
    expect(Object.isFrozen(plan.fingerprint!)).toBe(true);
    expect(JSON.stringify(plan)).not.toContain("sk-");
    expect(JSON.stringify(plan)).not.toContain("Authorization");
    expect(plan).not.toHaveProperty("apiKey");
    expect(plan).not.toHaveProperty("payload");
    expect(plan).not.toHaveProperty("config");
    expect(plan.claude).not.toHaveProperty("applyPayload");
    expect(plan.claude?.systemPrefix).toBe(AGENT_SDK_SYSTEM_PREFIX);
    expect(plan.fingerprint?.headers["User-Agent"]).toContain("2.1.178");
  });

  test("omits a fingerprint header when its variable is missing", () => {
    const headers = expandFingerprintHeaders("claude-code", {
      anthropicVersion: "2023-06-01",
      anthropicBeta: "beta",
    });
    expect(headers["User-Agent"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toBe("beta");
  });

  test("gates Claude and Gemini compatibility by the request API", () => {
    const plan = buildCompatibilityPlan({
      target: { ...target, geminiToolCompat: true },
      api: "openai-responses",
      claudeCompat: { config: {}, systemPrefix: AGENT_SDK_SYSTEM_PREFIX },
      geminiCompat: {},
    });
    expect(plan.claude).toBeUndefined();
    expect(plan.gemini).toBeUndefined();
  });

  test("fingerprint headers are defaults and auth wins case-insensitively", () => {
    const plan = buildCompatibilityPlan({
      target: { provider: "ps-relay", modelId: "m1", fingerprint: "claude-code" },
      api: "anthropic-messages",
      headerVars: {
        claudeCodeVersion: "2.0.0",
        anthropicVersion: "2023-06-01",
        anthropicBeta: "fingerprint-beta",
      },
    });
    const applied = applyCompatibilityPlan({
      plan,
      headers: {
        "user-agent": "caller-agent",
        "USER-AGENT": "last-caller-agent",
        "Anthropic-Version": "caller-version",
      },
      payload: {},
    });

    expect(applied.headers["USER-AGENT"]).toBe("last-caller-agent");
    expect(applied.headers["user-agent"]).toBeUndefined();
    expect(applied.headers["User-Agent"]).toBeUndefined();
    expect(applied.headers["Anthropic-Version"]).toBe("caller-version");
    expect(applied.headers["anthropic-version"]).toBeUndefined();
  });

  test("requires complete Claude settings when Claude compatibility is enabled", () => {
    expect(() =>
      buildCompatibilityPlan({
        target: { provider: "ps-relay", modelId: "m1", claudeCodeCompat: true },
        api: "anthropic-messages",
      }),
    ).toThrow("requires complete Claude application settings");
  });

  test("one application applies headers and existing payload transforms", () => {
    const plan = buildCompatibilityPlan({
      target: { ...target, fingerprint: undefined },
      api: "anthropic-messages",
      claudeCompat: { config: {}, systemPrefix: AGENT_SDK_SYSTEM_PREFIX },
    });
    const applied = applyCompatibilityPlan({
      plan,
      headers: { "anthropic-beta": "existing" },
      payload: {
        model: "claude-sonnet",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      },
      claudeDeviceId: " device-id ",
    });

    expect(applied.headers["x-app"]).toBe("cli");
    expect(applied.headers["anthropic-beta"]).toContain("context-1m-2025-08-07");
    expect((applied.payload as Record<string, unknown>).metadata).toBeDefined();
    expect(
      JSON.parse(
        (applied.payload as { metadata: { user_id: string } }).metadata.user_id,
      ).device_id,
    ).toBe("device-id");
    expect((applied.payload as Record<string, unknown>).system).toBeDefined();
  });

  test("requires a non-empty Claude device ID when metadata injection is enabled", () => {
    const plan = buildCompatibilityPlan({
      target: { ...target, fingerprint: undefined },
      api: "anthropic-messages",
      claudeCompat: { config: {}, systemPrefix: AGENT_SDK_SYSTEM_PREFIX },
    });

    expect(() =>
      applyCompatibilityPlan({
        plan,
        payload: {
          model: "claude-sonnet",
          messages: [{ role: "user", content: "hi" }],
        },
      }),
    ).toThrow("local compatibility setup");
    expect(() =>
      applyCompatibilityPlan({
        plan,
        claudeDeviceId: " \t\n ",
        payload: {
          model: "claude-sonnet",
          messages: [{ role: "user", content: "hi" }],
        },
      }),
    ).toThrow("non-empty Claude device ID");
  });

  test("does not require a Claude device ID when metadata injection is disabled", () => {
    const plan = buildCompatibilityPlan({
      target: { ...target, fingerprint: undefined },
      api: "anthropic-messages",
      claudeCompat: {
        config: { injectMetadata: false },
        systemPrefix: AGENT_SDK_SYSTEM_PREFIX,
      },
    });

    const applied = applyCompatibilityPlan({
      plan,
      payload: {
        model: "claude-sonnet",
        messages: [{ role: "user", content: "hi" }],
      },
    });

    const payload = applied.payload as Record<string, unknown>;
    expect(payload.metadata).toBeUndefined();
    expect(payload.system).toBeDefined();
  });

  test("applies Gemini transform without exposing config in the plan", () => {
    const plan = buildCompatibilityPlan({
      target: { provider: "ps-gemini", modelId: "gemini", geminiToolCompat: true },
      api: "google-generative-ai",
      geminiCompat: {},
    });
    const payload = {
      model: "gemini",
      contents: [],
      config: { tools: [{ functionDeclarations: [{ name: "probe_echo" }] }] },
    };
    const applied = applyCompatibilityPlan({ plan, payload });
    expect(
      (applied.payload as { config: { toolConfig: unknown } }).config.toolConfig,
    ).toBeDefined();
    expect(plan.gemini).not.toHaveProperty("applyPayload");
    expect(plan).not.toHaveProperty("payload");
  });
});

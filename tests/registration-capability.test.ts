import { describe, expect, test } from "bun:test";
import {
  formatCapabilityDecision,
  resolveRegistrationCapability,
} from "../src/capabilities/registration.ts";

describe("resolveRegistrationCapability (#63)", () => {
  test("unknown model: maxTokens unresolved, reasoning conservative false", () => {
    const decision = resolveRegistrationCapability({
      modelId: "relay-unknown",
      api: "openai-completions",
      baseUrl: "https://relay.example/v1",
    });

    expect(decision.maxTokensUnresolved).toBe(true);
    expect(decision.meta).toBeUndefined();
    expect(decision.resolved.maxTokens.source).toBe("unresolved");
    expect(decision.reasoningConservative).toBe(true);
    expect(decision.resolved.reasoning).toMatchObject({
      value: false,
      source: "conservative-default",
    });
    // contextWindow may still use protocol structural floor
    expect(decision.resolved.contextWindow.source).toBe("protocol-default");
  });

  test("exact-model maxTokens override restores meta without writing conservative reasoning", () => {
    const decision = resolveRegistrationCapability({
      modelId: "relay-unknown",
      api: "openai-completions",
      baseUrl: "https://relay.example/v1",
      userMeta: { maxTokens: 16_384 },
    });

    expect(decision.maxTokensUnresolved).toBe(false);
    expect(decision.meta).toEqual({
      contextWindow: 128_000,
      maxTokens: 16_384,
      reasoning: false,
    });
    expect(decision.reasoningConservative).toBe(true);
  });

  test("models.dev last-good supplies maxTokens and reasoning", () => {
    const decision = resolveRegistrationCapability({
      modelId: "known",
      api: "anthropic-messages",
      baseUrl: "https://relay.example",
      modelsDev: {
        maxTokens: 8_192,
        reasoning: true,
        observedAt: "2020-01-01T00:00:00Z",
        source: "models-dev",
      },
    });

    expect(decision.maxTokensUnresolved).toBe(false);
    expect(decision.meta?.maxTokens).toBe(8_192);
    expect(decision.meta?.reasoning).toBe(true);
    expect(decision.resolved.maxTokens.source).toBe("models-dev");
    expect(decision.reasoningConservative).toBe(false);
  });

  test("all four APIs refuse protocol maxTokens floors", () => {
    for (const api of [
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
      "google-generative-ai",
    ] as const) {
      const decision = resolveRegistrationCapability({
        modelId: "x",
        api,
        baseUrl: "https://relay.example",
      });
      expect(decision.maxTokensUnresolved).toBe(true);
      expect(decision.resolved.maxTokens.source).toBe("unresolved");
    }
  });

  test("formatCapabilityDecision is redacted and actionable", () => {
    const decision = resolveRegistrationCapability({
      modelId: "m",
      api: "openai-completions",
      baseUrl: "https://relay.example/v1?key=secret",
    });
    const line = formatCapabilityDecision("m", decision, "codex/relay");
    expect(line).toContain("maxTokens=unresolved");
    expect(line).toContain("conservative false");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("key=");
  });
});

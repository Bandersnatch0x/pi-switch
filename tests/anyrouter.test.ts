import { test, expect, describe } from "bun:test";
import {
  ANYROUTER_CONTEXT_1M_BETA,
  ANYROUTER_DEFAULT_CONTEXT_WINDOW,
  applyAnyrouterHeaders,
  applyAnyrouterModelMeta,
  isAnyrouterBaseUrl,
  mergeAnthropicBetaFlag,
} from "../src/headers/anyrouter.ts";
import { resolveModelCapabilities } from "../src/capabilities/resolve.ts";
import { buildProviderConfig } from "../src/register.ts";
import type { CcProvider } from "../src/types.ts";

describe("isAnyrouterBaseUrl", () => {
  test("matches anyrouter.top and subdomains", () => {
    expect(isAnyrouterBaseUrl("https://anyrouter.top")).toBe(true);
    expect(isAnyrouterBaseUrl("https://anyrouter.top/")).toBe(true);
    expect(isAnyrouterBaseUrl("https://anyrouter.top/v1")).toBe(true);
    expect(isAnyrouterBaseUrl("https://api.anyrouter.top")).toBe(true);
  });

  test("rejects unrelated hosts", () => {
    expect(isAnyrouterBaseUrl("https://api.anthropic.com")).toBe(false);
    expect(isAnyrouterBaseUrl("https://openrouter.ai/api/v1")).toBe(false);
    expect(isAnyrouterBaseUrl("https://evil-anyrouter.top.example.com")).toBe(false);
    expect(isAnyrouterBaseUrl("")).toBe(false);
    expect(isAnyrouterBaseUrl(undefined)).toBe(false);
  });
});

describe("mergeAnthropicBetaFlag", () => {
  test("appends when missing", () => {
    expect(mergeAnthropicBetaFlag("a,b", "c")).toBe("a,b,c");
  });

  test("dedupes case-insensitively", () => {
    expect(
      mergeAnthropicBetaFlag(
        `claude-code-20250219,${ANYROUTER_CONTEXT_1M_BETA}`,
        ANYROUTER_CONTEXT_1M_BETA,
      ),
    ).toBe(`claude-code-20250219,${ANYROUTER_CONTEXT_1M_BETA}`);
  });

  test("starts from empty", () => {
    expect(mergeAnthropicBetaFlag(undefined, ANYROUTER_CONTEXT_1M_BETA)).toBe(
      ANYROUTER_CONTEXT_1M_BETA,
    );
  });
});

describe("applyAnyrouterHeaders", () => {
  test("merges context-1m for anyrouter anthropic", () => {
    const out = applyAnyrouterHeaders(
      "anthropic-messages",
      "https://anyrouter.top",
      {
        "User-Agent": "claude-cli/2.0 (external, cli)",
        "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
      },
    );
    expect(out["anthropic-beta"]).toBe(
      `claude-code-20250219,interleaved-thinking-2025-05-14,${ANYROUTER_CONTEXT_1M_BETA}`,
    );
    expect(out["User-Agent"]).toContain("claude-cli");
  });

  test("no-op for non-anyrouter host", () => {
    const inHeaders = { "anthropic-beta": "claude-code-20250219" };
    expect(
      applyAnyrouterHeaders("anthropic-messages", "https://api.anthropic.com", inHeaders),
    ).toEqual(inHeaders);
  });

  test("no-op for non-anthropic api", () => {
    const inHeaders = { "User-Agent": "x" };
    expect(
      applyAnyrouterHeaders("openai-responses", "https://anyrouter.top/v1", inHeaders),
    ).toEqual(inHeaders);
  });
});

describe("applyAnyrouterModelMeta", () => {
  test("supplies contextWindow=1M for anyrouter anthropic (pure layer)", () => {
    expect(
      applyAnyrouterModelMeta("anthropic-messages", "https://anyrouter.top"),
    ).toEqual({
      contextWindow: ANYROUTER_DEFAULT_CONTEXT_WINDOW,
    });
    expect(ANYROUTER_DEFAULT_CONTEXT_WINDOW).toBe(1_000_000);
  });

  test("undefined for non-anyrouter or non-anthropic", () => {
    expect(
      applyAnyrouterModelMeta("anthropic-messages", "https://api.anthropic.com"),
    ).toBeUndefined();
    expect(
      applyAnyrouterModelMeta("openai-completions", "https://anyrouter.top"),
    ).toBeUndefined();
  });
});

function mk(partial: Partial<CcProvider> & Pick<CcProvider, "id" | "appType">): CcProvider {
  return {
    piName: `ps-${partial.appType}-${partial.id}`,
    displayName: partial.displayName ?? `name-${partial.id}`,
    api: "anthropic-messages",
    baseUrl: "https://example.com",
    apiKey: "k",
    authHeader: true,
    configModels: ["m1"],
    meta: {},
    isCurrentInCc: false,
    ...partial,
  };
}

describe("buildProviderConfig anyrouter adapt", () => {
  test("injects context-1m beta + 1M contextWindow for anyrouter.top", () => {
    const cfg = buildProviderConfig(
      mk({
        id: "ar",
        appType: "claude",
        baseUrl: "https://anyrouter.top",
        api: "anthropic-messages",
      }),
      ["claude-fable-5"],
      {
        rules: [
          {
            name: "claude-code",
            apis: ["anthropic-messages"],
            headers: {
              "anthropic-beta":
                "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
            },
          },
        ],
      },
    );
    expect(cfg).toBeDefined();
    const headers = cfg!.headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toContain(ANYROUTER_CONTEXT_1M_BETA);
    expect(headers["anthropic-beta"]).toContain("claude-code-20250219");
    const model = (cfg!.models as { contextWindow: number; id: string }[])[0];
    expect(model.id).toBe("claude-fable-5");
    expect(model.contextWindow).toBe(1_000_000);
  });

  test("does not inject for ordinary anthropic host", () => {
    const cfg = buildProviderConfig(
      mk({
        id: "a",
        appType: "claude",
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
      }),
      ["m"],
      {
        rules: [
          {
            name: "claude-code",
            apis: ["anthropic-messages"],
            headers: { "anthropic-beta": "claude-code-20250219" },
          },
        ],
      },
    );
    const headers = cfg!.headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toBe("claude-code-20250219");
    expect((cfg!.models as { contextWindow: number }[])[0].contextWindow).toBe(200_000);
  });

  test("anyrouter hostAdaptation beats models.dev 200k (conflict visible in resolve)", () => {
    const cfg = buildProviderConfig(
      mk({
        id: "ar",
        appType: "claude",
        baseUrl: "https://anyrouter.top",
        api: "anthropic-messages",
      }),
      ["claude-fable-5"],
      {
        rules: [],
        modelsDevFor: () => ({
          contextWindow: 200_000,
          maxTokens: 64_000,
          reasoning: true,
          observedAt: "2026-07-31T00:00:00Z",
          source: "models-dev",
        }),
      },
    );
    expect((cfg!.models as { contextWindow: number }[])[0].contextWindow).toBe(1_000_000);

    // doctor-side: host-adaptation vs models-dev is a conflict (WARN visible)
    const r = resolveModelCapabilities({
      hostAdaptation: applyAnyrouterModelMeta("anthropic-messages", "https://anyrouter.top"),
      modelsDev: {
        contextWindow: 200_000,
        observedAt: "2026-07-31T00:00:00Z",
        source: "models-dev",
      },
      defaults: { contextWindow: 200_000, maxTokens: 64_000, reasoning: true, vision: true },
    });
    expect(r.contextWindow).toMatchObject({ value: 1_000_000, source: "host-adaptation" });
    expect(r.conflicts).toContainEqual(
      expect.objectContaining({
        field: "contextWindow",
        effectiveSource: "host-adaptation",
        overriddenSource: "models-dev",
      }),
    );
  });
});

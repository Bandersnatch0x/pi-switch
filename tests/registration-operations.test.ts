import { describe, expect, spyOn, test } from "bun:test";
import {
  createRegistrationOperations,
  type RegistrationOperationsDeps,
} from "../extensions/registration-operations.ts";
import { buildProviderConfig } from "../src/register.ts";
import { resolveProviderWireCompat } from "../src/provider-wire-compat.ts";
import type { CcProvider, HeaderRule, ModelMetaOverride } from "../src/types.ts";

function provider(): CcProvider {
  return {
    id: "provider-1",
    piName: "ps-codex-provider-1",
    displayName: "relay",
    appType: "codex",
    api: "openai-completions",
    baseUrl: "https://user:password@example.com/v1?token=secret",
    apiKey: "literal-secret-value",
    authHeader: true,
    configModels: ["gpt-5"],
    meta: {},
    isCurrentInCc: false,
  };
}

function deps(
  overrides: Partial<RegistrationOperationsDeps> = {},
): RegistrationOperationsDeps {
  return {
    headerRules: () => [],
    headerOverrideOpts: () => ({}),
    headerVars: () => ({}),
    debug: () => false,
    rejectSink: () => undefined,
    modelMetaFactsFor: () => ({ userMeta: undefined, userMapScopes: {} }),
    modelsDevFor: () => undefined,
    providerWireCompatFor: () => undefined,
    tupleCompatFor: () => undefined,
    ...overrides,
  };
}

describe("RegistrationOperations", () => {
  test("resolves trusted and unresolved registration decisions", () => {
    let modelMeta: ModelMetaOverride | undefined = {
      maxTokens: 32_000,
      reasoning: true,
    };
    const registration = createRegistrationOperations(
      deps({
        modelMetaFactsFor: () => ({ userMeta: modelMeta, userMapScopes: {} }),
      }),
    );
    const currentProvider = provider();

    const trusted = registration.decisionFor(currentProvider, "gpt-5");
    expect(trusted.maxTokensUnresolved).toBe(false);
    expect(trusted.meta?.maxTokens).toBe(32_000);
    expect(trusted.meta?.reasoning).toBe(true);

    modelMeta = undefined;
    const unresolved = registration.decisionFor(currentProvider, "unknown");
    expect(unresolved.maxTokensUnresolved).toBe(true);
    expect(unresolved.meta).toBeUndefined();
  });

  test("assembles the complete option bundle from live provider and model facts", () => {
    const currentProvider = provider();
    let rules: HeaderRule[] = [
      { name: "initial", apis: ["openai-completions"], headers: { "X-Rule": "one" } },
    ];
    let vars = { CODEX_VERSION: "1.0" };
    let debug = false;
    let modelMeta: ModelMetaOverride | undefined = { maxTokens: 16_000 };
    let modelMaxTokens = 24_000;
    let providerWireCompat = resolveProviderWireCompat({
      provider: currentProvider,
      override: { api: "openai-completions", supportsStore: false },
    });
    let tuple = {
      tuple: {
        api: "openai-completions" as const,
        supportsDeveloperRole: false,
      },
    };
    const rejectSink = () => undefined;
    const registration = createRegistrationOperations(
      deps({
        headerRules: () => rules,
        headerOverrideOpts: () => ({
          overrideHeaders: { "User-Agent": debug ? "codex-cli/2.0" : "codex-cli/1.0" },
          skipRules: true,
        }),
        headerVars: () => vars,
        debug: () => debug,
        rejectSink: () => rejectSink,
        modelMetaFactsFor: (_provider, modelId) => ({
          userMeta: modelId === "gpt-5" ? modelMeta : undefined,
          userMapScopes: {},
        }),
        modelsDevFor: () => ({
          maxTokens: modelMaxTokens,
          observedAt: "2026-08-17",
          source: "models-dev",
        }),
        providerWireCompatFor: () => providerWireCompat,
        tupleCompatFor: (_provider, modelId) =>
          modelId === "gpt-5" ? tuple : undefined,
      }),
    );

    const first = registration.optionsFor(currentProvider);
    expect(first).toMatchObject({
      rules,
      overrideHeaders: { "User-Agent": "codex-cli/1.0" },
      skipRules: true,
      vars,
      debug: false,
      onReject: rejectSink,
      providerWireCompat,
    });
    expect(first.registrationDecisionFor?.("gpt-5").meta?.maxTokens).toBe(16_000);
    expect(first.registrationDecisionFor?.("models-dev-only").meta?.maxTokens).toBe(24_000);
    expect(first.tupleCompatFor?.("gpt-5")).toEqual(tuple);

    rules = [
      { name: "reloaded", apis: ["openai-completions"], headers: { "X-Rule": "two" } },
    ];
    vars = { CODEX_VERSION: "2.0" };
    debug = true;
    modelMeta = { maxTokens: 48_000, reasoning: true };
    modelMaxTokens = 64_000;
    providerWireCompat = resolveProviderWireCompat({
      provider: currentProvider,
      override: { api: "openai-completions", supportsStore: true },
    });
    tuple = {
      tuple: {
        api: "openai-completions" as const,
        supportsDeveloperRole: true,
      },
    };

    const reloaded = registration.optionsFor(currentProvider);
    expect(reloaded.rules).toBe(rules);
    expect(reloaded.vars).toEqual({ CODEX_VERSION: "2.0" });
    expect(reloaded.debug).toBe(true);
    expect(reloaded.overrideHeaders).toEqual({ "User-Agent": "codex-cli/2.0" });
    expect(reloaded.providerWireCompat).toBe(providerWireCompat);
    expect(reloaded.tupleCompatFor?.("gpt-5")).toEqual(tuple);
    expect(reloaded.registrationDecisionFor?.("gpt-5").meta?.maxTokens).toBe(48_000);
    expect(reloaded.registrationDecisionFor?.("models-dev-only").meta?.maxTokens).toBe(64_000);
  });

  test("executes debug rejection behavior without exposing credentials or header values", () => {
    const warnings: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });

    try {
      const currentProvider = provider();
      const registration = createRegistrationOperations(
        deps({
          debug: () => true,
          headerOverrideOpts: () => ({
            overrideHeaders: { Authorization: "Bearer durable-secret" },
          }),
          rejectSink: () => (name, reason) =>
            console.warn(`[pi-switch] header rejected: ${name} (${reason})`),
          modelMetaFactsFor: () => ({
            userMeta: { maxTokens: 16_000 },
            userMapScopes: {},
          }),
        }),
      );

      const built = buildProviderConfig(
        currentProvider,
        ["gpt-5"],
        registration.optionsFor(currentProvider),
      );

      expect(built).toBeDefined();
      expect(warnings).toEqual([
        "[pi-switch] header rejected: Authorization (not in allowlist (source=providerOverrides))",
      ]);
      const output = warnings.join("\n");
      expect(output).not.toContain("durable-secret");
      expect(output).not.toContain("literal-secret-value");
      expect(output).not.toContain("user:password");
      expect(output).not.toContain("token=secret");
    } finally {
      warn.mockRestore();
    }
  });
});

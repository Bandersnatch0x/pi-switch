import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { compareSemver } from "../src/settings.ts";
import { formatDoctorReport, runDoctor } from "../src/doctor.ts";
import { resolveProviderWireCompat } from "../src/provider-wire-compat.ts";
import { setLocale } from "../src/ui/tui-locale.ts";
import type { CcProvider } from "../src/types.ts";
import type { RegistrationCapabilityDecision } from "../src/capabilities/registration.ts";
import {
  isMaxTokensResolved,
  type ResolvedCapabilities,
} from "../src/capabilities/resolve.ts";
import {
  canonicalProviderEndpointTuple,
  type ThinkingProjectionDecision,
} from "../src/capabilities/thinking-projection.ts";

// Doctor badges are hardcoded-English by design; pin en so the [FAIL] assertion
// is deterministic regardless of the test runner's LANG.
beforeAll(() => setLocale("en"));
afterAll(() => setLocale("en"));

/** Doctor input is the registration decision; derive its booleans with the production gate. */
function capDecision(resolved: ResolvedCapabilities): RegistrationCapabilityDecision {
  return {
    resolved,
    meta: undefined,
    maxTokensUnresolved: !isMaxTokensResolved(resolved.maxTokens),
    reasoningConservative: resolved.reasoning.source === "conservative-default",
    thinkingProjection: undefined,
  };
}

function withThinking(
  base: RegistrationCapabilityDecision,
  over: Partial<ThinkingProjectionDecision> = {},
): RegistrationCapabilityDecision {
  return {
    ...base,
    thinkingProjection: {
      tuple: canonicalProviderEndpointTuple({
        appType: "codex",
        providerId: "relay",
        api: "openai-responses",
        baseUrl: "https://secret.example/v1",
        modelId: "gpt-5.6-sol",
      }),
      tupleKey: "redacted-key",
      profileVersion: "catalog@1",
      control: { type: "effort" },
      map: { max: "max" },
      advertised: [
        { type: "effort", value: "max" },
        { type: "effort", value: "ultra" },
      ],
      unrepresented: [{ type: "effort", value: "ultra" }],
      projections: [
        {
          intent: "max",
          native: { type: "effort", value: "max" },
          effectiveLevel: "max",
          status: "exact",
          source: "codex-model-catalog",
        },
      ],
      collisions: [],
      source: "codex-model-catalog",
      observedAt: "2026-08-17T00:00:00.000Z",
      stale: false,
      status: "exact",
      runtime: {
        version: "0.84.2",
        runtimeVerified: true,
        payloadVerified: true,
        supportedControls: ["effort"],
        providerDefault: "supported",
        off: "indistinguishable-from-provider-default",
      },
      warnings: [],
      ...over,
    },
  };
}

function mk(
  partial: Partial<CcProvider> & Pick<CcProvider, "id" | "displayName" | "appType">,
): CcProvider {
  return {
    piName: `ps-${partial.appType}-${partial.id}`,
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

describe("runDoctor", () => {
  test("fails when sqlite3 and db missing", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/h/.cc-switch/cc-switch.db",
      dbExists: false,
      sqlite3Path: null,
      sqlite3Tried: ["/nope"],
      providers: [],
      config: {},
      headerRuleCount: 0,
    });
    expect(report.summary.fail).toBeGreaterThanOrEqual(2);
    const ids = report.checks.map((c) => c.id);
    expect(ids).toContain("sqlite3");
    expect(ids).toContain("db-file");
    expect(formatDoctorReport(report)).toContain("[FAIL]");
  });

  test("passes healthy snapshot with selection", () => {
    const p = mk({ id: "1", displayName: "alpha", appType: "claude" });
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "/usr/bin/sqlite3",
      providers: [p],
      selection: { dbId: "1", model: "m1" },
      config: { defaultModelMeta: { reasoning: false } },
      headerRuleCount: 3,
      varsSummary: {
        codexVersion: "0.1",
        codexVersionSource: "local",
        claudeCodeVersion: "2.0",
        claudeCodeVersionSource: "local",
        geminiVersion: "0.9",
        geminiVersionSource: "local",
        anthropicBeta: "x",
        codexOriginator: "codex_cli_rs",
      },
      pins: [{ dbId: "1", model: "m1" }],
      recent: [{ dbId: "1", model: "m1", at: 1 }],
    });
    expect(report.summary.fail).toBe(0);
    expect(report.checks.find((c) => c.id === "selection")?.status).toBe("pass");
    expect(report.checks.find((c) => c.id === "model-meta")?.detail).toContain("reasoning=false");
    expect(formatDoctorReport(report)).toContain("PASS=");
  });

  test("model-meta detail names the contributing layers", () => {
    const p = mk({ id: "1", displayName: "alpha", appType: "claude", configModels: ["glm-4.6"] });
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "/usr/bin/sqlite3",
      providers: [p],
      selection: { dbId: "1", model: "glm-4.6" },
      config: {
        defaultModelMeta: { reasoning: true },
        providerOverrides: {
          "1": {
            modelMeta: { contextWindow: 200_000 },
            modelOverrides: { "glm-4.6": { reasoning: false } },
          },
        },
      },
      headerRuleCount: 1,
    });
    const detail = report.checks.find((c) => c.id === "model-meta")?.detail ?? "";
    expect(detail).toContain("reasoning=false");
    expect(detail).toContain("user: defaultModelMeta → provider → model[glm-4.6]");
    expect(report.checks.find((c) => c.id === "model-overrides")?.status).toBe("pass");
  });

  test("model-meta includes builtInCompat source for deepseek*", () => {
    const p = mk({
      id: "1",
      displayName: "ds",
      appType: "hermes",
      configModels: ["deepseek-v4-flash"],
    });
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "/usr/bin/sqlite3",
      providers: [p],
      selection: { dbId: "1", model: "deepseek-v4-flash" },
      config: {},
      headerRuleCount: 0,
    });
    const detail = report.checks.find((c) => c.id === "model-meta")?.detail ?? "";
    expect(detail).toContain("thinkingFormat=deepseek");
    expect(detail).toContain("built-in: deepseek*");
    expect(detail).not.toContain("builtInCompat[");
  });

  test("model-meta shows 内置: 已关闭 when useBuiltInCompat is false", () => {
    const p = mk({
      id: "1",
      displayName: "ds",
      appType: "hermes",
      configModels: ["deepseek-v4-flash"],
    });
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "/usr/bin/sqlite3",
      providers: [p],
      selection: { dbId: "1", model: "deepseek-v4-flash" },
      config: {
        providerOverrides: {
          "1": { modelOverrides: { "deepseek-v4-flash": { useBuiltInCompat: false } } },
        },
      },
      headerRuleCount: 0,
    });
    const detail = report.checks.find((c) => c.id === "model-meta")?.detail ?? "";
    expect(detail).toContain("useBuiltInCompat=false");
    expect(detail).toContain("built-in: disabled");
    expect(detail).not.toContain("thinkingFormat=deepseek");
    expect(detail).not.toContain("built-in: deepseek*");
  });

  test("warns on per-model override keys missing from the provider", () => {
    const p = mk({ id: "1", displayName: "alpha", appType: "claude", configModels: ["m1"] });
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "/usr/bin/sqlite3",
      providers: [p],
      config: {
        providerOverrides: {
          "1": { modelOverrides: { "gone-model": { reasoning: false }, "gpt-5*": { reasoning: true } } },
        },
      },
      headerRuleCount: 1,
    });
    const check = report.checks.find((c) => c.id === "model-overrides");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("alpha/gone-model");
    // globs are never reported stale
    expect(check?.detail).not.toContain("gpt-5*");
  });

  test("warns when unknown Chat relay uses conservative long-cache default under PI_CACHE_RETENTION=long", () => {
    const p = mk({
      id: "chat-relay",
      displayName: "relay",
      appType: "codex",
      api: "openai-completions",
      baseUrl: "https://relay.example/v1",
    });
    const providerWireCompat = resolveProviderWireCompat({ provider: p });
    expect(providerWireCompat?.api).toBe("openai-completions");
    expect(providerWireCompat?.source).toBe("conservative-default");

    const report = runDoctor({
      home: "/h", dbPath: "/db", dbExists: true, sqlite3Path: "sqlite3", providers: [p], selection: { dbId: p.id, model: "m1" }, config: {}, headerRuleCount: 1, providerWireCompat, cacheRetentionEnv: "long" });

    const check = report.checks.find((candidate) => candidate.id === "provider-wire-compat");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("supportsLongCacheRetention=false(conservative-default)");
    expect(check?.fix).toContain("supportsLongCacheRetention");
    expect(check?.fix).toContain("providerOverrides");
  });

  test("passes when unknown Chat relay uses conservative long-cache default but PI_CACHE_RETENTION is not long", () => {
    const p = mk({
      id: "chat-relay",
      displayName: "relay",
      appType: "codex",
      api: "openai-completions",
      baseUrl: "https://relay.example/v1",
    });
    const providerWireCompat = resolveProviderWireCompat({ provider: p });

    const report = runDoctor({
      home: "/h", dbPath: "/db", dbExists: true, sqlite3Path: "sqlite3", providers: [p], selection: { dbId: p.id, model: "m1" }, config: {}, headerRuleCount: 1, providerWireCompat, cacheRetentionEnv: undefined });

    const check = report.checks.find((candidate) => candidate.id === "provider-wire-compat");
    expect(check?.status).toBe("pass");
  });

  test("warns when an explicit Provider wire override conflicts with official adapter facts", () => {
    const p = mk({
      id: "openai",
      displayName: "official",
      appType: "codex",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1?secret=hidden",
    });
    const providerWireCompat = resolveProviderWireCompat({
      provider: p,
      override: { api: "openai-completions", supportsStore: false },
    });
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [p],
      selection: { dbId: p.id, model: "m1" },
      config: {},
      headerRuleCount: 1,
      providerWireCompat,
    });

    const check = report.checks.find((candidate) => candidate.id === "provider-wire-compat");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain(
      "supportsStore=false(user-provider, scope=provider)",
    );
    expect(check?.detail).toContain("official-adapter");
    expect(check?.detail).not.toContain("secret");
    expect(check?.fix).toContain("providerOverrides");
  });

  test("stale Chat wire override on Anthropic selection does not crash doctor (#65)", () => {
    const p = mk({
      id: "claude-relay",
      displayName: "claude",
      appType: "claude",
      api: "anthropic-messages",
      baseUrl: "https://relay.example",
    });
    // Leftover Chat compat is ignored; Anthropic still resolves its own defaults.
    const providerWireCompat = resolveProviderWireCompat({
      provider: p,
      override: { api: "openai-completions", supportsStore: true },
    });
    expect(providerWireCompat?.api).toBe("anthropic-messages");
    expect(providerWireCompat?.source).toBe("conservative-default");

    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [p],
      selection: { dbId: p.id, model: "m1" },
      config: {},
      headerRuleCount: 1,
      providerWireCompat,
    });

    expect(report.summary.fail).toBe(0);
    const check = report.checks.find(
      (candidate) => candidate.id === "provider-wire-compat",
    );
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("anthropic-messages");
    expect(check?.detail).toContain("supportsEagerToolInputStreaming=false");
    expect(check?.detail).not.toContain("secret");
  });

  test("warns when fingerprint uses fallbacks", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
      varsSummary: {
        codexVersion: "0.141.0",
        codexVersionSource: "fallback",
        claudeCodeVersion: "2.1.178",
        claudeCodeVersionSource: "fallback",
        geminiVersion: "0.9.0",
        geminiVersionSource: "fallback",
        anthropicBeta: "b",
        codexOriginator: "codex_cli_rs",
      },
    });
    expect(report.checks.find((c) => c.id === "fingerprint")?.status).toBe("warn");
  });

  test("sdk check passes inside window and defaults min to PI_MIN_VERSION", () => {
    const base = {
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
    };
    const report = runDoctor({ ...base, piVersion: "0.83.0" });
    const check = report.checks.find((c) => c.id === "sdk");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("0.78.1");
  });

  test("sdk check fails when Pi below minimum with recovery action", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
      piVersion: "0.77.0",
    });
    const check = report.checks.find((c) => c.id === "sdk");
    expect(check?.status).toBe("fail");
    expect(check?.fix).toContain("upgrade Pi");
    expect(report.summary.fail).toBeGreaterThanOrEqual(1);
  });

  test("sdk check passes when version undetectable (peer range already gates install)", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
    });
    const check = report.checks.find((c) => c.id === "sdk");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("not detected");
  });

  test("compareSemver handles dotted numeric versions", () => {
    expect(compareSemver("0.78.1", "0.78.1")).toBe(0);
    expect(compareSemver("0.78.1", "0.83.0")).toBe(-1);
    expect(compareSemver("0.83.0", "0.83.1")).toBe(-1);
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
  });

  test("fingerprint W5: local probed version matching snapshot baseline passes", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
      fingerprintSnapshot: {
        snapshotVersion: 1,
        baselines: { codex: "0.141.0", claudeCode: "2.1.178", gemini: "0.9.0" },
      },
      varsSummary: {
        codexVersion: "0.141.0",
        codexVersionSource: "local",
        claudeCodeVersion: "2.1.178",
        claudeCodeVersionSource: "local",
        geminiVersion: "0.9.0",
        geminiVersionSource: "local",
        anthropicBeta: "b",
        codexOriginator: "codex_cli_rs",
      },
    });
    const check = report.checks.find((c) => c.id === "fingerprint");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("snapshot=v1");
  });

  test("fingerprint W5: local version drifting from snapshot baseline warns", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
      fingerprintSnapshot: {
        snapshotVersion: 1,
        baselines: { codex: "0.141.0", claudeCode: "2.1.178", gemini: "0.9.0" },
      },
      varsSummary: {
        codexVersion: "0.144.6",
        codexVersionSource: "local",
        claudeCodeVersion: "2.1.178",
        claudeCodeVersionSource: "local",
        geminiVersion: "0.9.0",
        geminiVersionSource: "local",
        anthropicBeta: "b",
        codexOriginator: "codex_cli_rs",
      },
    });
    const check = report.checks.find((c) => c.id === "fingerprint");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("codex=0.144.6(local)");
    expect(check?.fix).toContain("snapshot");
  });

  test("fingerprint W5: config-pinned version never warns (documented resolution)", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
      fingerprintSnapshot: {
        snapshotVersion: 1,
        baselines: { codex: "0.141.0", claudeCode: "2.1.178", gemini: "0.9.0" },
      },
      varsSummary: {
        codexVersion: "9.9.9",
        codexVersionSource: "config",
        claudeCodeVersion: "2.1.178",
        claudeCodeVersionSource: "local",
        geminiVersion: "0.9.0",
        geminiVersionSource: "local",
        anthropicBeta: "b",
        codexOriginator: "codex_cli_rs",
      },
    });
    const check = report.checks.find((c) => c.id === "fingerprint");
    expect(check?.status).toBe("pass");
    expect(check?.fix).toBeUndefined();
  });

  test("fingerprint W5: no snapshot packaged -> no out-of-snapshot warn", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
      varsSummary: {
        codexVersion: "0.144.6",
        codexVersionSource: "local",
        claudeCodeVersion: "2.1.178",
        claudeCodeVersionSource: "local",
        geminiVersion: "0.9.0",
        geminiVersionSource: "local",
        anthropicBeta: "b",
        codexOriginator: "codex_cli_rs",
      },
    });
    const check = report.checks.find((c) => c.id === "fingerprint");
    expect(check?.status).toBe("pass");
  });

  test("routing W3: reachable proxy passes with url fact", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
      routingProbe: { url: "http://127.0.0.1:15721", reachable: true },
    });
    const check = report.checks.find((c) => c.id === "routing");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("15721");
  });

  test("routing W3: unreachable proxy warns with recovery and direct-path note", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
      routingProbe: { url: "http://127.0.0.1:15721", reachable: false },
    });
    const check = report.checks.find((c) => c.id === "routing");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("unreachable");
    expect(check?.fix).toContain("proxy");
  });

  test("routing W3: no probe configured -> no routing check", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
    });
    expect(report.checks.find((c) => c.id === "routing")).toBeUndefined();
  });

  test("capabilities W4: clean resolution passes with per-field sources", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
      capabilities: {
        modelId: "m1",
        decision: capDecision({
          contextWindow: { value: 200000, source: "protocol-default" },
          maxTokens: { value: 64000, source: "user-override" },
          reasoning: { value: true, source: "user-override" },
          vision: { value: true, source: "protocol-default" },
          conflicts: [],
        }),
      },
    });
    const check = report.checks.find((c) => c.id === "capabilities");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("context=200000(protocol-default)");
  });

  test("capabilities: thinking projection detail is shared and lossy raises warn", () => {
    const resolved: ResolvedCapabilities = {
      contextWindow: { value: 200000, source: "protocol-default" },
      maxTokens: { value: 64000, source: "user-override" },
      reasoning: { value: true, source: "user-override" },
      vision: { value: true, source: "protocol-default" },
      conflicts: [],
    };
    const exact = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "relay", displayName: "a", appType: "codex" })],
      config: {},
      headerRuleCount: 1,
      capabilities: {
        modelId: "gpt-5.6-sol",
        decision: withThinking(capDecision(resolved)),
      },
    });
    const exactCheck = exact.checks.find((c) => c.id === "capabilities");
    expect(exactCheck?.status).toBe("pass");
    expect(exactCheck?.detail).toContain("ultra advertised but not selectable");
    expect(exactCheck?.detail).not.toContain("secret.example");

    const lossy = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "relay", displayName: "a", appType: "codex" })],
      config: {},
      headerRuleCount: 1,
      capabilities: {
        modelId: "gpt-5.6-sol",
        decision: withThinking(capDecision(resolved), {
          map: { max: "ultra" },
          unrepresented: [{ type: "effort", value: "max" }],
          projections: [
            {
              intent: "max",
              native: { type: "effort", value: "ultra" },
              effectiveLevel: "max",
              status: "lossy",
              source: "user-map",
              scope: "exact-model",
            },
          ],
          status: "lossy",
        }),
      },
    });
    const lossyCheck = lossy.checks.find((c) => c.id === "capabilities");
    expect(lossyCheck?.status).toBe("warn");
    expect(lossyCheck?.detail).toContain("Pi max -> provider ultra");

    const unsupportedRuntime = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "relay", displayName: "a", appType: "codex" })],
      config: {},
      headerRuleCount: 1,
      capabilities: {
        modelId: "gpt-5.6-sol",
        decision: withThinking(capDecision(resolved), {
          map: undefined,
          projections: [
            {
              intent: "high",
              native: { type: "effort", value: "high" },
              effectiveLevel: "high",
              status: "unsupported",
              source: "codex-model-catalog",
              reason: "Pi 0.84.2 does not support this control for this tuple",
            },
          ],
          status: "unsupported",
          runtime: {
            version: "0.84.2",
            runtimeVerified: true,
            payloadVerified: false,
            supportedControls: [],
            providerDefault: "supported",
            off: "unsupported",
          },
        }),
      },
    });
    const unsupportedCheck = unsupportedRuntime.checks.find(
      (c) => c.id === "capabilities",
    );
    expect(unsupportedCheck?.status).toBe("warn");
    expect(unsupportedCheck?.detail).toContain("thinking=unsupported-runtime");
  });

  test("capabilities #63: unresolved maxTokens fails with exact-model fix", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "relay", appType: "codex" })],
      config: {},
      headerRuleCount: 1,
      capabilities: {
        modelId: "unknown-relay-model",
        decision: capDecision({
          contextWindow: { value: 128000, source: "protocol-default" },
          maxTokens: { value: undefined, source: "unresolved" },
          reasoning: { value: false, source: "conservative-default" },
          vision: { value: false, source: "conservative-default" },
          conflicts: [],
        }),
      },
    });
    const check = report.checks.find((c) => c.id === "capabilities");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("maxOutput=unresolved");
    expect(check?.detail).toContain("unknown→conservative false");
    expect(check?.detail).not.toContain("secret");
    expect(check?.fix).toContain("modelOverrides");
    expect(check?.fix).toContain("unknown-relay-model");
  });

  test("capabilities W4: conflict warns with effective vs overridden", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
      capabilities: {
        modelId: "m1",
        decision: capDecision({
          contextWindow: { value: 1000000, source: "models-dev", fetchedAt: "2026-04-24" },
          maxTokens: { value: 384000, source: "models-dev", fetchedAt: "2026-04-24" },
          reasoning: { value: true, source: "protocol-default" },
          vision: { value: true, source: "protocol-default" },
          conflicts: [
            {
              field: "contextWindow",
              effective: "1000000",
              overridden: "128000",
              effectiveSource: "models-dev",
              overriddenSource: "cc-meta",
            },
          ],
        }),
      },
    });
    const check = report.checks.find((c) => c.id === "capabilities");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("vs 128000(cc-meta)");
    expect(check?.fix).toContain("override");
  });

  test("capabilities W4: stale models.dev fact warns and keeps last-good", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
      capabilities: {
        modelId: "m1",
        decision: capDecision({
          contextWindow: {
            value: 1000000,
            source: "models-dev",
            fetchedAt: "2020-01-01",
            stale: true,
          },
          maxTokens: { value: 384000, source: "models-dev", fetchedAt: "2020-01-01", stale: true },
          reasoning: { value: true, source: "protocol-default" },
          vision: { value: true, source: "protocol-default" },
          conflicts: [],
        }),
      },
    });
    const check = report.checks.find((c) => c.id === "capabilities");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("stale");
  });

  test("capabilities #39: miss shows confirmed-absent line and stays pass", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
      capabilities: {
        modelId: "private-proxy-id",
        decision: capDecision({
          contextWindow: { value: 200000, source: "protocol-default" },
          maxTokens: { value: 64000, source: "protocol-default" },
          reasoning: { value: true, source: "protocol-default" },
          vision: { value: true, source: "protocol-default" },
          conflicts: [],
        }),
      },
      modelsDevCache: { state: "miss", observedAt: "2026-08-01T12:00:00.000Z" },
    });
    const check = report.checks.find((c) => c.id === "capabilities");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("no such entry (confirmed");
  });

  test("capabilities #39: cold shows unqueried line and stays pass", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
      capabilities: {
        modelId: "m1",
        decision: capDecision({
          contextWindow: { value: 200000, source: "protocol-default" },
          maxTokens: { value: 64000, source: "protocol-default" },
          reasoning: { value: true, source: "protocol-default" },
          vision: { value: true, source: "protocol-default" },
          conflicts: [],
        }),
      },
      modelsDevCache: { state: "cold" },
    });
    const check = report.checks.find((c) => c.id === "capabilities");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("not queried");
  });

  test("capabilities #39: refreshFailure surfaces background failure line", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
      capabilities: {
        modelId: "m1",
        decision: capDecision({
          contextWindow: { value: 200000, source: "protocol-default" },
          maxTokens: { value: 64000, source: "protocol-default" },
          reasoning: { value: true, source: "protocol-default" },
          vision: { value: true, source: "protocol-default" },
          conflicts: [],
        }),
      },
      refreshFailure: { at: Date.parse("2026-08-03T10:00:00.000Z"), message: "network down" },
    });
    const check = report.checks.find((c) => c.id === "capabilities");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("last background refresh failed");
  });

  test("capabilities #36: model-id-tag and host-adaptation render Chinese labels", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
      capabilities: {
        modelId: "deepseek-v4-flash[1M]",
        decision: capDecision({
          contextWindow: { value: 1000000, source: "model-id-tag" },
          maxTokens: { value: 32000, source: "protocol-default" },
          reasoning: { value: false, source: "protocol-default" },
          vision: { value: false, source: "protocol-default" },
          conflicts: [],
        }),
      },
    });
    const check = report.checks.find((c) => c.id === "capabilities");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("context=1000000(model-id tag)");

    const hostReport = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "claude" })],
      config: {},
      headerRuleCount: 1,
      capabilities: {
        modelId: "claude-fable-5",
        decision: capDecision({
          contextWindow: { value: 1000000, source: "host-adaptation" },
          maxTokens: { value: 64000, source: "protocol-default" },
          reasoning: { value: true, source: "protocol-default" },
          vision: { value: true, source: "protocol-default" },
          conflicts: [],
        }),
      },
    });
    const hostCheck = hostReport.checks.find((c) => c.id === "capabilities");
    expect(hostCheck?.detail).toContain("context=1000000(host adaptation)");
  });

  test("tier W2: per-app-type row with direct/visible/routed counts", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [
        mk({ id: "1", displayName: "a", appType: "claude" }),
        mk({ id: "2", displayName: "b", appType: "claude", parseError: "managed auth", apiKey: undefined, baseUrl: undefined }),
      ],
      config: {},
      headerRuleCount: 1,
    });
    const check = report.checks.find((c) => c.id === "tier-claude");
    expect(check).toBeDefined();
    expect(check?.detail).toContain("direct=1");
    expect(check?.detail).toContain("visible=1");
  });

  test("tier W2: app type with nothing switchable warns", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "sqlite3",
      providers: [
        mk({ id: "1", displayName: "o", appType: "openclaw", parseError: "managed auth", apiKey: undefined, baseUrl: undefined }),
      ],
      config: {},
      headerRuleCount: 1,
    });
    const check = report.checks.find((c) => c.id === "tier-openclaw");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("routed=1");
  });

  const KNOWN_COLS = [
    "id", "app_type", "name", "settings_config", "website_url", "category",
    "created_at", "sort_index", "notes", "icon", "icon_color", "meta",
    "is_current", "in_failover_queue", "cost_multiplier", "limit_daily_usd",
    "limit_monthly_usd", "provider_type",
  ];

  test("schema W1: windowed schema passes with facts", () => {
    const report = runDoctor({
      home: "/h", dbPath: "/db", dbExists: true, sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "codex" })],
      config: {}, headerRuleCount: 1,
      schemaCapabilities: {
        columns: KNOWN_COLS, hasCategory: true, hasProviderType: true,
        compositeId: true, userVersion: 16,
      },
    });
    const check = report.checks.find((c) => c.id === "schema");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("userVersion=16");
    expect(check?.detail).toContain("compositeId=true");
  });

  test("schema W1: newer-than-window user_version warns", () => {
    const report = runDoctor({
      home: "/h", dbPath: "/db", dbExists: true, sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "codex" })],
      config: {}, headerRuleCount: 1,
      schemaCapabilities: {
        columns: KNOWN_COLS, hasCategory: true, hasProviderType: true,
        compositeId: true, userVersion: 17,
      },
    });
    const check = report.checks.find((c) => c.id === "schema");
    expect(check?.status).toBe("warn");
    expect(check?.fix).toContain("upgrade pi-switch");
  });

  test("schema W1: older-than-window user_version warns with cc-switch upgrade", () => {
    const report = runDoctor({
      home: "/h", dbPath: "/db", dbExists: true, sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "codex" })],
      config: {}, headerRuleCount: 1,
      schemaCapabilities: {
        columns: KNOWN_COLS, hasCategory: false, hasProviderType: true,
        compositeId: false, userVersion: 9,
      },
    });
    const check = report.checks.find((c) => c.id === "schema");
    expect(check?.status).toBe("warn");
    expect(check?.fix).toContain("3.14.0");
  });

  test("schema W1: unknown column warns", () => {
    const report = runDoctor({
      home: "/h", dbPath: "/db", dbExists: true, sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "codex" })],
      config: {}, headerRuleCount: 1,
      schemaCapabilities: {
        columns: [...KNOWN_COLS, "mystery_col"], hasCategory: true,
        hasProviderType: true, compositeId: true, userVersion: 16,
      },
    });
    const check = report.checks.find((c) => c.id === "schema");
    expect(check?.status).toBe("warn");
    expect(check?.fix).toContain("mystery_col");
  });

  test("schema W1: failed probe on readable db warns with core-column fallback note", () => {
    const report = runDoctor({
      home: "/h", dbPath: "/db", dbExists: true, sqlite3Path: "sqlite3",
      providers: [mk({ id: "1", displayName: "a", appType: "codex" })],
      config: {}, headerRuleCount: 1,
      schemaCapabilities: undefined,
    });
    const check = report.checks.find((c) => c.id === "schema");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("probe failed");
  });

  test("en locale report contains no CJK characters", () => {
    const report = runDoctor({
      home: "/h",
      dbPath: "/db",
      dbExists: true,
      sqlite3Path: "/usr/bin/sqlite3",
      providers: [
        mk({ id: "1", displayName: "alpha", appType: "claude", configModels: ["glm-4.6"] }),
        mk({ id: "2", displayName: "o", appType: "openclaw", parseError: "managed auth", apiKey: undefined, baseUrl: undefined }),
      ],
      selection: { dbId: "1", model: "glm-4.6" },
      config: { defaultModelMeta: { reasoning: false } },
      headerRuleCount: 1,
      schemaCapabilities: {
        columns: KNOWN_COLS, hasCategory: true, hasProviderType: true,
        compositeId: true, userVersion: 16,
      },
      capabilities: {
        modelId: "glm-4.6",
        decision: capDecision({
          contextWindow: { value: 200000, source: "protocol-default" },
          maxTokens: { value: 64000, source: "user-override" },
          reasoning: { value: true, source: "user-override" },
          vision: { value: true, source: "protocol-default" },
          conflicts: [],
        }),
      },
      routingProbe: { url: "http://127.0.0.1:15721", reachable: false },
    });
    const text = formatDoctorReport(report);
    expect(text).not.toMatch(/[一-鿿]/);
  });
});

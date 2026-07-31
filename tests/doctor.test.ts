import { test, expect, describe } from "bun:test";
import { compareSemver } from "../src/settings.ts";
import { formatDoctorReport, runDoctor } from "../src/doctor.ts";
import type { CcProvider } from "../src/types.ts";

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
    expect(formatDoctorReport(report)).toContain("pass=");
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
    expect(detail).toContain("defaultModelMeta");
    expect(detail).toContain("provider");
    expect(detail).toContain("model[glm-4.6]");
    expect(report.checks.find((c) => c.id === "model-overrides")?.status).toBe("pass");
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
    expect(check?.fix).toContain("升级 Pi");
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
    expect(check?.detail).toContain("未探测到");
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
    expect(check?.fix).toContain("快照");
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
    expect(check?.detail).toContain("不可达");
    expect(check?.fix).toContain("代理");
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
        resolved: {
          contextWindow: { value: 200000, source: "protocol-default" },
          maxTokens: { value: 64000, source: "protocol-default" },
          reasoning: { value: true, source: "protocol-default" },
          vision: { value: true, source: "protocol-default" },
          conflicts: [],
        },
      },
    });
    const check = report.checks.find((c) => c.id === "capabilities");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("context=200000(protocol-default)");
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
        resolved: {
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
        },
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
        resolved: {
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
        },
      },
    });
    const check = report.checks.find((c) => c.id === "capabilities");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("过期");
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
});

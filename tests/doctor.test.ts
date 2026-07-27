import { test, expect, describe } from "bun:test";
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
});

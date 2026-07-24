import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import {
  fingerprintHeaderTemplates,
  isFingerprintPreset,
  resolveOverrideHeaders,
} from "../src/headers/fingerprints.ts";
import { mergeHeaders } from "../src/headers/merge.ts";
import { parseHeaderRulesFile } from "../src/headers/rules.ts";

function loadDefaults() {
  return parseHeaderRulesFile(JSON.parse(readFileSync("defaults/headers.json", "utf8")));
}

const baseVars = {
  claudeCodeVersion: "2.1.190",
  anthropicVersion: "2023-06-01",
  anthropicBeta: "claude-code-20250219",
  codexVersion: "0.1.0",
  osInfo: "Windows",
  codexOriginator: "codex_cli_rs",
  geminiVersion: "0.1.0",
};

describe("fingerprint presets", () => {
  test("isFingerprintPreset accepts known ids", () => {
    expect(isFingerprintPreset("claude-code")).toBe(true);
    expect(isFingerprintPreset("codex")).toBe(true);
    expect(isFingerprintPreset("gemini")).toBe(true);
    expect(isFingerprintPreset("none")).toBe(true);
    expect(isFingerprintPreset("nope")).toBe(false);
  });

  test("claude-code templates use external,cli UA", () => {
    const h = fingerprintHeaderTemplates("claude-code");
    expect(h["User-Agent"]).toBe("claude-cli/{claudeCodeVersion} (external, cli)");
    expect(h["anthropic-beta"]).toBe("{anthropicBeta}");
  });

  test("gemini templates include x-goog-api-client", () => {
    const h = fingerprintHeaderTemplates("gemini");
    expect(h["x-goog-api-client"]).toBe("gemini-cli/{geminiVersion}");
  });

  test("resolveOverrideHeaders: explicit headers win over preset", () => {
    const out = resolveOverrideHeaders({
      fingerprint: "codex",
      headers: { originator: "custom_originator" },
    });
    expect(out.headers?.originator).toBe("custom_originator");
    expect(out.headers?.["User-Agent"]).toContain("codex_cli_rs");
    expect(out.skipRules).toBeUndefined();
  });

  test("resolveOverrideHeaders: none yields skipRules and only explicit headers", () => {
    expect(resolveOverrideHeaders({ fingerprint: "none" })).toEqual({ skipRules: true });
    expect(
      resolveOverrideHeaders({ fingerprint: "none", headers: { "User-Agent": "x" } }),
    ).toEqual({ headers: { "User-Agent": "x" }, skipRules: true });
  });

  test("forced claude fingerprint works on openai-completions api via overrides", () => {
    const override = resolveOverrideHeaders({ fingerprint: "claude-code" });
    const out = mergeHeaders({
      api: "openai-completions",
      rules: loadDefaults(),
      overrideHeaders: override.headers,
      vars: baseVars,
    });
    // openai-completions would normally get codex UA; override forces claude.
    expect(out["User-Agent"]).toBe("claude-cli/2.1.190 (external, cli)");
    expect(out["anthropic-beta"]).toContain("claude-code-");
  });

  test("fingerprint none + default rules skips rule UA entirely", () => {
    const override = resolveOverrideHeaders({ fingerprint: "none" });
    const bare = mergeHeaders({
      api: "openai-completions",
      rules: loadDefaults(),
      overrideHeaders: override.headers,
      skipRules: override.skipRules,
      vars: baseVars,
    });
    expect(bare).toEqual({});

    const withExplicit = mergeHeaders({
      api: "anthropic-messages",
      rules: loadDefaults(),
      overrideHeaders: { "User-Agent": "custom-agent/1" },
      skipRules: true,
      vars: baseVars,
    });
    expect(withExplicit).toEqual({ "User-Agent": "custom-agent/1" });
    // Without skipRules, anthropic defaults would inject anthropic-version/beta too.
    const withRules = mergeHeaders({
      api: "anthropic-messages",
      rules: loadDefaults(),
      overrideHeaders: { "User-Agent": "custom-agent/1" },
      vars: baseVars,
    });
    expect(withRules["User-Agent"]).toBe("custom-agent/1");
    expect(withRules["anthropic-version"]).toBeTruthy();
  });
});

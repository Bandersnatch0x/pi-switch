import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { mergeHeaders, filterAllowlisted } from "../src/headers/merge.ts";
import { parseHeaderRulesFile } from "../src/headers/rules.ts";

/** Load the package default rules (defaults/headers.json) for integration checks. */
function loadDefaults() {
  return parseHeaderRulesFile(JSON.parse(readFileSync("defaults/headers.json", "utf8")));
}

describe("mergeHeaders allowlist", () => {
  test("keeps only allowlisted fields", () => {
    const rejected: string[] = [];
    const out = mergeHeaders({
      api: "anthropic-messages",
      rules: [
        {
          name: "claude-code",
          apis: ["anthropic-messages"],
          headers: {
            "User-Agent": "claude-cli/1.0",
            "anthropic-version": "2023-06-01",
            Authorization: "Bearer secret",
            "x-api-key": "nope",
          },
        },
      ],
      onReject: (n) => rejected.push(n),
    });
    expect(out["User-Agent"]).toBe("claude-cli/1.0");
    expect(out["anthropic-version"]).toBe("2023-06-01");
    expect(out["Authorization"]).toBeUndefined();
    expect(out["x-api-key"]).toBeUndefined();
    expect(rejected).toContain("Authorization");
    expect(rejected).toContain("x-api-key");
  });

  test("onReject reports reason + source for debug log", () => {
    const calls: Array<{ name: string; reason: string }> = [];
    mergeHeaders({
      api: "anthropic-messages",
      rules: [
        {
          name: "claude-code",
          apis: ["anthropic-messages"],
          headers: { "Proxy-Authorization": "evil", Host: "evil" },
        },
      ],
      overrideHeaders: { "x-goog-api-key": "evil" },
      onReject: (name, reason) => calls.push({ name, reason }),
    });
    // Each rejected header carries a reason string mentioning its source —
    // this is what the debug log surfaces to explain why a field was dropped.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((c) => c.reason.length > 0)).toBe(true);
    expect(calls.some((c) => c.name === "Proxy-Authorization")).toBe(true);
    // override-source rejection names its origin
    expect(calls.some((c) => c.reason.includes("providerOverrides"))).toBe(true);
  });

  test("providerOverrides win and filter", () => {
    const out = mergeHeaders({
      api: "openai-responses",
      rules: [
        {
          name: "codex-cli",
          apis: ["openai-responses"],
          headers: { "User-Agent": "from-rule", originator: "codex_cli_rs" },
        },
      ],
      overrideHeaders: {
        "User-Agent": "from-override",
        Authorization: "should-drop",
      },
    });
    expect(out["User-Agent"]).toBe("from-override");
    expect(out["originator"]).toBe("codex_cli_rs");
    expect(out["Authorization"]).toBeUndefined();
  });

  test("variable substitution", () => {
    const out = mergeHeaders({
      api: "openai-completions",
      rules: [
        {
          name: "codex",
          apis: ["openai-completions"],
          headers: { "User-Agent": "codex_cli_rs/{codexVersion} ({osInfo})" },
        },
      ],
      vars: { codexVersion: "0.1.0", osInfo: "Windows" },
    });
    expect(out["User-Agent"]).toBe("codex_cli_rs/0.1.0 (Windows)");
  });
});

describe("filterAllowlisted", () => {
  test("case insensitive", () => {
    const out = filterAllowlisted({
      "user-agent": "A",
      ORIGINATOR: "B",
      Host: "evil",
    });
    expect(out["User-Agent"]).toBe("A");
    expect(out["originator"]).toBe("B");
    expect(Object.keys(out)).toHaveLength(2);
  });
});

describe("parseHeaderRulesFile", () => {
  test("parses rules array", () => {
    const rules = parseHeaderRulesFile({
      rules: [{ name: "x", apis: ["anthropic-messages"], headers: { "User-Agent": "u" } }],
    });
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe("x");
  });
});

describe("default rules inject CLI fingerprints (UA + beta/originator)", () => {
  const vars = {
    codexVersion: "0.144.5",
    claudeCodeVersion: "2.1.190",
    geminiVersion: "0.1.0",
    osInfo: "Windows 10.0; x64",
    anthropicVersion: "2023-06-01",
    anthropicBeta: "claude-code-20250219,interleaved-thinking-2025-05-14",
    codexOriginator: "codex_cli_rs",
  };

  test("codex default injects User-Agent + originator", () => {
    const out = mergeHeaders({ api: "openai-responses", rules: loadDefaults(), vars });
    expect(Object.keys(out).sort()).toEqual(["User-Agent", "originator"]);
    expect(out["User-Agent"]).toContain("codex_cli_rs/0.144.5");
    expect(out["originator"]).toBe("codex_cli_rs");
  });

  test("claude default injects User-Agent + anthropic-version + anthropic-beta", () => {
    const out = mergeHeaders({ api: "anthropic-messages", rules: loadDefaults(), vars });
    expect(Object.keys(out).sort()).toEqual([
      "User-Agent",
      "anthropic-beta",
      "anthropic-version",
    ]);
    expect(out["anthropic-version"]).toBe("2023-06-01");
    expect(out["anthropic-beta"]).toContain("claude-code-20250219");
    expect(out["User-Agent"]).toBe("claude-cli/2.1.190 (external, cli)");
  });

  test("gemini default injects GeminiCLI User-Agent + x-goog-api-client", () => {
    const out = mergeHeaders({ api: "google-generative-ai", rules: loadDefaults(), vars });
    expect(Object.keys(out).sort()).toEqual(["User-Agent", "x-goog-api-client"]);
    expect(out["User-Agent"]).toContain("GeminiCLI/0.1.0");
    expect(out["x-goog-api-client"]).toBe("gemini-cli/0.1.0");
  });

  test("providerOverrides can still override fingerprint fields", () => {
    const out = mergeHeaders({
      api: "openai-responses",
      rules: loadDefaults(),
      vars,
      overrideHeaders: { originator: "custom_originator" },
    });
    expect(out["originator"]).toBe("custom_originator");
  });
});

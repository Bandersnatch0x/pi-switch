import { test, expect, describe } from "bun:test";
import { mergeHeaders, filterAllowlisted } from "../src/headers/merge.ts";
import { parseHeaderRulesFile } from "../src/headers/rules.ts";

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

import { test, expect, describe } from "bun:test";
import { deriveTier, summarizeTiers } from "../src/tier.ts";
import { MANAGED_AUTH_PARSE_ERROR } from "../src/parse/index.ts";
import type { CcProvider } from "../src/types.ts";

function mk(partial: Partial<CcProvider> & Pick<CcProvider, "appType" | "displayName">): CcProvider {
  return {
    id: "id-1",
    piName: "ps-x",
    api: "openai-responses",
    baseUrl: "https://x.example",
    apiKey: "k",
    authHeader: true,
    configModels: ["m1"],
    meta: {},
    isCurrentInCc: false,
    ...partial,
  };
}

describe("deriveTier (#14)", () => {
  test("switchable provider is direct", () => {
    expect(deriveTier(mk({ appType: "codex", displayName: "c" }))).toEqual({ tier: "direct" });
  });

  test("managed-auth parse error -> visible-only managed-auth", () => {
    const p = mk({ appType: "codex", displayName: "c", parseError: MANAGED_AUTH_PARSE_ERROR });
    expect(deriveTier(p)).toEqual({ tier: "visible-only", reason: "managed-auth" });
  });

  test("parse error with credentials -> visible-only parse-error", () => {
    const p = mk({ appType: "codex", displayName: "c", apiKey: "k", parseError: "missing baseUrl" });
    expect(deriveTier(p)).toEqual({ tier: "visible-only", reason: "parse-error" });
  });

  test("no credentials at all -> visible-only no-credentials", () => {
    const p = mk({ appType: "codex", displayName: "c", apiKey: undefined, baseUrl: undefined });
    expect(deriveTier(p)).toEqual({ tier: "visible-only", reason: "no-credentials" });
  });

  test("claude-desktop / openclaw visible-only -> routed-fallback (application-level)", () => {
    const p = mk({
      appType: "openclaw",
      displayName: "o",
      apiKey: undefined,
      baseUrl: undefined,
      parseError: MANAGED_AUTH_PARSE_ERROR,
    });
    expect(deriveTier(p)).toEqual({ tier: "routed-fallback", reason: "managed-auth" });
    // but a switchable claude-desktop entry is still direct
    const ok = mk({ appType: "claude-desktop", displayName: "cd" });
    expect(deriveTier(ok)).toEqual({ tier: "direct" });
  });

  test("summarizeTiers groups per app type with reason distribution", () => {
    const rows = summarizeTiers([
      mk({ appType: "codex", displayName: "a", id: "1" }),
      mk({ appType: "codex", displayName: "b", id: "2", parseError: MANAGED_AUTH_PARSE_ERROR }),
      mk({ appType: "claude", displayName: "c", id: "3" }),
    ]);
    expect(rows).toHaveLength(2);
    const codex = rows.find((r) => r.appType === "codex");
    expect(codex).toMatchObject({ total: 2, direct: 1, visible: 1 });
    expect(codex?.reasonDistribution).toEqual({ "managed-auth": 1 });
  });
});

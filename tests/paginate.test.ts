import { test, expect, describe } from "bun:test";
import { buildTabs, formatTabLabel } from "../src/ui/tabs.ts";
import { filterProviders, sortProviders } from "../src/ui/labels.ts";
import type { CcProvider } from "../src/types.ts";

function mk(partial: Partial<CcProvider> & Pick<CcProvider, "id" | "displayName" | "appType">): CcProvider {
  return {
    piName: `ps-${partial.appType}-${partial.id}`,
    api: "anthropic-messages",
    baseUrl: "https://example.com",
    apiKey: "k",
    authHeader: true,
    configModels: ["m"],
    meta: {},
    isCurrentInCc: false,
    ...partial,
  };
}

describe("tabs / labels", () => {
  test("buildTabs orders preferred then current", () => {
    const providers = [
      mk({ id: "1", displayName: "a", appType: "hermes" }),
      mk({ id: "2", displayName: "b", appType: "claude", isCurrentInCc: true }),
      mk({ id: "3", displayName: "c", appType: "codex" }),
    ];
    const tabs = buildTabs(providers, ["codex", "claude"]);
    expect(tabs.map((t) => t.appType)).toEqual(["codex", "claude", "hermes"]);
  });

  test("formatTabLabel is plain vertical list item", () => {
    const tabs = buildTabs(
      [
        mk({ id: "1", displayName: "a", appType: "claude" }),
        mk({ id: "2", displayName: "b", appType: "codex" }),
      ],
      ["claude", "codex"],
    );
    expect(formatTabLabel(tabs[0], true)).toBe("claude 1");
    expect(formatTabLabel(tabs[1], false)).toBe("codex 1");
  });

  test("sortProviders last-used by dbId first", () => {
    const ps = [
      mk({ id: "a", displayName: "alpha", appType: "claude" }),
      mk({ id: "b", displayName: "beta", appType: "claude" }),
    ];
    expect(sortProviders(ps, "b")[0].id).toBe("b");
  });

  test("sortProviders switchable before parseError", () => {
    const ps = [
      mk({ id: "1", displayName: "z-bad", appType: "claude", api: null, parseError: "x" }),
      mk({ id: "2", displayName: "a-good", appType: "claude" }),
    ];
    expect(sortProviders(ps).map((p) => p.id)).toEqual(["2", "1"]);
  });

  test("filterProviders searches host", () => {
    const ps = [
      mk({ id: "1", displayName: "x", appType: "claude", baseUrl: "https://sbai.shop/v1" }),
      mk({ id: "2", displayName: "y", appType: "claude", baseUrl: "https://other.com" }),
    ];
    expect(filterProviders(ps, "sbai")).toHaveLength(1);
  });

  test("filterProviders matches id and appType", () => {
    const ps = [
      mk({ id: "abc-123", displayName: "x", appType: "codex" }),
      mk({ id: "def-456", displayName: "y", appType: "claude" }),
    ];
    expect(filterProviders(ps, "abc-123")).toHaveLength(1);
    expect(filterProviders(ps, "codex")).toHaveLength(1);
  });
});

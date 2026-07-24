import { test, expect, describe } from "bun:test";
import {
  paginate,
  buildPageOptions,
  NAV_PREV,
  NAV_NEXT,
  SEARCH_LABEL,
} from "../src/ui/paginate.ts";
import { buildTabs } from "../src/ui/tabs.ts";
import { filterProviders, sortProviders, formatProviderLabel } from "../src/ui/labels.ts";
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

describe("paginate", () => {
  test("clamps page and slices", () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const r = paginate(items, 2, 10);
    expect(r.totalPages).toBe(3);
    expect(r.items).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(paginate(items, 99, 10).page).toBe(3);
  });

  test("empty", () => {
    expect(paginate([], 1, 12)).toEqual({ items: [], totalPages: 0, page: 1 });
  });
});

describe("buildPageOptions", () => {
  test("nav at boundaries", () => {
    const mid = buildPageOptions(["a"], 2, 3, 30, { includeSearch: true });
    expect(mid.options).toContain(NAV_PREV);
    expect(mid.options).toContain(NAV_NEXT);
    expect(mid.options).toContain(SEARCH_LABEL);

    const first = buildPageOptions(["a"], 1, 3, 30);
    expect(first.options).not.toContain(NAV_PREV);
    expect(first.options).toContain(NAV_NEXT);
  });
});

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

  test("sortProviders last-used by dbId first", () => {
    const ps = [
      mk({ id: "a", displayName: "alpha", appType: "claude" }),
      mk({ id: "b", displayName: "beta", appType: "claude" }),
    ];
    expect(sortProviders(ps, "b")[0].id).toBe("b");
  });

  test("filterProviders searches host", () => {
    const ps = [
      mk({ id: "1", displayName: "x", appType: "claude", baseUrl: "https://sbai.shop/v1" }),
      mk({ id: "2", displayName: "y", appType: "claude", baseUrl: "https://other.com" }),
    ];
    expect(filterProviders(ps, "sbai")).toHaveLength(1);
  });

  test("format shows parseError", () => {
    const p = mk({
      id: "1",
      displayName: "bad",
      appType: "claude",
      api: null,
      parseError: "missing endpoint",
    });
    expect(formatProviderLabel(p, { piActive: false, isLastUsed: false })).toContain(
      "不可切换: missing endpoint",
    );
  });
});

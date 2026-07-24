import { test, expect, describe } from "bun:test";
import { buildTabs } from "../src/ui/tabs.ts";
import { sortProviders } from "../src/ui/labels.ts";
import type { CcProvider } from "../src/types.ts";
import { isSwitchable } from "../src/parse/index.ts";

function mk(
  partial: Partial<CcProvider> & Pick<CcProvider, "id" | "displayName" | "appType">,
): CcProvider {
  return {
    piName: `ps-${partial.appType}-${partial.id}`,
    api: "anthropic-messages",
    baseUrl: "https://example.com",
    apiKey: "k",
    authHeader: true,
    configModels: ["m1", "m2"],
    meta: {},
    isCurrentInCc: false,
    ...partial,
  };
}

describe("three-level data wiring", () => {
  test("types / names / models cascade", () => {
    const providers = [
      mk({ id: "1", displayName: "alpha", appType: "claude", configModels: ["c1"] }),
      mk({ id: "2", displayName: "beta", appType: "claude", configModels: ["c2"] }),
      mk({ id: "3", displayName: "sbai", appType: "codex", api: "openai-responses", configModels: ["g1"] }),
    ];
    const tabs = buildTabs(providers, ["claude", "codex"]);
    expect(tabs.map((t) => t.appType)).toEqual(["claude", "codex"]);
    expect(tabs[0].count).toBe(2);

    const names = sortProviders(providers.filter((p) => p.appType === "claude"));
    expect(names.map((p) => p.displayName)).toEqual(["alpha", "beta"]);
    expect(names[0].configModels).toEqual(["c1"]);
    expect(isSwitchable(names[0])).toBe(true);
  });
});

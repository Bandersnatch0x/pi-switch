import { test, expect, describe } from "bun:test";
import { buildTabs } from "../src/ui/tabs.ts";
import { sortProviders } from "../src/ui/labels.ts";
import type { CcProvider } from "../src/types.ts";
import { isSwitchable } from "../src/parse/index.ts";
import {
  formatFooterHints,
  threeLevelPick,
} from "../src/ui/three-level-pick.ts";
import type { PiSwitchCtx } from "../src/pi-context.ts";

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

  test("RPC mode skips custom UI and uses select fallback", async () => {
    let customCalls = 0;
    let selectCalls = 0;
    const ctx = {
      mode: "rpc",
      ui: {
        custom: async () => {
          customCalls += 1;
          return undefined;
        },
        select: async () => {
          selectCalls += 1;
          return undefined;
        },
      },
    } as unknown as PiSwitchCtx;

    const result = await threeLevelPick(ctx, {
      providers: [
        mk({ id: "1", displayName: "alpha", appType: "claude" }),
      ],
    });

    expect(result).toEqual({ kind: "cancel" });
    expect(customCalls).toBe(0);
    expect(selectCalls).toBe(1);
  });
});

describe("formatFooterHints override key", () => {
  test("shows o override when name column revealed", () => {
    const s = formatFooterHints(undefined, { revealed: 1, col: 1 });
    expect(s).toContain("o");
    expect(s).toContain("override");
  });

  test("hides o override on type-only view", () => {
    const s = formatFooterHints(undefined, { revealed: 0, col: 0 });
    expect(s).not.toContain("override");
  });

  test("shows p pin when model column revealed", () => {
    const s = formatFooterHints(undefined, { revealed: 2, col: 2 });
    expect(s).toContain("p");
    expect(s).toContain("pin");
  });

  test("hides p pin before model column", () => {
    const s = formatFooterHints(undefined, { revealed: 1, col: 1 });
    expect(s).not.toContain("pin");
  });
});

describe("sortProviders pin preference", () => {
  test("pinned providers float above others (after lastUsed)", () => {
    const providers = [
      mk({ id: "1", displayName: "alpha", appType: "claude" }),
      mk({ id: "2", displayName: "beta", appType: "claude" }),
      mk({ id: "3", displayName: "gamma", appType: "claude" }),
    ];
    const sorted = sortProviders(providers, "1", ["3"]);
    expect(sorted.map((p) => p.id)).toEqual(["1", "3", "2"]);
  });
});

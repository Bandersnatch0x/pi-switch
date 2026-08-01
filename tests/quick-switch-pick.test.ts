import { test, expect, describe } from "bun:test";
import { buildQuickPickerState, quickPickerFooter } from "../src/ui/quick-switch-pick.ts";
import type { CcProvider, PinEntry, RecentEntry } from "../src/types.ts";

function mk(
  partial: Partial<CcProvider> & Pick<CcProvider, "id" | "displayName" | "appType">,
): CcProvider {
  return {
    piName: `ps-${partial.appType}-${partial.id}`,
    api: "openai-responses",
    baseUrl: "https://example.com",
    apiKey: "k",
    authHeader: true,
    configModels: ["m1"],
    meta: {},
    isCurrentInCc: false,
    ...partial,
  };
}

const providers = [
  mk({ id: "a", displayName: "alpha", appType: "codex" }),
  mk({ id: "b", displayName: "beta", appType: "claude", api: "anthropic-messages" }),
];

describe("quickSwitchPick helpers", () => {
  test("buildQuickPickerState: pins first, idx clamped on rebuild", () => {
    const pins: PinEntry[] = [{ dbId: "a", model: "m1", appType: "codex" }];
    const recent: RecentEntry[] = [{ dbId: "b", model: "r1", at: 1, appType: "claude" }];
    const s = buildQuickPickerState(pins, recent, providers);
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0].pinned).toBe(true);
    expect(s.idx).toBe(0);

    // Rebuild after a pin is removed: idx clamps into the smaller list.
    const s2 = buildQuickPickerState([], recent, providers, { ...s, idx: 1 });
    expect(s2.entries).toHaveLength(1);
    expect(s2.idx).toBe(0);
  });

  test("quickPickerFooter mentions pin/取消 and enter and esc", () => {
    const f = quickPickerFooter();
    expect(f).toContain("pin/取消");
    expect(f).toContain("切换");
    expect(f).toContain("退出");
  });
});

import { test, expect, describe } from "bun:test";
import {
  buildQuickPickerState,
  quickPickerFooter,
  quickSwitchPick,
} from "../src/ui/quick-switch-pick.ts";
import { togglePinEntry } from "../src/settings.ts";
import type { PiSwitchCtx } from "../src/pi-context.ts";
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

const ESC = "\x1b";

/** Drives the custom TUI like three-level.test.ts: queued keys, tiny tick waits. */
function tuiCtx(notifications: string[]) {
  const pending: string[][] = [];
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: any) => {
        let resolve!: (r: any) => void;
        const p = new Promise<any>((res) => (resolve = res));
        const comp = factory(
          { requestRender() {} },
          { fg: (_c: string, s: string) => s, bold: (s: string) => s },
          {},
          (r: any) => resolve(r),
        );
        for (const keys of pending.splice(0)) {
          for (const k of keys) {
            comp.handleInput(k);
            await new Promise((r) => setTimeout(r, 2));
          }
        }
        return p;
      },
      notify: (m: string) => notifications.push(m),
      setStatus() {},
      select: async () => undefined,
    },
  } as unknown as PiSwitchCtx;
  return {
    ctx,
    drive: async (keys: string[]) => {
      pending.push(keys);
    },
  };
}

describe("quickSwitchPick pin toggle (custom TUI)", () => {
  test("unpin uses the stored pin identity, not the resolved provider's", async () => {
    // Regression: pin stored as codex, but the snapshot only has this dbId
    // under claude (provider re-tagged/re-added). The row renders via the
    // dbId fallback; toggling with the provider identity misses sameEntry
    // and silently ADDS a duplicate — the ★ can never be removed.
    const providers = [
      mk({ id: "a", displayName: "alpha", appType: "claude", api: "anthropic-messages" }),
    ];
    let pins: PinEntry[] = [{ dbId: "a", model: "m1", appType: "codex" }];
    const toggles: PinEntry[] = [];
    const notifications: string[] = [];
    const h = tuiCtx(notifications);
    await h.drive(["p", ESC]);

    const result = await quickSwitchPick(h.ctx, {
      providers,
      pins,
      recent: [],
      onTogglePin: (entry) => {
        toggles.push(entry);
        pins = togglePinEntry(pins, entry).pins;
        return pins;
      },
      onPick: async () => {},
    });

    expect(result.kind).toBe("cancel");
    expect(toggles).toHaveLength(1);
    expect(toggles[0]).toMatchObject({ dbId: "a", model: "m1", appType: "codex" });
    expect(pins).toEqual([]); // actually unpinned, no duplicate added
    expect(notifications.join("\n")).toContain("已取消 pin");
  });

  test("legacy appType-less pin unpin takes the provider appType and heals twins", async () => {
    const providers = [
      mk({ id: "a", displayName: "alpha", appType: "claude", api: "anthropic-messages" }),
    ];
    // Old appType-stripping state: one legacy pin plus a migrated twin.
    let pins: PinEntry[] = [
      { dbId: "a", model: "m1" },
      { dbId: "a", model: "m1", appType: "claude" },
    ];
    const toggles: PinEntry[] = [];
    const notifications: string[] = [];
    const h = tuiCtx(notifications);
    await h.drive(["p", ESC]);

    const result = await quickSwitchPick(h.ctx, {
      providers,
      pins,
      recent: [],
      onTogglePin: (entry) => {
        toggles.push(entry);
        pins = togglePinEntry(pins, entry).pins;
        return pins;
      },
      onPick: async () => {},
    });

    expect(result.kind).toBe("cancel");
    expect(toggles[0].appType).toBe("claude"); // provider appType claims both twins
    expect(pins).toEqual([]);
    expect(notifications.join("\n")).toContain("已取消 pin");
  });

  test("pinning a recent row uses the resolved provider identity", async () => {
    const providers = [
      mk({ id: "b", displayName: "beta", appType: "codex", api: "openai-responses" }),
    ];
    let pins: PinEntry[] = [];
    const recent: RecentEntry[] = [{ dbId: "b", model: "r1", at: 1 }];
    const toggles: PinEntry[] = [];
    const notifications: string[] = [];
    const h = tuiCtx(notifications);
    await h.drive(["p", ESC]);

    const result = await quickSwitchPick(h.ctx, {
      providers,
      pins,
      recent,
      onTogglePin: (entry) => {
        toggles.push(entry);
        pins = togglePinEntry(pins, entry).pins;
        return pins;
      },
      onPick: async () => {},
    });

    expect(result.kind).toBe("cancel");
    expect(toggles).toEqual([
      { dbId: "b", model: "r1", appType: "codex", label: "beta · r1" },
    ]);
    expect(pins).toEqual([{ dbId: "b", model: "r1", appType: "codex", label: "beta · r1" }]);
    expect(notifications.join("\n")).toContain("已 pin");
  });
});

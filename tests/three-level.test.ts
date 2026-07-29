import { test, expect, describe } from "bun:test";
import { buildTabs } from "../src/ui/tabs.ts";
import { sortProviders } from "../src/ui/labels.ts";
import type { CcProvider } from "../src/types.ts";
import { isSwitchable } from "../src/parse/index.ts";
import {
  formatFooterHints,
  formatManualFooterHints,
  formatSearchFooterHints,
  popPickerLevel,
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

describe("popPickerLevel (Esc stack)", () => {
  test("pops model → name → type-only → exit", () => {
    expect(popPickerLevel({ revealed: 2, col: 2 })).toEqual({
      revealed: 1,
      col: 1,
      exit: false,
    });
    expect(popPickerLevel({ revealed: 2, col: 0 })).toEqual({
      revealed: 1,
      col: 0,
      exit: false,
    });
    expect(popPickerLevel({ revealed: 1, col: 1 })).toEqual({
      revealed: 0,
      col: 0,
      exit: false,
    });
    expect(popPickerLevel({ revealed: 0, col: 0 })).toEqual({
      revealed: 0,
      col: 0,
      exit: true,
    });
  });
});

describe("formatFooterHints override key", () => {
  test("shows o override when name column revealed", () => {
    const s = formatFooterHints(undefined, { revealed: 1, col: 1 });
    expect(s).toContain("o");
    expect(s).toContain("override");
  });

  test("esc hint is 返回 when revealed, 退出 at root", () => {
    expect(formatFooterHints(undefined, { revealed: 0, col: 0 })).toContain("esc 退出");
    expect(formatFooterHints(undefined, { revealed: 1, col: 1 })).toContain("esc 返回");
    expect(formatFooterHints(undefined, { revealed: 2, col: 2 })).toContain("esc 返回");
    expect(formatFooterHints(undefined, { revealed: 2, col: 2 })).not.toContain("esc cancel");
  });

  test("search mode footer is distinct from nav footer", () => {
    const s = formatSearchFooterHints(undefined);
    expect(s).toContain("enter 确认");
    expect(s).toContain("esc 取消搜索");
    expect(s).not.toContain("esc 退出");
  });

  test("manual mode footer is distinct", () => {
    const s = formatManualFooterHints(undefined);
    expect(s).toContain("enter 切换");
    expect(s).toContain("esc 取消");
    expect(s).toContain("model id");
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

describe("remoteCache survives picker reopen (o-override loop)", () => {
  const ENTER = "\r";
  const ESC = "\x1b";

  function tuiCtx(): { ctx: PiSwitchCtx; drive: (keys: string[]) => Promise<void> } {
    let comp: any;
    const pending: string[][] = [];
    const ctx = {
      mode: "tui",
      ui: {
        custom: async (factory: any) => {
          let resolve!: (r: any) => void;
          const p = new Promise<any>((res) => (resolve = res));
          comp = factory(
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
        notify() {},
        setStatus() {},
        select: async () => undefined,
        input: async () => undefined,
      },
    } as unknown as PiSwitchCtx;
    return {
      ctx,
      drive: async (keys: string[]) => {
        pending.push(keys);
      },
    };
  }

  test("fetched models persist into a reopened picker via shared cache", async () => {
    const provider = mk({ id: "p1", displayName: "alpha", appType: "claude", configModels: ["c1"] });
    const cache = new Map<string, string[]>();
    let fetchCalls = 0;

    // --- first open: expand to model column, press f (fetch), then esc out ---
    const first = tuiCtx();
    await first.drive([ENTER, ENTER, "f", ESC, ESC, ESC]);
    const r1 = await threeLevelPick(first.ctx, {
      providers: [provider],
      remoteCache: cache,
      fetchRemote: async () => {
        fetchCalls += 1;
        return ["remote-1"];
      },
    });
    expect(r1.kind).toBe("cancel");
    expect(fetchCalls).toBe(1);
    expect(cache.get("p1")).toEqual(["remote-1"]);

    // --- second open with the SAME cache: model list already contains remote-1 ---
    const second = tuiCtx();
    let sawRemote = false;
    const ctx2 = second.ctx as any;
    const origCustom = ctx2.ui.custom.bind(ctx2.ui);
    ctx2.ui.custom = async (factory: any) => {
      let resolve!: (r: any) => void;
      const p = new Promise<any>((res) => (resolve = res));
      const comp = factory(
        { requestRender() {} },
        { fg: (_c: string, s: string) => s, bold: (s: string) => s },
        {},
        (r: any) => resolve(r),
      );
      for (const k of [ENTER, ENTER]) {
        comp.handleInput(k);
        await new Promise((r) => setTimeout(r, 2));
      }
      sawRemote = comp.render(100).join("\n").includes("remote-1");
      for (const k of [ESC, ESC, ESC]) {
        comp.handleInput(k);
        await new Promise((r) => setTimeout(r, 2));
      }
      return p;
    };
    const r2 = await threeLevelPick(second.ctx, {
      providers: [provider],
      remoteCache: cache,
      fetchRemote: async () => {
        fetchCalls += 1;
        return ["should-not-be-called"];
      },
    });
    expect(r2.kind).toBe("cancel");
    expect(fetchCalls).toBe(1);
    expect(sawRemote).toBe(true);
  });
});

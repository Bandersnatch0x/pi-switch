import { test, expect, describe } from "bun:test";
import { buildQuickEntries } from "../src/ui/quick-pick.ts";
import { runQuickSwitch } from "../extensions/commands.ts";
import type { CcProvider, PinEntry, RecentEntry } from "../src/types.ts";

function mk(
  partial: Partial<CcProvider> & Pick<CcProvider, "id" | "displayName" | "appType">,
): CcProvider {
  return {
    piName: `ps-${partial.appType}-${partial.id}`,
    api: "anthropic-messages",
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
  mk({ id: "a", displayName: "alpha", appType: "claude" }),
  mk({ id: "b", displayName: "beta", appType: "codex", api: "openai-responses" }),
  mk({ id: "dead", displayName: "broken", appType: "claude", api: null, parseError: "x" }),
];

describe("buildQuickEntries", () => {
  test("pins first with *, then recent by time desc, deduped", () => {
    const pins: PinEntry[] = [{ dbId: "a", model: "gpt-5" }];
    const recent: RecentEntry[] = [
      { dbId: "b", model: "r-old", at: 100 },
      { dbId: "b", model: "r-new", at: 200 },
      { dbId: "a", model: "gpt-5", at: 300 }, // dup of pin → dropped
    ];
    const entries = buildQuickEntries(pins, recent, providers);
    expect(entries.map((e) => `${e.provider.id}:${e.modelId}`)).toEqual([
      "a:gpt-5",
      "b:r-new",
      "b:r-old",
    ]);
    expect(entries[0].pinned).toBe(true);
    expect(entries[0].label).toBe("* C claude/alpha · gpt-5");
    expect(entries[1].label).toBe("  O codex/beta · r-new");
  });

  test("filters stale dbIds and unswitchable providers", () => {
    const pins: PinEntry[] = [
      { dbId: "gone", model: "m" },
      { dbId: "dead", model: "m" },
      { dbId: "a", model: "ok" },
    ];
    const entries = buildQuickEntries(pins, [], providers);
    expect(entries.map((e) => e.modelId)).toEqual(["ok"]);
  });

  test("caps the list at 10 entries", () => {
    const recent: RecentEntry[] = Array.from({ length: 15 }, (_, i) => ({
      dbId: "a",
      model: `m${i}`,
      at: i,
    }));
    const entries = buildQuickEntries([], recent, providers);
    expect(entries.length).toBe(10);
  });

  test("composite identity: same dbId across app types stays distinct", () => {
    const shared = [
      mk({ id: "dup", displayName: "one", appType: "codex", api: "openai-responses" }),
      mk({ id: "dup", displayName: "two", appType: "claude" }),
    ];
    const pins: PinEntry[] = [
      { dbId: "dup", model: "gpt-5", appType: "codex" },
      { dbId: "dup", model: "gpt-5", appType: "claude" },
    ];
    const entries = buildQuickEntries(pins, [], shared);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.provider.appType).sort()).toEqual(["claude", "codex"]);
    expect(entries.every((e) => e.pinned)).toBe(true);
  });

  test("legacy pins without appType still resolve via dbId fallback", () => {
    const pins: PinEntry[] = [{ dbId: "a", model: "gpt-5" }]; // pre-migration
    const entries = buildQuickEntries(pins, [], providers);
    expect(entries).toHaveLength(1);
    expect(entries[0].provider.id).toBe("a");
    expect(entries[0].pinned).toBe(true);
  });
});

describe("runQuickSwitch", () => {
  function makeDeps(pins: PinEntry[], recent: RecentEntry[]) {
    const notifications: string[] = [];
    const activations: Array<{ id: string; model: string; commit: string }> = [];
    let selectOptions: string[] | undefined;
    let selectAnswer: string | undefined;
    const rt = {
      reloadConfig() {},
      refreshSnapshot: () => ({ providers, error: undefined }),
      config: { pins, recent },
      modelMetaFor: () => ({}),
    };
    const lifecycle = {
      install() {},
      activate: async (t: { provider: CcProvider; modelId: string; commit: string }) => {
        activations.push({ id: t.provider.id, model: t.modelId, commit: t.commit });
        return {
          kind: "activated",
          stages: {
            providerRegistration: { status: "succeeded" },
            modelSwitch: { status: "succeeded" },
            providerCleanup: { status: "succeeded" },
            selectionPersistence: { status: "succeeded" },
            recentPersistence: { status: "succeeded" },
          },
        } as const;
      },
    };
    const ctx = {
      mode: "tui",
      ui: {
        notify: (m: string) => notifications.push(m),
        select: async (_t: string, options: string[]) => {
          selectOptions = options;
          return selectAnswer;
        },
        setStatus() {},
      },
    };
    return {
      rt,
      lifecycle,
      ctx,
      notifications,
      activations,
      answer: (a: string | undefined) => (selectAnswer = a),
      options: () => selectOptions,
    };
  }

  test("empty pins/recent → warns and never opens select", async () => {
    const d = makeDeps([], []);
    await runQuickSwitch(d.rt as never, d.lifecycle as never, d.ctx as never);
    expect(d.notifications.join("\n")).toContain("/ps-config");
    expect(d.options()).toBeUndefined();
    expect(d.activations).toEqual([]);
  });

  test("picking an entry activates provider+model with selection commit", async () => {
    const d = makeDeps([{ dbId: "a", model: "gpt-5" }], [{ dbId: "b", model: "r1", at: 1 }]);
    d.answer("  O codex/beta · r1");
    await runQuickSwitch(d.rt as never, d.lifecycle as never, d.ctx as never);
    expect(d.activations).toEqual([{ id: "b", model: "r1", commit: "selection" }]);
  });

  test("cancelling the select activates nothing", async () => {
    const d = makeDeps([{ dbId: "a", model: "gpt-5" }], []);
    d.answer(undefined);
    await runQuickSwitch(d.rt as never, d.lifecycle as never, d.ctx as never);
    expect(d.activations).toEqual([]);
  });
});

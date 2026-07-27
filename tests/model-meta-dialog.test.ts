import { test, expect, describe } from "bun:test";
import {
  formatCount,
  parseCount,
  runModelMetaDialog,
  type ModelMetaDialogInput,
} from "../src/ui/model-meta-dialog.ts";

const provider = { id: "abc", displayName: "elysiver-claude", piName: "elysiver-claude" };

/**
 * Scripted UI: each select() call receives the option list; the script picks by
 * predicate so tests stay readable and do not hardcode full label strings.
 */
function scriptedUi(
  picks: ((options: string[], title: string) => string | null)[],
  opts?: {
    inputs?: (string | null)[];
    confirm?: boolean;
    onSelect?: (title: string, options: string[]) => void;
  },
) {
  const inputs = [...(opts?.inputs ?? [])];
  const notes: string[] = [];
  return {
    notes,
    ui: {
      select: async (title: string, options: string[]) => {
        opts?.onSelect?.(title, options);
        const next = picks.shift();
        return next ? next(options, title) : null;
      },
      input: async () => (inputs.length ? inputs.shift() ?? null : null),
      confirm: async () => opts?.confirm ?? false,
      notify: (m: string) => notes.push(m),
    },
  };
}

const find = (re: RegExp) => (options: string[]) => options.find((o) => re.test(o)) ?? null;

function baseInput(over?: Partial<ModelMetaDialogInput>): ModelMetaDialogInput {
  return {
    provider,
    scope: { kind: "provider" },
    tier: { reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
    models: ["glm-4.6", "claude-sonnet-4"],
    ...over,
  };
}

describe("count parsing / formatting", () => {
  test("formatCount compacts round values", () => {
    expect(formatCount(1_000_000)).toBe("1M");
    expect(formatCount(128_000)).toBe("128k");
    expect(formatCount(4_096)).toBe("4096");
  });

  test("parseCount accepts k/M suffix and separators", () => {
    expect(parseCount("200k")).toBe(200_000);
    expect(parseCount("1M")).toBe(1_000_000);
    expect(parseCount("1_000_000")).toBe(1_000_000);
    expect(parseCount("1,000,000")).toBe(1_000_000);
    expect(parseCount("200000")).toBe(200_000);
  });

  test("parseCount rejects junk and empty", () => {
    expect(parseCount("")).toBeUndefined();
    expect(parseCount("   ")).toBeUndefined();
    expect(Number.isNaN(parseCount("abc") as number)).toBe(true);
    expect(Number.isNaN(parseCount("-5") as number)).toBe(true);
    expect(Number.isNaN(parseCount("0") as number)).toBe(true);
  });
});

describe("runModelMetaDialog · provider scope", () => {
  test("reasoning=false then save", async () => {
    const { ui } = scriptedUi([
      find(/^reasoning · /),
      find(/^false · /),
      find(/^保存/),
    ]);
    const result = await runModelMetaDialog(ui, baseInput());
    expect(result).toEqual({
      kind: "save",
      scope: { kind: "provider" },
      modelMeta: { reasoning: false },
    });
  });

  test("save with no change returns cancel", async () => {
    const { ui, notes } = scriptedUi([find(/^保存/)]);
    const result = await runModelMetaDialog(
      ui,
      baseInput({ providerMeta: { reasoning: false } }),
    );
    expect(result).toEqual({ kind: "cancel" });
    expect(notes).toContain("无改动");
  });

  test("preset submenu applies relay-safe", async () => {
    const { ui } = scriptedUi([
      find(/^预设 · /),
      find(/^中转兼容/),
      find(/^保存/),
    ]);
    const result = await runModelMetaDialog(ui, baseInput());
    expect(result).toEqual({
      kind: "save",
      scope: { kind: "provider" },
      modelMeta: { reasoning: false },
    });
  });

  test("contextWindow quick pick", async () => {
    const { ui } = scriptedUi([
      find(/^contextWindow · /),
      find(/^1M · /),
      find(/^保存/),
    ]);
    const result = await runModelMetaDialog(ui, baseInput());
    expect(result).toEqual({
      kind: "save",
      scope: { kind: "provider" },
      modelMeta: { contextWindow: 1_000_000 },
    });
  });

  test("contextWindow custom input accepts 250k", async () => {
    const { ui } = scriptedUi(
      [find(/^contextWindow · /), find(/^✎ 自定义/), find(/^保存/)],
      { inputs: ["250k"] },
    );
    const result = await runModelMetaDialog(ui, baseInput());
    expect(result).toEqual({
      kind: "save",
      scope: { kind: "provider" },
      modelMeta: { contextWindow: 250_000 },
    });
  });

  test("invalid custom input warns and keeps draft clean", async () => {
    const { ui, notes } = scriptedUi(
      [find(/^maxTokens · /), find(/^✎ 自定义/), find(/^取消$/)],
      { inputs: ["nope"] },
    );
    const result = await runModelMetaDialog(ui, baseInput());
    expect(result).toEqual({ kind: "cancel" });
    expect(notes.some((n) => n.includes("正整数"))).toBe(true);
  });

  test("thinkingFormat is an enum pick", async () => {
    const { ui } = scriptedUi([
      find(/^thinkingFormat · /),
      (options) => options.find((o) => o === "deepseek") ?? null,
      find(/^保存/),
    ]);
    const result = await runModelMetaDialog(ui, baseInput());
    expect(result).toEqual({
      kind: "save",
      scope: { kind: "provider" },
      modelMeta: { thinkingFormat: "deepseek" },
    });
  });

  test("clear current layer", async () => {
    const { ui } = scriptedUi([find(/^清除本层覆写/)], { confirm: true });
    const result = await runModelMetaDialog(
      ui,
      baseInput({ providerMeta: { reasoning: false } }),
    );
    expect(result).toEqual({ kind: "clear", scope: { kind: "provider" } });
  });

  test("clear all overrides", async () => {
    const { ui } = scriptedUi([find(/^清除该 Provider 全部覆写/)], { confirm: true });
    const result = await runModelMetaDialog(
      ui,
      baseInput({
        providerMeta: { reasoning: false },
        modelOverrides: { "glm-4.6": { maxTokens: 8_192 } },
      }),
    );
    expect(result).toEqual({ kind: "clearAll" });
  });

  test("esc with clean draft cancels", async () => {
    const { ui } = scriptedUi([() => null]);
    const result = await runModelMetaDialog(ui, baseInput());
    expect(result).toEqual({ kind: "cancel" });
  });

  test("esc with dirty draft requires confirm", async () => {
    // reasoning=false makes it dirty; first esc is declined (confirm=false),
    // second pass cancels via 取消 after confirm flips true.
    let confirmValue = false;
    const ui = {
      select: async (_t: string, options: string[]) => {
        const queue = picks.shift();
        return queue ? queue(options) : null;
      },
      input: async () => null,
      confirm: async () => confirmValue,
      notify: () => {},
    };
    const picks: ((o: string[]) => string | null)[] = [
      find(/^reasoning · /),
      find(/^false · /),
      () => null, // esc → confirm false → stays open
      (o) => {
        confirmValue = true;
        return o.find((x) => /^取消$/.test(x)) ?? null;
      },
    ];
    const result = await runModelMetaDialog(ui, baseInput());
    expect(result).toEqual({ kind: "cancel" });
  });
});

describe("runModelMetaDialog · model scope", () => {
  test("model scope save writes model scope result", async () => {
    const { ui } = scriptedUi([find(/^maxTokens · /), find(/^16k · /), find(/^保存/)]);
    const result = await runModelMetaDialog(
      ui,
      baseInput({ scope: { kind: "model", modelId: "glm-4.6" } }),
    );
    expect(result).toEqual({
      kind: "save",
      scope: { kind: "model", modelId: "glm-4.6" },
      modelMeta: { maxTokens: 16_000 },
    });
  });

  test("rows show inherited provider value at model scope", async () => {
    const seen: string[][] = [];
    const { ui } = scriptedUi([() => null], {
      onSelect: (_t, options) => seen.push(options),
    });
    await runModelMetaDialog(
      ui,
      baseInput({
        scope: { kind: "model", modelId: "glm-4.6" },
        providerMeta: { reasoning: false },
      }),
    );
    const rows = seen[0] ?? [];
    expect(rows.some((r) => r.startsWith("reasoning · 继承 false"))).toBe(true);
    // no layer sets maxTokens → tier default shown
    expect(rows.some((r) => r.startsWith("maxTokens · 默认 64k"))).toBe(true);
  });

  test("scope switch from provider to model", async () => {
    const { ui } = scriptedUi([
      find(/^作用域 · /),
      (options) => options.find((o) => o.startsWith("claude-sonnet-4")) ?? null,
      find(/^reasoning · /),
      find(/^true · /),
      find(/^保存/),
    ]);
    const result = await runModelMetaDialog(ui, baseInput());
    expect(result).toEqual({
      kind: "save",
      scope: { kind: "model", modelId: "claude-sonnet-4" },
      modelMeta: { reasoning: true },
    });
  });

  test("scope list marks models that already have overrides", async () => {
    const seen: string[][] = [];
    const { ui } = scriptedUi([find(/^作用域 · /), () => null], {
      onSelect: (_t, options) => seen.push(options),
    });
    await runModelMetaDialog(
      ui,
      baseInput({ modelOverrides: { "glm-4.6": { reasoning: false } } }),
    );
    const scopeRows = seen[1] ?? [];
    expect(scopeRows.some((r) => r.startsWith("glm-4.6") && r.includes("⚙"))).toBe(true);
    expect(scopeRows.some((r) => r.startsWith("claude-sonnet-4") && !r.includes("⚙"))).toBe(
      true,
    );
  });

  test("manual glob scope via input", async () => {
    const { ui } = scriptedUi(
      [
        find(/^作用域 · /),
        find(/^✎ 手动输入/),
        find(/^reasoning · /),
        find(/^false · /),
        find(/^保存/),
      ],
      { inputs: ["gpt-5*"] },
    );
    const result = await runModelMetaDialog(ui, baseInput());
    expect(result).toEqual({
      kind: "save",
      scope: { kind: "model", modelId: "gpt-5*" },
      modelMeta: { reasoning: false },
    });
  });

  test("existing model override loads as draft and 不覆写 clears it", async () => {
    const { ui } = scriptedUi([
      find(/^reasoning · 覆写 false/),
      find(/^不覆写/),
      find(/^保存/),
    ]);
    const result = await runModelMetaDialog(
      ui,
      baseInput({
        scope: { kind: "model", modelId: "glm-4.6" },
        modelOverrides: { "glm-4.6": { reasoning: false } },
      }),
    );
    // draft became empty → clear that scope
    expect(result).toEqual({ kind: "clear", scope: { kind: "model", modelId: "glm-4.6" } });
  });
});

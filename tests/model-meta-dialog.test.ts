import { test, expect, describe } from "bun:test";
import { runModelMetaDialog } from "../src/ui/model-meta-dialog.ts";

describe("runModelMetaDialog", () => {
  test("save reasoning false via select loop", async () => {
    const queue = [
      "reasoning · 默认",
      "false",
      "保存",
    ];
    const ui = {
      select: async (_title: string, _opts: string[]) => queue.shift() ?? null,
      input: async () => null,
      confirm: async () => false,
      notify: () => {},
    };
    const result = await runModelMetaDialog(
      ui,
      { id: "abc", displayName: "elysiver-claude", piName: "elysiver-claude" },
      undefined,
    );
    expect(result).toEqual({ kind: "save", modelMeta: { reasoning: false } });
  });

  test("clear path", async () => {
    const queue = ["清除全部覆写"];
    const ui = {
      select: async () => queue.shift() ?? null,
      input: async () => null,
      confirm: async () => true,
      notify: () => {},
    };
    const result = await runModelMetaDialog(
      ui,
      { id: "abc", displayName: "elysiver-claude", piName: "elysiver-claude" },
      { reasoning: false },
    );
    expect(result).toEqual({ kind: "clear" });
  });

  test("cancel", async () => {
    const ui = {
      select: async () => null,
      input: async () => null,
      confirm: async () => false,
    };
    const result = await runModelMetaDialog(
      ui,
      { id: "abc", displayName: "x", piName: "x" },
      undefined,
    );
    expect(result).toEqual({ kind: "cancel" });
  });

  test("preset relay-safe then save", async () => {
    const queue = [
      "预设 · 中转兼容（reasoning=false）",
      "保存",
    ];
    const ui = {
      select: async (_t: string, _opts: string[]) => queue.shift() ?? null,
      input: async () => null,
      confirm: async () => false,
      notify: () => {},
    };
    const result = await runModelMetaDialog(
      ui,
      { id: "abc", displayName: "relay", piName: "relay" },
      undefined,
    );
    expect(result).toEqual({ kind: "save", modelMeta: { reasoning: false } });
  });
});

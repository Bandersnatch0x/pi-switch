import { test, expect, describe } from "bun:test";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import {
  allocateColumns,
  formatFooterHints,
  formatKeyHint,
} from "../src/ui/three-level-pick.ts";

/**
 * Mirrors three-level-pick fit/line helpers to prove lines never exceed width.
 */
function fit(text: string, colWidth: number): string {
  if (colWidth <= 0) return "";
  return truncateToWidth(text, colWidth, "…", true);
}

function line(text: string, termWidth: number): string {
  const w = Math.max(1, termWidth);
  if (visibleWidth(text) <= w) return text;
  return truncateToWidth(text, w, "…", false);
}

describe("three-level width safety", () => {
  test("fit pads/truncates to exact column width", () => {
    const a = fit("hello", 10);
    expect(visibleWidth(a)).toBe(10);
    const b = fit("这是一段很长的中文名称·host.example.com", 12);
    expect(visibleWidth(b)).toBeLessThanOrEqual(12);
  });

  test("allocateColumns keeps c0+c1+c2+seps within width", () => {
    for (const width of [20, 40, 80, 114, 120]) {
      const { c0, c1, c2, usable } = allocateColumns(width, 1);
      expect(c0 + c1 + c2 + 2).toBeLessThanOrEqual(usable);
      expect(c0).toBeGreaterThanOrEqual(6);
      expect(c1).toBeGreaterThanOrEqual(8);
      expect(c2).toBeGreaterThanOrEqual(4);
    }
  });

  test("combined three columns with │ never exceed terminal width", () => {
    for (const width of [40, 80, 114, 120]) {
      const sepWidth = 1;
      const { c0, c1, c2 } = allocateColumns(width, sepWidth);
      const vsep = "│";

      const row =
        fit("› claude 46", c0) +
        vsep +
        fit("› 很长的provider名称 · sub.example.long.host", c1) +
        vsep +
        fit("› anthropic/claude-sonnet-4-5-very-long-id", c2);

      expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      expect(visibleWidth(line(row, width))).toBeLessThanOrEqual(width);
    }
  });

  test("ansi yellow highlight still truncates safely", () => {
    const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
    const cell = fit(yellow("sbai · new.sbai.shop.with.long.domain"), 16);
    expect(visibleWidth(cell)).toBeLessThanOrEqual(16);
    expect(visibleWidth(line(`path ${cell} more text that is long`, 20))).toBeLessThanOrEqual(20);
  });

  test("framed chrome lines clamp to width", () => {
    for (const width of [20, 40, 80]) {
      const border = "─".repeat(width);
      expect(visibleWidth(border)).toBe(width);
      const title = line("pi-switch · 很长很长很长很长很长很长的标题", width);
      expect(visibleWidth(title)).toBeLessThanOrEqual(width);
      const path = line(
        "claude › very-long-provider-name › very-long-model-id-that-keeps-going",
        width,
      );
      expect(visibleWidth(path)).toBeLessThanOrEqual(width);
      const footer = line(formatFooterHints(), width);
      expect(visibleWidth(footer)).toBeLessThanOrEqual(width);
    }
  });
});

describe("key hint formatting", () => {
  test("plain theme falls back to plain text", () => {
    expect(formatKeyHint(undefined, "enter", "select")).toBe("enter select");
    // Initial level: no column switch until something is revealed
    expect(formatFooterHints(undefined, { revealed: 0, col: 0 })).toContain(
      "enter next 名称",
    );
    expect(formatFooterHints(undefined, { revealed: 0, col: 0 })).toContain(
      "esc 退出",
    );
    expect(formatFooterHints(undefined, { revealed: 1, col: 1 })).toContain(
      "esc 返回",
    );
    expect(formatFooterHints(undefined, { revealed: 1, col: 1 })).toContain(
      "←→ column",
    );
    expect(formatFooterHints(undefined, { revealed: 2, col: 2 })).toContain(
      "enter select",
    );
    expect(formatFooterHints(undefined, { revealed: 2, col: 2 })).toContain(
      "f refresh",
    );
  });

  test("themed hints wrap key and description", () => {
    const theme = {
      fg: (key: string, text: string) => `<${key}>${text}</${key}>`,
    };
    expect(formatKeyHint(theme, "m", "manual")).toBe(
      "<dim>m</dim><muted> manual</muted>",
    );
    const footer = formatFooterHints(theme, { revealed: 1, col: 1 });
    expect(footer).toContain("<dim>←→</dim>");
    expect(footer).toContain("<muted> column</muted>");
    expect(footer).toContain("<dim> · </dim>");
  });

  test("allocateColumns progressive levels", () => {
    const one = allocateColumns(80, 1, 1);
    expect(one.c0).toBe(80);
    expect(one.c1).toBe(0);
    expect(one.c2).toBe(0);
    const two = allocateColumns(80, 1, 2);
    expect(two.c0 + two.c1 + 1).toBeLessThanOrEqual(80);
    expect(two.c2).toBe(0);
    const three = allocateColumns(80, 1, 3);
    expect(three.c0 + three.c1 + three.c2 + 2).toBeLessThanOrEqual(80);
  });
});

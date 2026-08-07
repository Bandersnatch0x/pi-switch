/**
 * /ps-override provider picker (custom TUI).
 *
 * Replaces the native ui.select for choosing a provider to override: native
 * select cannot do custom pagination, so the custom TUI offers PAGE_SIZE/page
 * with cyclic PgUp/PgDn, matching the other pickers.
 *
 * Keys:
 *   ↑ ↓   move within list
 *   PgUp/PgDn  flip one page (cyclic: past last → first)
 *   enter choose focused provider
 *   esc   cancel
 *
 * Falls back to native ui.select when the custom TUI is unavailable (non-TUI);
 * native select's own scrolling handles long lists in those hosts.
 */

import type { PiSwitchCtx } from "../pi-context.ts";
import { PAGE_SIZE, pageFlip } from "./pagination.ts";
import { formatKeyHint } from "./three-level-pick.ts";
import { t } from "./tui-locale.ts";

type ThemeLike = {
  fg?: (key: string, text: string) => string;
  bold?: (text: string) => string;
};

export function overridePickerFooter(
  theme: ThemeLike | undefined,
  total: number,
  idx: number,
): string {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(totalPages, Math.floor(idx / PAGE_SIZE) + 1);
  const sep = typeof theme?.fg === "function" ? theme.fg("dim", " · ") : " · ";
  return [
    formatKeyHint(theme, "↑↓", t("nav")),
    formatKeyHint(theme, "PgUp/PgDn", t("page")),
    formatKeyHint(theme, "enter", t("select")),
    formatKeyHint(theme, "esc", t("cancel")),
    `${page}/${totalPages}`,
  ].join(sep);
}

/**
 * Pick a provider by index from `labels`. Returns the chosen index, or
 * undefined on cancel. Custom TUI when available; otherwise native ui.select.
 */
export async function pickOverrideProvider(
  ctx: PiSwitchCtx,
  title: string,
  labels: string[],
): Promise<number | undefined> {
  if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") {
    return pickOverrideProviderCustom(ctx, title, labels);
  }
  const label = await ctx.ui.select(title, labels);
  return label ? labels.indexOf(label) : undefined;
}

async function pickOverrideProviderCustom(
  ctx: PiSwitchCtx,
  title: string,
  labels: string[],
): Promise<number | undefined> {
  const tuiMod = await import("@earendil-works/pi-tui");
  const { matchesKey, Key, truncateToWidth } = tuiMod;

  return ctx.ui.custom!<number | undefined>((tui: any, theme: any, _kb: any, done) => {
    let idx = 0;
    let scroll = 0;
    let disposed = false;

    if (!labels.length) {
      queueMicrotask(() => done(undefined));
      return { render: () => [title, `(${t("noProviders")})`], invalidate() {}, handleInput() {} };
    }

    function finish(r: number | undefined) {
      if (disposed) return;
      disposed = true;
      done(r);
    }

    function render(termWidth: number): string[] {
      const width = Math.max(20, Math.floor(termWidth));
      const lines: string[] = [title, ""];
      const visible = labels.slice(scroll, scroll + PAGE_SIZE);
      for (let i = 0; i < visible.length; i++) {
        const labelIdx = scroll + i;
        const isSel = labelIdx === idx;
        const text = truncateToWidth(visible[i], width - 2, "…");
        const body = isSel && typeof theme?.bold === "function" ? theme.bold(text) : text;
        lines.push(isSel ? `> ${body}` : `  ${body}`);
      }
      lines.push("");
      lines.push(overridePickerFooter(theme, labels.length, idx));
      return lines;
    }

    return {
      render,
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, Key.up)) {
          if (idx > 0) {
            idx -= 1;
            if (idx < scroll) scroll = idx;
            tui.requestRender();
          }
          return;
        }
        if (matchesKey(data, Key.down)) {
          if (idx < labels.length - 1) {
            idx += 1;
            if (idx >= scroll + PAGE_SIZE) scroll = idx - (PAGE_SIZE - 1);
            tui.requestRender();
          }
          return;
        }
        if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
          const dir = matchesKey(data, Key.pageDown) ? 1 : -1;
          const flipped = pageFlip(idx, scroll, labels.length, PAGE_SIZE, dir);
          idx = flipped.idx;
          scroll = flipped.scroll;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          finish(idx);
          return;
        }
        if (matchesKey(data, Key.escape)) {
          finish(undefined);
          return;
        }
      },
    };
  });
}

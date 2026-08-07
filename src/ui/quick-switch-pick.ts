/**
 * /ps one-screen quick switcher (custom TUI).
 *
 * Pinned + recent pairs on one screen with key operations — pin/unpin without
 * leaving the picker (ui.select cannot bind custom keys, so the custom TUI is
 * the only way to offer pin management on the quick list).
 *
 * Keys:
 *   ↑ ↓   move within list
 *   PgUp/PgDn  flip one page (cyclic: past last → first)
 *   enter switch to focused provider+model
 *   p     toggle pin on focused entry (stays open, list rebuilds: pins first)
 *   esc   exit
 *
 * Falls back to the plain native select when the custom TUI is unavailable
 * (non-TUI modes).
 */

import type { CcProvider, PinEntry, RecentEntry } from "../types.ts";
import { isPinned } from "../settings.ts";
import { buildQuickEntries, type QuickEntry } from "./quick-pick.ts";
import { formatKeyHint } from "./three-level-pick.ts";
import { t } from "./tui-locale.ts";
import type { PiSwitchCtx } from "../pi-context.ts";
import { pageFlip } from "./pagination.ts";

export interface QuickSwitchPickOpts {
  providers: CcProvider[];
  pins: PinEntry[];
  recent: RecentEntry[];
  /** Persist pin toggle; return the new pins array (picker stays open). */
  onTogglePin?: (entry: PinEntry) => PinEntry[] | Promise<PinEntry[]>;
  /** Switch to the focused entry. Called on enter. */
  onPick: (provider: CcProvider, modelId: string) => Promise<void> | void;
}

export type QuickSwitchResult = { kind: "picked" } | { kind: "cancel" };

/** Rows visible in the quick list at once; longer lists use cyclic paging. */
export const QUICK_VIEWPORT = 10;

type ThemeLike = {
  fg?: (key: string, text: string) => string;
  bold?: (text: string) => string;
};

/** Pure helpers (unit-testable). */

export interface QuickPickerState {
  entries: QuickEntry[];
  idx: number;
  scroll: number;
}

export function buildQuickPickerState(
  pins: PinEntry[],
  recent: RecentEntry[],
  providers: CcProvider[],
  prev?: QuickPickerState,
): QuickPickerState {
  const entries = buildQuickEntries(pins, recent, providers);
  const idx = Math.min(prev?.idx ?? 0, Math.max(0, entries.length - 1));
  return { entries, idx, scroll: 0 };
}

export function quickPickerFooter(theme?: ThemeLike): string {
  const sep = typeof theme?.fg === "function" ? theme.fg("dim", " · ") : " · ";
  return [
    formatKeyHint(theme, "↑↓", t("nav")),
    formatKeyHint(theme, "PgUp/PgDn", t("page")),
    formatKeyHint(theme, "enter", t("switch")),
    formatKeyHint(theme, "p", `${t("pin")}/${t("unpin")}`),
    formatKeyHint(theme, "esc", t("escExit")),
  ].join(sep);
}

export async function quickSwitchPick(
  ctx: PiSwitchCtx,
  opts: QuickSwitchPickOpts,
): Promise<QuickSwitchResult> {
  if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") {
    try {
      const result = await quickSwitchCustom(ctx, opts);
      if (result) return result;
    } catch (err) {
      console.error("[pi-switch] quick-switch custom UI failed:", err);
    }
  }
  return quickSwitchFallback(ctx, opts);
}

async function quickSwitchCustom(
  ctx: PiSwitchCtx,
  opts: QuickSwitchPickOpts,
): Promise<QuickSwitchResult | undefined> {
  const tuiMod = await import("@earendil-works/pi-tui");
  const { matchesKey, Key, truncateToWidth } = tuiMod;

  return ctx.ui.custom!<QuickSwitchResult>((tui: any, theme: any, _kb: any, done) => {
    let state = buildQuickPickerState(opts.pins, opts.recent, opts.providers);
    let disposed = false;

    if (!state.entries.length) {
      queueMicrotask(() => done({ kind: "cancel" }));
      return { render: () => [`(${t("quickEmpty")})`], invalidate() {}, handleInput() {} };
    }

    function finish(r: QuickSwitchResult) {
      if (disposed) return;
      disposed = true;
      done(r);
    }

    function render(termWidth: number): string[] {
      const width = Math.max(20, Math.floor(termWidth));
      const lines: string[] = [];
      const viewport = QUICK_VIEWPORT;
      const visible = state.entries.slice(state.scroll, state.scroll + viewport);
      for (const e of visible) {
        const isSel = e === state.entries[state.idx];
        const line = truncateToWidth(e.label, width, "…");
        const body = isSel
          ? typeof theme?.bold === "function"
            ? theme.bold(line)
            : line
          : line;
        lines.push(isSel ? `> ${body}` : `  ${body}`);
      }
      lines.push("");
      lines.push(quickPickerFooter(theme));
      return lines;
    }

    return {
      render,
      invalidate() {
        // entries are rebuilt inside the p handler; nothing else changes layout
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.up)) {
          if (state.idx > 0) {
            state = { ...state, idx: state.idx - 1 };
            if (state.idx < state.scroll) state = { ...state, scroll: state.idx };
            tui.requestRender();
          }
          return;
        }
        if (matchesKey(data, Key.down)) {
          if (state.idx < state.entries.length - 1) {
            state = { ...state, idx: state.idx + 1 };
            if (state.idx >= state.scroll + QUICK_VIEWPORT) {
              state = { ...state, scroll: state.idx - (QUICK_VIEWPORT - 1) };
            }
            tui.requestRender();
          }
          return;
        }
        if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
          const dir = matchesKey(data, Key.pageDown) ? 1 : -1;
          const flipped = pageFlip(
            state.idx,
            state.scroll,
            state.entries.length,
            QUICK_VIEWPORT,
            dir,
          );
          state = { ...state, idx: flipped.idx, scroll: flipped.scroll };
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          const e = state.entries[state.idx];
          if (!e) return;
          void (async () => {
            try {
              await opts.onPick(e.provider, e.modelId);
            } finally {
              finish({ kind: "picked" });
            }
          })();
          return;
        }
        if (data === "p" || data === "P") {
          const e = state.entries[state.idx];
          if (!e || !opts.onTogglePin) {
            ctx.ui.notify(t("pinNoPersist"), "warning");
            return;
          }
          // Unpin with the *stored* pin identity, not the resolved provider's:
          // the row may render via the dbId fallback with a different appType,
          // which misses sameEntry and silently adds a duplicate (unpinnable ★).
          // Legacy appType-less pins take the provider appType so the toggle
          // also heals appType-less duplicate twins.
          const toggleEntry: PinEntry = e.pinned && e.pin
            ? {
                dbId: e.pin.dbId,
                model: e.pin.model,
                appType: e.pin.appType ?? e.provider.appType,
                label: e.pin.label ?? `${e.provider.displayName} · ${e.modelId}`,
              }
            : {
                dbId: e.provider.id,
                model: e.modelId,
                appType: e.provider.appType,
                label: `${e.provider.displayName} · ${e.modelId}`,
              };
          void (async () => {
            try {
              const next = await opts.onTogglePin!(toggleEntry);
              const fresh = buildQuickEntries(next, opts.recent, opts.providers);
              state = {
                entries: fresh,
                idx: Math.min(state.idx, Math.max(0, fresh.length - 1)),
                scroll: Math.min(state.scroll, Math.max(0, fresh.length - 1)),
              };
              const nowPinned = isPinned(
                next,
                toggleEntry.dbId,
                toggleEntry.model,
                toggleEntry.appType,
              );
              ctx.ui.notify(
                `${nowPinned ? t("pinOn") : t("pinOff")} · ${e.provider.displayName} · ${e.modelId}`,
                "info",
              );
              tui.requestRender();
            } catch (err) {
              ctx.ui.notify(
                `${t("pinFail")}: ${err instanceof Error ? err.message : String(err)}`,
                "error",
              );
            }
          })();
          return;
        }
        if (matchesKey(data, Key.escape)) {
          finish({ kind: "cancel" });
          return;
        }
      },
    };
  });
}

async function quickSwitchFallback(
  ctx: PiSwitchCtx,
  opts: QuickSwitchPickOpts,
): Promise<QuickSwitchResult> {
  const entries = buildQuickEntries(opts.pins, opts.recent, opts.providers);
  if (!entries.length) return { kind: "cancel" };
  const labels = entries.map((e) => e.label);
  const pick = await ctx.ui.select(t("quickSwitchTitle"), labels);
  if (!pick) return { kind: "cancel" };
  const entry = entries[labels.indexOf(pick)];
  if (!entry) return { kind: "cancel" };
  await opts.onPick(entry.provider, entry.modelId);
  return { kind: "picked" };
}

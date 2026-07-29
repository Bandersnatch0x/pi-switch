/**
 * Progressive three-level picker:
 *   初始化只显示「类型」
 *   确认/进入后显示「名称」
 *   再进入后显示「模型」
 *
 * Visual style mirrors Pi native dialogs (llama frame).
 *
 * Keys:
 *   ← →   switch among revealed columns (→ may open next level)
 *   ↑ ↓   move within column
 *   enter open next level / confirm model
 *   /     start in-picker search (no nested ui.input — avoids dismissing custom TUI)
 *   m     in-picker manual model id (same: no nested ui.input)
 *   f     refresh models (remote)
 *   o     parameter override (when name/model revealed)
 *   p     toggle pin on current provider+model
 *   esc   manual/search mode cancel; else clear filter; else pop level; exit at root
 *
 * Lines truncated via pi-tui visibleWidth / truncateToWidth.
 */

import type { CcProvider, PinEntry, RecentEntry } from "../types.ts";
import { isSwitchable } from "../parse/index.ts";
import { isPinned } from "../settings.ts";
import { buildTabs, type TabInfo } from "./tabs.ts";
import {
  filterProviders,
  getAppTypeIcon,
  sortProviders,
  yellowHighlight,
} from "./labels.ts";
import { mergeModelLists } from "../models-fetch.ts";
import type { PiSwitchCtx } from "../pi-context.ts";

export type ThreeLevelResult =
  | { kind: "ok"; provider: CcProvider; modelId: string }
  /**
   * Exit custom TUI first; caller opens override dialog outside (no nested UI).
   * modelId is set when the 模型 column is revealed on a concrete model, so the
   * dialog can preselect model scope.
   */
  | { kind: "override"; provider: CcProvider; modelId?: string }
  | { kind: "cancel" };

export interface ThreeLevelPickOpts {
  providers: CcProvider[];
  preferredTab?: string;
  lastDbId?: string;
  lastModel?: string;
  activePiName?: string;
  tabOrder?: string[];
  /** Local pins (provider+model). Updated in-place via onTogglePin. */
  pins?: PinEntry[];
  /** Last-N successful switches for soft prioritization. */
  recent?: RecentEntry[];
  /** Persist pin toggle; return the new pins array (picker stays open). */
  onTogglePin?: (entry: PinEntry) => PinEntry[] | Promise<PinEntry[]>;
  fetchRemote?: (provider: CcProvider) => Promise<string[]>;
  /**
   * Session-scoped remote-models cache (dbId → ids). Pass the same Map across
   * reopenings (the `o` override loop re-enters the picker) so a fetched list
   * survives instead of being lost with the closed TUI.
   */
  remoteCache?: Map<string, string[]>;
  /**
   * Whether a modelMeta override exists. Called with modelId for the model
   * column (model-scope only) and without it for the name column (any scope).
   * Drives the ⚙ badge.
   */
  hasOverride?: (provider: CcProvider, modelId?: string) => boolean;
}

const MANUAL = "__manual__";
const FETCH = "__fetch__";
const COL_LABELS = ["类型", "名称", "模型"] as const;

type WidthFns = {
  visibleWidth: (s: string) => number;
  truncateToWidth: (text: string, maxWidth: number, ellipsis?: string, pad?: boolean) => string;
};

type ThemeLike = {
  fg?: (key: string, text: string) => string;
  bold?: (text: string) => string;
};

/**
 * Column widths for progressive levels (1=类型 only, 2=+名称, 3=+模型).
 * sepWidth is the width of each │ between columns.
 */
export function allocateColumns(
  termWidth: number,
  sepWidth = 1,
  levels = 3,
): { c0: number; c1: number; c2: number; usable: number } {
  const usable = Math.max(12, Math.floor(termWidth));
  const n = Math.min(3, Math.max(1, levels));
  if (n === 1) {
    return { c0: usable, c1: 0, c2: 0, usable };
  }
  if (n === 2) {
    const seps = sepWidth;
    let c0 = Math.max(10, Math.floor((usable - seps) * 0.32));
    let c1 = usable - c0 - seps;
    if (c1 < 10) {
      c0 = Math.max(8, usable - seps - 10);
      c1 = usable - c0 - seps;
    }
    return { c0, c1: Math.max(4, c1), c2: 0, usable };
  }
  const seps = sepWidth * 2;
  let c0 = Math.max(8, Math.floor((usable - seps) * 0.2));
  let c1 = Math.max(10, Math.floor((usable - seps) * 0.38));
  let c2 = usable - c0 - c1 - seps;
  if (c2 < 8) {
    const deficit = 8 - c2;
    c1 = Math.max(8, c1 - deficit);
    c2 = usable - c0 - c1 - seps;
  }
  if (c2 < 6) {
    c0 = Math.max(6, c0 - (6 - c2));
    c2 = usable - c0 - c1 - seps;
  }
  c2 = Math.max(4, c2);
  return { c0, c1, c2, usable };
}

/** Pi-style key hint: dim key + muted description. */
export function formatKeyHint(
  theme: ThemeLike | undefined,
  key: string,
  description: string,
): string {
  const dim = (s: string) =>
    typeof theme?.fg === "function" ? theme.fg("dim", s) : s;
  const muted = (s: string) =>
    typeof theme?.fg === "function" ? theme.fg("muted", s) : s;
  return `${dim(key)}${muted(` ${description}`)}`;
}

/**
 * Pop one reveal level (Esc). Pure — used by the TUI and unit tests.
 * - revealed≥2 → collapse model column
 * - revealed=1 → collapse name column
 * - revealed=0 → signal exit (caller finishes cancel)
 */
export function popPickerLevel(state: {
  revealed: number;
  col: number;
}): { revealed: number; col: number; exit: boolean } {
  const revealed = Math.max(0, Math.floor(state.revealed));
  const col = Math.max(0, Math.min(2, Math.floor(state.col)));
  if (revealed >= 2) {
    return { revealed: 1, col: Math.min(col, 1), exit: false };
  }
  if (revealed === 1) {
    return { revealed: 0, col: 0, exit: false };
  }
  return { revealed: 0, col: 0, exit: true };
}

export function formatFooterHints(
  theme?: ThemeLike,
  opts?: { revealed?: number; col?: number },
): string {
  const sep =
    typeof theme?.fg === "function" ? theme.fg("dim", " · ") : " · ";
  const revealed = opts?.revealed ?? 0;
  const col = opts?.col ?? 0;
  const enterHint =
    col < 2 ? (col === 0 ? "next 名称" : "next 模型") : "select";
  const parts = [
    formatKeyHint(theme, "↑↓", "nav"),
    formatKeyHint(theme, "enter", enterHint),
  ];
  if (revealed > 0) {
    parts.unshift(formatKeyHint(theme, "←→", "column"));
  }
  parts.push(
    formatKeyHint(theme, "/", "search"),
    formatKeyHint(theme, "m", "manual"),
    formatKeyHint(theme, "f", "refresh"),
  );
  // o closes custom TUI then opens override dialog outside (no nested UI).
  if (revealed > 0) {
    parts.push(formatKeyHint(theme, "o", "override"));
  }
  // p toggles pin for current provider+model without closing the picker.
  if (revealed >= 2) {
    parts.push(formatKeyHint(theme, "p", "pin"));
  }
  // Esc pops reveal depth; only type-only view exits the whole command.
  parts.push(formatKeyHint(theme, "esc", revealed === 0 ? "退出" : "返回"));
  return parts.join(sep);
}

/** Footer while typing an in-picker search query. */
export function formatSearchFooterHints(theme?: ThemeLike): string {
  const sep =
    typeof theme?.fg === "function" ? theme.fg("dim", " · ") : " · ";
  return [
    formatKeyHint(theme, "type", "过滤"),
    formatKeyHint(theme, "enter", "确认"),
    formatKeyHint(theme, "esc", "取消搜索"),
  ].join(sep);
}

/** Footer while typing a manual model id. */
export function formatManualFooterHints(theme?: ThemeLike): string {
  const sep =
    typeof theme?.fg === "function" ? theme.fg("dim", " · ") : " · ";
  return [
    formatKeyHint(theme, "type", "model id"),
    formatKeyHint(theme, "enter", "切换"),
    formatKeyHint(theme, "esc", "取消"),
  ].join(sep);
}

export async function threeLevelPick(
  ctx: PiSwitchCtx,
  opts: ThreeLevelPickOpts,
): Promise<ThreeLevelResult> {
  if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") {
    try {
      const result = await threeLevelCustom(ctx, opts);
      if (result) return result;
    } catch (err) {
      console.error("[pi-switch] three-level custom UI failed:", err);
    }
  }
  return threeLevelFallback(ctx, opts);
}

async function threeLevelCustom(
  ctx: PiSwitchCtx,
  opts: ThreeLevelPickOpts,
): Promise<ThreeLevelResult> {
  const tuiMod = await import("@earendil-works/pi-tui");
  const { matchesKey, Key, visibleWidth, truncateToWidth } = tuiMod;
  const wf: WidthFns = { visibleWidth, truncateToWidth };

  return ctx.ui.custom!<ThreeLevelResult>((tui: any, theme: any, _kb: any, done) => {
    const allTabs = buildTabs(opts.providers, opts.tabOrder);
    if (!allTabs.length) {
      queueMicrotask(() => done({ kind: "cancel" }));
      return {
        render: () => ["(empty)"],
        invalidate() {},
        handleInput() {},
      };
    }

    let col = 0;
    /** Highest revealed column index: 0=类型 only, 1=+名称, 2=+模型 */
    let revealed = 0;
    let typeIdx = Math.max(0, allTabs.findIndex((t) => t.appType === opts.preferredTab));
    let nameIdx = 0;
    let modelIdx = 0;
    let typeScroll = 0;
    let nameScroll = 0;
    let modelScroll = 0;
    let query = "";
    /** Inline search (do NOT use nested ctx.ui.input — it tears down custom TUI). */
    let searchMode = false;
    /** Inline manual model id entry (same nesting ban as search). */
    let manualMode = false;
    let manualDraft = "";
    const remoteById = opts.remoteCache ?? new Map<string, string[]>();
    /** Live pin list; refreshed by onTogglePin without closing TUI. */
    let livePins: PinEntry[] = [...(opts.pins ?? [])];
    let disposed = false;
    let cache: string[] | undefined;
    let cacheWidth = -1;

    // Remember preferred name/model, but do not reveal columns until user opens them.
    {
      const names0 = listNames(allTabs[typeIdx].appType);
      if (opts.lastDbId) {
        const i = names0.findIndex((p) => p.id === opts.lastDbId);
        if (i >= 0) nameIdx = i;
      }
      const models0 = listModels(names0[nameIdx]);
      if (opts.lastModel) {
        const mi = models0.findIndex((m) => m === opts.lastModel);
        if (mi >= 0) modelIdx = mi;
      }
    }

    function finish(r: ThreeLevelResult) {
      if (disposed) return;
      disposed = true;
      done(r);
    }

    function visibleTabs(): TabInfo[] {
      if (query && col === 0) {
        const q = query.toLowerCase();
        return allTabs.filter((t) => t.appType.toLowerCase().includes(q));
      }
      return allTabs;
    }

    function pinnedDbIds(): string[] {
      return [...new Set(livePins.map((p) => p.dbId))];
    }

    function listNames(appType: string): CcProvider[] {
      let list = opts.providers.filter((p) => p.appType === appType);
      list = sortProviders(list, opts.lastDbId, pinnedDbIds());
      if (query && col === 1) list = filterProviders(list, query);
      return list;
    }

    function listModels(provider: CcProvider | undefined): string[] {
      if (!provider || !isSwitchable(provider)) return [];
      const remote = remoteById.get(provider.id) ?? [];
      let list = mergeModelLists(provider.configModels, remote);
      if (query && col === 2) {
        const q = query.toLowerCase();
        list = list.filter((id) => id.toLowerCase().includes(q));
      }
      // Soft priority: recent for this provider, then pinned, then rest.
      const recentOrder = (opts.recent ?? [])
        .filter((r) => r.dbId === provider.id)
        .map((r) => r.model);
      const pinOrder = livePins
        .filter((p) => p.dbId === provider.id)
        .map((p) => p.model);
      const rank = (id: string): number => {
        const ri = recentOrder.indexOf(id);
        if (ri >= 0) return ri;
        const pi = pinOrder.indexOf(id);
        if (pi >= 0) return 1000 + pi;
        return 10000;
      };
      list = [...list].sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        return 0;
      });
      return [...list, MANUAL, FETCH];
    }

    function modelLabel(id: string, provider?: CcProvider): string {
      if (id === MANUAL) return "+ 手动输入";
      if (id === FETCH) return "r 刷新模型";
      const gear = provider && opts.hasOverride?.(provider, id) ? fg("accent", " *") : "";
      if (provider && isPinned(livePins, provider.id, id)) return `* ${id}${gear}`;
      return `${id}${gear}`;
    }

    function providerHasPin(provider: CcProvider | undefined): boolean {
      if (!provider) return false;
      return livePins.some((p) => p.dbId === provider.id);
    }

    function providerHasOverride(provider: CcProvider | undefined): boolean {
      if (!provider) return false;
      return Boolean(opts.hasOverride?.(provider));
    }

    /** Open next level if possible; returns true if UI advanced. */
    function openNextLevel(): boolean {
      if (col === 0) {
        revealed = Math.max(revealed, 1);
        col = 1;
        query = "";
        // keep preferred nameIdx if still valid
        const names = listNames(allTabs[typeIdx].appType);
        nameIdx = names.length ? clamp(nameIdx, 0, names.length - 1) : 0;
        modelIdx = 0;
        return true;
      }
      if (col === 1) {
        const { provider } = current();
        if (!provider) return false;
        if (!isSwitchable(provider)) {
          ctx.ui.notify(`不可切换: ${provider.parseError ?? "unknown"}`, "warning");
          return false;
        }
        revealed = Math.max(revealed, 2);
        col = 2;
        query = "";
        modelIdx = 0;
        return true;
      }
      return false;
    }

    function current() {
      const tabs = visibleTabs();
      let tIdx = tabs.findIndex((t) => t.appType === allTabs[typeIdx]?.appType);
      if (tIdx < 0) tIdx = clamp(typeIdx, 0, Math.max(tabs.length - 1, 0));
      const appType = tabs[tIdx]?.appType ?? allTabs[0].appType;
      const real = allTabs.findIndex((t) => t.appType === appType);
      if (real >= 0) typeIdx = real;
      const names = listNames(appType);
      nameIdx = names.length ? clamp(nameIdx, 0, names.length - 1) : 0;
      const provider = names[nameIdx];
      const models = listModels(provider);
      modelIdx = models.length ? clamp(modelIdx, 0, models.length - 1) : 0;
      return { tabs, tIdx, appType, names, provider, models };
    }

    function ensureScroll(idx: number, scroll: number, vis: number, total: number): number {
      if (total <= vis) return 0;
      if (idx < scroll) return idx;
      if (idx >= scroll + vis) return idx - vis + 1;
      return scroll;
    }

    function fg(key: string, s: string): string {
      return typeof theme.fg === "function" ? theme.fg(key, s) : s;
    }
    function bold(s: string): string {
      return typeof theme.bold === "function" ? theme.bold(s) : s;
    }

    /** Fit cell to exact column width (truncate + pad), ANSI-safe. */
    function fit(text: string, colWidth: number): string {
      if (colWidth <= 0) return "";
      return wf.truncateToWidth(text, colWidth, "…", true);
    }

    /** Clamp full line to terminal width. */
    function line(text: string, termWidth: number): string {
      const w = Math.max(1, termWidth);
      if (wf.visibleWidth(text) <= w) return text;
      return wf.truncateToWidth(text, w, "…", false);
    }

    function border(width: number, color: "accent" | "borderMuted" | "dim" = "accent"): string {
      return fg(color, "─".repeat(Math.max(1, width)));
    }

    function vsep(active?: boolean): string {
      return active ? fg("accent", "│") : fg("dim", "│");
    }

    function headerCell(label: string, focused: boolean, colWidth: number): string {
      if (focused) {
        return fit(fg("accent", bold(`> ${label}`)), colWidth);
      }
      return fit(fg("muted", `  ${label}`), colWidth);
    }

    function rowMarker(selected: boolean, focused: boolean, body: string): string {
      if (selected && focused) return fg("accent", bold(`> ${body}`));
      if (selected) return fg("muted", `> ${body}`);
      return `  ${body}`;
    }

    function render(termWidth: number): string[] {
      const width = Math.max(20, Math.floor(termWidth));
      if (cache && cacheWidth === width) return cache;

      const { tabs, tIdx, appType, names, provider, models } = current();
      const levels = revealed + 1; // 1..3
      const sepWidth = 1;
      const { c0, c1, c2 } = allocateColumns(width, sepWidth, levels);

      const maxVis = Math.min(12, Math.max(5, Math.floor((16 * width) / 120)));

      typeScroll = ensureScroll(tIdx, typeScroll, maxVis, tabs.length);
      if (revealed >= 1) {
        nameScroll = ensureScroll(nameIdx, nameScroll, maxVis, names.length);
      }
      if (revealed >= 2) {
        modelScroll = ensureScroll(modelIdx, modelScroll, maxVis, models.length);
      }

      const out: string[] = [];
      const push = (s: string) => out.push(line(s, width));

      push(border(width, "accent"));
      push(fg("accent", bold("pi-switch")));

      const metaParts = [`${tabs.length} 类型`];
      if (revealed >= 1) metaParts.push(`${names.length} 名称`);
      if (revealed >= 2) {
        const realModels = models.filter((m) => m !== MANUAL && m !== FETCH).length;
        metaParts.push(`${realModels} 模型`);
      }
      if (manualMode) {
        metaParts.push(`手动 model "${manualDraft}█"`);
      } else if (searchMode) {
        metaParts.push(`搜索[${COL_LABELS[col]}] "${query}█"`);
      } else if (query) {
        metaParts.push(`搜索[${COL_LABELS[col]}] "${query}"`);
      }
      const metaLine = metaParts.join(" · ");
      push(manualMode || searchMode ? fg("accent", metaLine) : fg("dim", metaLine));
      push(border(width, "borderMuted"));

      // Headers only for revealed columns
      let header = headerCell(COL_LABELS[0], col === 0, c0);
      if (revealed >= 1) header += vsep(col === 0 || col === 1) + headerCell(COL_LABELS[1], col === 1, c1);
      if (revealed >= 2) header += vsep(col === 1 || col === 2) + headerCell(COL_LABELS[2], col === 2, c2);
      push(header);
      push(border(width, "dim"));

      for (let row = 0; row < maxVis; row++) {
        const ti = typeScroll + row;
        const ni = nameScroll + row;
        const mi = modelScroll + row;

        let tCell = "";
        if (ti < tabs.length) {
          const tab = tabs[ti];
          const icon = getAppTypeIcon(tab.appType);
          const namePart = `${icon} ${tab.appType}`;
          const countPart = String(tab.count);
          const sel = ti === tIdx;
          const body =
            sel && col === 0
              ? `${namePart} ${countPart}`
              : `${namePart} ${fg("dim", countPart)}`;
          tCell = rowMarker(sel, col === 0, body);
        } else if (row === 0 && tabs.length === 0) {
          tCell = fg("dim", "  (空)");
        }

        let rowLine = fit(tCell, c0);

        if (revealed >= 1) {
          let nCell = "";
          if (ni < names.length) {
            const p = names[ni];
            const nameBudget = Math.max(4, c1 - 6);
            const pinMark = providerHasPin(p) ? "* " : "";
            const gear = providerHasOverride(p) ? " *" : "";
            const reserved = (pinMark ? 2 : 0) + (gear ? 2 : 0);
            const name = truncatePlain(p.displayName, Math.max(2, nameBudget - reserved));
            const labeled = `${pinMark}${name}${gear}`;
            const ok = isSwitchable(p);
            const core = ok
              ? labeled
              : `${labeled} ${fg("dim", "-")} ${fg("warning", "不可切换")}`;
            const sel = ni === nameIdx;
            const active = opts.activePiName === p.piName;
            if (sel && col === 1) {
              nCell = fg("accent", `> ${labeled}${ok ? "" : " - 不可切换"}`);
            } else if (sel && active) nCell = `> ${yellowHighlight(labeled)}`;
            else if (sel) nCell = `> ${ok ? labeled : `${labeled} - 不可切换`}`;
            else if (active) nCell = `  ${yellowHighlight(labeled)}`;
            else nCell = `  ${core}`;
          } else if (row === 0 && names.length === 0) {
            nCell = fg("dim", "  (无匹配)");
          }
          rowLine += vsep() + fit(nCell, c1);
        }

        if (revealed >= 2) {
          let mCell = "";
          if (mi < models.length) {
            const mid = models[mi];
            const isAction = mid === MANUAL || mid === FETCH;
            const text = truncatePlain(modelLabel(mid, provider), Math.max(4, c2 - 2));
            const sel = mi === modelIdx;
            if (sel && col === 2) mCell = fg("accent", `› ${text}`);
            else if (sel) mCell = `› ${text}`;
            else if (isAction) mCell = `  ${fg("muted", text)}`;
            else mCell = `  ${text}`;
          } else if (row === 0 && models.length === 0) {
            const reason =
              provider && !isSwitchable(provider)
                ? truncatePlain(provider.parseError ?? "不可切换", Math.max(4, c2 - 2))
                : "无模型";
            mCell = fg("dim", `  ${reason}`);
          }
          rowLine += vsep() + fit(mCell, c2);
        }

        push(rowLine);
      }

      const scrolled =
        typeScroll > 0 ||
        typeScroll + maxVis < tabs.length ||
        (revealed >= 1 &&
          (nameScroll > 0 || nameScroll + maxVis < names.length)) ||
        (revealed >= 2 &&
          (modelScroll > 0 || modelScroll + maxVis < models.length));
      if (scrolled) {
        const tip = (scroll: number, total: number, idx: number) => {
          if (total <= maxVis) return "·";
          if (scroll > 0 && scroll + maxVis < total) return "↕";
          if (scroll > 0) return "↑";
          if (idx + 1 < total) return "↓";
          return "·";
        };
        let tipLine = fit(fg("dim", `  ${tip(typeScroll, tabs.length, tIdx)}`), c0);
        if (revealed >= 1) {
          tipLine +=
            vsep() +
            fit(fg("dim", `  ${tip(nameScroll, names.length, nameIdx)}`), c1);
        }
        if (revealed >= 2) {
          tipLine +=
            vsep() +
            fit(fg("dim", `  ${tip(modelScroll, models.length, modelIdx)}`), c2);
        }
        push(tipLine);
      }

      push(border(width, "borderMuted"));

      // Breadcrumb only for revealed levels
      const mid = models[modelIdx];
      const parts: string[] = [fg("muted", appType)];
      const arrow = fg("dim", " › ");
      if (revealed >= 1) {
        const namePart = truncatePlain(provider?.displayName ?? "—", 28);
        parts.push(
          fg(
            provider && isSwitchable(provider) ? "muted" : "warning",
            namePart,
          ),
        );
      }
      if (revealed >= 2) {
        const modelPart =
          mid && mid !== MANUAL && mid !== FETCH
            ? truncatePlain(mid, 40)
            : modelLabel(mid ?? "—", provider);
        parts.push(fg("accent", modelPart));
      }
      let pos = `  ${tIdx + 1}/${Math.max(tabs.length, 1)}`;
      if (revealed >= 1) pos += ` · ${nameIdx + 1}/${Math.max(names.length, 1)}`;
      if (revealed >= 2) pos += ` · ${modelIdx + 1}/${Math.max(models.length, 1)}`;
      push(parts.join(arrow) + fg("dim", pos));

      push(
        manualMode
          ? formatManualFooterHints(theme)
          : searchMode
            ? formatSearchFooterHints(theme)
            : formatFooterHints(theme, { revealed, col }),
      );
      push(border(width, "accent"));

      cache = out.map((l) => line(l, width));
      cacheWidth = width;
      return cache;
    }

    function invalidate() {
      cache = undefined;
      cacheWidth = -1;
    }

    /** Enter in-picker manual model entry (never nest ctx.ui.input). */
    function beginManualEntry(): void {
      const { provider } = current();
      if (!provider || !isSwitchable(provider)) {
        ctx.ui.notify("当前名称不可切换", "warning");
        return;
      }
      searchMode = false;
      manualMode = true;
      // Soft default: first listed plain id (not MANUAL/FETCH).
      const listed = listModels(provider).filter((m) => m !== MANUAL && m !== FETCH);
      manualDraft = listed[0] ?? "";
      invalidate();
      tui.requestRender();
    }

    async function doFetch(p: CcProvider) {
      if (!opts.fetchRemote) {
        ctx.ui.notify("未配置远端拉取", "warning");
        return;
      }
      ctx.ui.setStatus?.("pi-switch", "刷新模型…");
      try {
        const ids = await opts.fetchRemote(p);
        remoteById.set(p.id, ids);
        ctx.ui.notify(
          ids.length ? `已刷新 ${ids.length} 个模型` : "模型列表为空",
          ids.length ? "info" : "warning",
        );
      } catch (e) {
        ctx.ui.notify(`拉取失败: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
      ctx.ui.setStatus?.("pi-switch", undefined);
      modelIdx = 0;
      invalidate();
      tui.requestRender();
    }

    function handleInput(data: string) {
      if (disposed) return;

      // --- In-picker manual model id (no nested ui.input) ---
      if (manualMode) {
        if (matchesKey(data, Key.escape)) {
          manualMode = false;
          manualDraft = "";
          invalidate();
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          const id = manualDraft.trim();
          if (!id) {
            ctx.ui.notify("model id 不能为空", "warning");
            return;
          }
          const { provider } = current();
          if (!provider || !isSwitchable(provider)) {
            ctx.ui.notify("当前名称不可切换", "warning");
            manualMode = false;
            invalidate();
            tui.requestRender();
            return;
          }
          finish({ kind: "ok", provider, modelId: id });
          return;
        }
        if (data === "\x7f" || data === "\b") {
          manualDraft = manualDraft.slice(0, -1);
          invalidate();
          tui.requestRender();
          return;
        }
        if (data && data.length === 1 && data.charCodeAt(0) >= 32 && data !== "\x7f") {
          manualDraft += data;
          invalidate();
          tui.requestRender();
          return;
        }
        return;
      }

      // --- In-picker search (no nested ui.input) ---
      if (searchMode) {
        if (matchesKey(data, Key.escape)) {
          searchMode = false;
          query = "";
          if (col === 0) typeIdx = 0;
          nameIdx = 0;
          modelIdx = 0;
          invalidate();
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          // Commit filter; stay on picker with query applied.
          searchMode = false;
          query = query.trim();
          if (col === 0) typeIdx = 0;
          nameIdx = 0;
          modelIdx = 0;
          invalidate();
          tui.requestRender();
          return;
        }
        if (data === "\x7f" || data === "\b") {
          query = query.slice(0, -1);
          if (col === 0) typeIdx = 0;
          nameIdx = 0;
          modelIdx = 0;
          invalidate();
          tui.requestRender();
          return;
        }
        if (data && data.length === 1 && data.charCodeAt(0) >= 32 && data !== "\x7f") {
          query += data;
          if (col === 0) typeIdx = 0;
          nameIdx = 0;
          modelIdx = 0;
          invalidate();
          tui.requestRender();
          return;
        }
        // Ignore arrows / other keys while typing the filter.
        return;
      }

      if (matchesKey(data, Key.escape)) {
        // Clear active filter first (return to unfiltered list) before popping levels.
        if (query) {
          query = "";
          if (col === 0) typeIdx = 0;
          nameIdx = 0;
          modelIdx = 0;
          invalidate();
          tui.requestRender();
          return;
        }
        const next = popPickerLevel({ revealed, col });
        if (next.exit) {
          finish({ kind: "cancel" });
          return;
        }
        revealed = next.revealed;
        col = next.col;
        query = "";
        invalidate();
        tui.requestRender();
        return;
      }

      if (matchesKey(data, Key.left)) {
        col = Math.max(0, col - 1);
        query = "";
        invalidate();
        tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.right)) {
        // Move among revealed columns, or open next level at the edge
        if (col < revealed) {
          col = Math.min(revealed, col + 1);
          query = "";
        } else {
          openNextLevel();
        }
        invalidate();
        tui.requestRender();
        return;
      }

      if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
        const dir = matchesKey(data, Key.up) ? -1 : 1;
        const { names, models } = current();
        if (col === 0) {
          const tabsV = visibleTabs();
          let tIdx = tabsV.findIndex((t) => t.appType === allTabs[typeIdx]?.appType);
          if (tIdx < 0) tIdx = 0;
          tIdx = clamp(tIdx + dir, 0, tabsV.length - 1);
          const app = tabsV[tIdx]?.appType;
          const real = allTabs.findIndex((t) => t.appType === app);
          if (real >= 0) typeIdx = real;
          nameIdx = 0;
          modelIdx = 0;
          // Changing type collapses deeper columns until re-opened
          if (revealed > 0) {
            revealed = 0;
            col = 0;
          }
        } else if (col === 1) {
          nameIdx = clamp(nameIdx + dir, 0, Math.max(names.length - 1, 0));
          modelIdx = 0;
          if (revealed > 1) {
            // keep model column, list refreshes for new name
          }
        } else {
          modelIdx = clamp(modelIdx + dir, 0, Math.max(models.length - 1, 0));
        }
        invalidate();
        tui.requestRender();
        return;
      }

      if (data === "/" || data === "?") {
        // Start inline search — live-filters the focused column without nested dialogs.
        searchMode = true;
        // Keep existing query so `/` again can refine; user Esc clears.
        invalidate();
        tui.requestRender();
        return;
      }

      if (data === "m" || data === "M") {
        beginManualEntry();
        return;
      }

      if (data === "f" || data === "F") {
        const { provider } = current();
        if (!provider || !isSwitchable(provider)) {
          ctx.ui.notify("当前名称不可切换", "warning");
          return;
        }
        void doFetch(provider);
        return;
      }

      // Toggle pin for current provider + focused model (stays open).
      if (data === "p" || data === "P") {
        if (revealed < 2) {
          ctx.ui.notify("请先进入模型列再 pin", "warning");
          return;
        }
        const { provider, models } = current();
        if (!provider || !isSwitchable(provider)) {
          ctx.ui.notify("当前名称不可切换", "warning");
          return;
        }
        const mid = models[modelIdx];
        if (!mid || mid === MANUAL || mid === FETCH) {
          ctx.ui.notify("请选中具体模型再 pin", "warning");
          return;
        }
        if (!opts.onTogglePin) {
          ctx.ui.notify("未配置 pin 持久化", "warning");
          return;
        }
        void (async () => {
          try {
            const next = await opts.onTogglePin!({
              dbId: provider.id,
              model: mid,
              label: `${provider.displayName} · ${mid}`,
            });
            livePins = [...(next ?? [])];
            const nowPinned = isPinned(livePins, provider.id, mid);
            ctx.ui.notify(
              nowPinned
                ? `已 pin · ${provider.displayName} · ${mid}`
                : `已取消 pin · ${provider.displayName} · ${mid}`,
              "info",
            );
            invalidate();
            tui.requestRender();
          } catch (e) {
            ctx.ui.notify(
              `pin 失败: ${e instanceof Error ? e.message : String(e)}`,
              "error",
            );
          }
        })();
        return;
      }

      // Close custom TUI first; caller opens override dialog outside (H1: no nested UI).
      if (data === "o" || data === "O") {
        if (revealed < 1) {
          ctx.ui.notify("请先进入名称列再设置参数覆写", "warning");
          return;
        }
        const { provider, models } = current();
        if (!provider || !isSwitchable(provider)) {
          ctx.ui.notify("当前名称不可切换", "warning");
          return;
        }
        // At model level, preselect model scope from the highlighted row.
        const mid = revealed >= 2 ? models[modelIdx] : undefined;
        const modelId = mid && mid !== MANUAL && mid !== FETCH ? mid : undefined;
        finish({ kind: "override", provider, modelId });
        return;
      }

      if (matchesKey(data, Key.enter)) {
        // Progressive: enter opens next column until model level
        if (col < 2) {
          openNextLevel();
          invalidate();
          tui.requestRender();
          return;
        }
        const { provider, models } = current();
        if (!provider) return;
        if (!isSwitchable(provider)) {
          ctx.ui.notify(`不可切换: ${provider.parseError ?? "unknown"}`, "warning");
          return;
        }
        const mid = models[modelIdx];
        if (!mid) {
          ctx.ui.notify("无可用模型，可手动输入或刷新模型", "warning");
          return;
        }
        if (mid === MANUAL) {
          beginManualEntry();
          return;
        }
        if (mid === FETCH) {
          void doFetch(provider);
          return;
        }
        finish({ kind: "ok", provider, modelId: mid });
      }
    }

    return {
      render,
      invalidate,
      handleInput,
      dispose() {
        disposed = true;
      },
    };
  });
}

async function threeLevelFallback(
  ctx: PiSwitchCtx,
  opts: ThreeLevelPickOpts,
): Promise<ThreeLevelResult> {
  const tabs = buildTabs(opts.providers, opts.tabOrder);
  if (!tabs.length) return { kind: "cancel" };

  const typeLabels = tabs.map((t) => `${t.appType} ${t.count}`);
  const typePick = await ctx.ui.select("选择类型", typeLabels);
  if (!typePick) return { kind: "cancel" };
  const tab = tabs[typeLabels.indexOf(typePick)];
  if (!tab) return { kind: "cancel" };

  const names = sortProviders(
    opts.providers.filter((p) => p.appType === tab.appType),
    opts.lastDbId,
    (opts.pins ?? []).map((p) => p.dbId),
  );
  const nameLabels = names.map((p) =>
    isSwitchable(p) ? p.displayName : `${p.displayName} · 不可切换`,
  );
  const namePick = await ctx.ui.select(`选择名称 · ${tab.appType}`, nameLabels);
  if (!namePick) return { kind: "cancel" };
  const provider = names[nameLabels.indexOf(namePick)];
  if (!provider || !isSwitchable(provider)) return { kind: "cancel" };

  const models = [...provider.configModels, "✎ 手动输入", "↻ 刷新模型"];
  const modelPick = await ctx.ui.select(`选择模型 · ${provider.displayName}`, models);
  if (!modelPick) return { kind: "cancel" };
  if (modelPick === "↻ 刷新模型") {
    if (opts.fetchRemote) {
      try {
        const ids = await opts.fetchRemote(provider);
        const again = await ctx.ui.select(`选择模型 · ${provider.displayName}`, [
          ...ids,
          ...provider.configModels,
          "✎ 手动输入",
        ]);
        if (!again) return { kind: "cancel" };
        if (again === "✎ 手动输入") {
          const manual = await ctx.ui.input("输入 model id", provider.configModels[0] ?? "");
          if (!manual?.trim()) return { kind: "cancel" };
          return { kind: "ok", provider, modelId: manual.trim() };
        }
        return { kind: "ok", provider, modelId: again };
      } catch {
        return { kind: "cancel" };
      }
    }
    return { kind: "cancel" };
  }
  if (modelPick === "✎ 手动输入") {
    const manual = await ctx.ui.input("输入 model id", provider.configModels[0] ?? "");
    if (!manual?.trim()) return { kind: "cancel" };
    return { kind: "ok", provider, modelId: manual.trim() };
  }
  return { kind: "ok", provider, modelId: modelPick };
}

function clamp(n: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** Plain-text truncate by approximate display width (CJK=2). */
function truncatePlain(s: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = ch.charCodeAt(0) > 0xff ? 2 : 1;
    if (w + cw > maxCols) {
      if (maxCols >= 1) {
        // leave room for …
        while (w > maxCols - 1 && out.length) {
          const last = out[out.length - 1];
          w -= last.charCodeAt(0) > 0xff ? 2 : 1;
          out = out.slice(0, -1);
        }
        return out + "…";
      }
      return out;
    }
    out += ch;
    w += cw;
  }
  return out;
}

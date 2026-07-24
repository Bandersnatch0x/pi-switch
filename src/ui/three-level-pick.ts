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
 *   /     search in focused column
 *   m     manual model id
 *   f     refresh models (remote)
 *   esc   cancel
 *
 * Lines truncated via pi-tui visibleWidth / truncateToWidth.
 */

import type { CcProvider } from "../types.ts";
import { isSwitchable } from "../parse/index.ts";
import { buildTabs, type TabInfo } from "./tabs.ts";
import {
  filterProviders,
  sortProviders,
  yellowHighlight,
} from "./labels.ts";
import { mergeModelLists } from "../models-fetch.ts";

export type ThreeLevelResult =
  | { kind: "ok"; provider: CcProvider; modelId: string }
  | { kind: "cancel" };

export interface ThreeLevelPickOpts {
  providers: CcProvider[];
  preferredTab?: string;
  lastDbId?: string;
  lastModel?: string;
  activePiName?: string;
  tabOrder?: string[];
  fetchRemote?: (provider: CcProvider) => Promise<string[]>;
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
    formatKeyHint(theme, "esc", "cancel"),
  );
  return parts.join(sep);
}

export async function threeLevelPick(
  ctx: any,
  opts: ThreeLevelPickOpts,
): Promise<ThreeLevelResult> {
  if (typeof ctx.ui?.custom === "function") {
    try {
      return await threeLevelCustom(ctx, opts);
    } catch (err) {
      console.error("[pi-switch] three-level custom UI failed:", err);
    }
  }
  return threeLevelFallback(ctx, opts);
}

async function threeLevelCustom(
  ctx: any,
  opts: ThreeLevelPickOpts,
): Promise<ThreeLevelResult> {
  const tuiMod = await import("@earendil-works/pi-tui");
  const { matchesKey, Key, visibleWidth, truncateToWidth } = tuiMod;
  const wf: WidthFns = { visibleWidth, truncateToWidth };

  return ctx.ui.custom((tui: any, theme: any, _kb: any, done: (r: ThreeLevelResult) => void) => {
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
    const remoteById = new Map<string, string[]>();
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

    function listNames(appType: string): CcProvider[] {
      let list = opts.providers.filter((p) => p.appType === appType);
      list = sortProviders(list, opts.lastDbId);
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
      return [...list, MANUAL, FETCH];
    }

    function modelLabel(id: string): string {
      if (id === MANUAL) return "✎ 手动输入";
      if (id === FETCH) return "↻ 刷新模型";
      return id;
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

    function vsep(): string {
      return fg("dim", "│");
    }

    function headerCell(label: string, focused: boolean, colWidth: number): string {
      if (focused) {
        return fit(fg("accent", bold(`▸ ${label}`)), colWidth);
      }
      return fit(fg("muted", `  ${label}`), colWidth);
    }

    function rowMarker(selected: boolean, focused: boolean, body: string): string {
      if (selected && focused) return fg("accent", `› ${body}`);
      if (selected) return `› ${body}`;
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
      if (query) {
        metaParts.push(`搜索[${COL_LABELS[col]}] "${query}"`);
      }
      push(fg("dim", metaParts.join(" · ")));
      push(border(width, "borderMuted"));

      // Headers only for revealed columns
      let header = headerCell(COL_LABELS[0], col === 0, c0);
      if (revealed >= 1) header += vsep() + headerCell(COL_LABELS[1], col === 1, c1);
      if (revealed >= 2) header += vsep() + headerCell(COL_LABELS[2], col === 2, c2);
      push(header);
      push(border(width, "dim"));

      for (let row = 0; row < maxVis; row++) {
        const ti = typeScroll + row;
        const ni = nameScroll + row;
        const mi = modelScroll + row;

        let tCell = "";
        if (ti < tabs.length) {
          const tab = tabs[ti];
          const namePart = tab.appType;
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
            const name = truncatePlain(p.displayName, nameBudget);
            const ok = isSwitchable(p);
            const core = ok
              ? name
              : `${name} ${fg("dim", "·")} ${fg("warning", "不可切换")}`;
            const sel = ni === nameIdx;
            const active = opts.activePiName === p.piName;
            if (sel && col === 1) {
              nCell = fg("accent", `› ${name}${ok ? "" : " · 不可切换"}`);
            } else if (sel && active) nCell = `› ${yellowHighlight(name)}`;
            else if (sel) nCell = `› ${ok ? name : `${name} · 不可切换`}`;
            else if (active) nCell = `  ${yellowHighlight(name)}`;
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
            const text = truncatePlain(modelLabel(mid), Math.max(4, c2 - 2));
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
            : modelLabel(mid ?? "—");
        parts.push(fg("accent", modelPart));
      }
      let pos = `  ${tIdx + 1}/${Math.max(tabs.length, 1)}`;
      if (revealed >= 1) pos += ` · ${nameIdx + 1}/${Math.max(names.length, 1)}`;
      if (revealed >= 2) pos += ` · ${modelIdx + 1}/${Math.max(models.length, 1)}`;
      push(parts.join(arrow) + fg("dim", pos));

      push(formatFooterHints(theme, { revealed, col }));
      push(border(width, "accent"));

      cache = out.map((l) => line(l, width));
      cacheWidth = width;
      return cache;
    }

    function invalidate() {
      cache = undefined;
      cacheWidth = -1;
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

      if (matchesKey(data, Key.escape)) {
        finish({ kind: "cancel" });
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
        void (async () => {
          const scope = COL_LABELS[col];
          const q = await ctx.ui.input(`搜索${scope}`, query);
          query = q?.trim() ?? "";
          if (col === 0) typeIdx = 0;
          nameIdx = 0;
          modelIdx = 0;
          invalidate();
          tui.requestRender();
        })();
        return;
      }

      if (data === "m" || data === "M") {
        void (async () => {
          const { provider } = current();
          if (!provider || !isSwitchable(provider)) {
            ctx.ui.notify("当前名称不可切换", "warning");
            return;
          }
          const manual = await ctx.ui.input(
            "输入 model id",
            provider.configModels[0] ?? "",
          );
          if (manual?.trim()) {
            finish({ kind: "ok", provider, modelId: manual.trim() });
          }
        })();
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
          void (async () => {
            const manual = await ctx.ui.input(
              "输入 model id",
              provider.configModels[0] ?? "",
            );
            if (manual?.trim()) {
              finish({ kind: "ok", provider, modelId: manual.trim() });
            }
          })();
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
  ctx: any,
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

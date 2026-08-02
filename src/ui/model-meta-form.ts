/**
 * Model meta override editor — hand-written TUI form matching the
 * three-level-pick visual style (─ border, › row markers, dim meta).
 *
 * The interactive (TUI) path renders a single-screen form via
 * `ctx.ui.custom` with hand-written `render()` + `handleInput()`:
 *   - reasoning uses inline value cycling (不覆写 / true / false)
 *   - contextWindow / maxTokens / 预设 / 作用域 open a `SelectList` submenu
 *   - thinkingFormat opens a `SelectList` submenu
 *   - each row's `currentValue` shows 覆写 / 继承 / 默认 so inheritance is visible
 *   - unsaved edits are marked with ✱ and confirmed before discard
 *
 * Non-interactive fallback lives in `model-meta-dialog.ts` and runs when
 * `ctx.ui.custom` is unavailable (RPC / headless / tests). Both paths consume
 * the same `ModelMetaDialogInput` and return the same `ModelMetaDialogResult`,
 * so persistence (`openProviderOverride`) stays identical.
 *
 * Pure helpers (`buildFormItems`, `*SubmenuOptions`, `resolveCountPick`, …)
 * are exported and unit-tested directly; the thin TUI glue that wires
 * the hand-written form into `ctx.ui.custom` is not — it depends on the pi-tui
 * runtime and is exercised manually.
 */

import {
  cleanModelMeta,
  inheritedModelMetaBelowExact,
  mergeModelMeta,
  matchExactModelOverride,
  matchModelOverride,
  MODEL_META_PRESETS,
  type ModelMetaField,
  type ModelMetaPreset,
} from "../model-meta.ts";
import { THINKING_FORMATS } from "../types.ts";
import type { ModelMetaOverride } from "../types.ts";
import type { PiSwitchCtx } from "../pi-context.ts";
import type {
  ModelMetaDialogInput,
  ModelMetaDialogResult,
  ModelMetaScope,
} from "./model-meta-dialog.ts";
import { formatCount, parseCount } from "./model-meta-dialog.ts";
import type { SettingItem, SelectItem } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** Item ids used by the form. Exported so tests can assert. */
export const FORM_ITEM_ID = {
  scope: "scope",
  preset: "preset",
  reasoning: "reasoning",
  contextWindow: "contextWindow",
  maxTokens: "maxTokens",
  thinkingFormat: "thinkingFormat",
  clearScope: "clearScope",
  clearAll: "clearAll",
  save: "save",
  cancel: "cancel",
} as const;

/** Sentinel values never shown directly; resolved in submenu handlers. */
export const CUSTOM_VALUE = "\u0000custom";
export const INHERIT_VALUE = "\u0000inherit";

/** Same presets as the fallback dialog; keep the two paths visually aligned. */
export const CONTEXT_PRESETS = [200_000, 256_000, 500_000, 1_000_000];
export const MAX_TOKENS_PRESETS = [4_096, 8_192, 16_000, 32_000, 64_000, 128_000];

export interface SelectItemLike {
  value: string;
  label: string;
  description?: string;
}

export interface SettingItemLike {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];
}

/* ---------------------------------------------------------------- helpers */

export function scopeLabel(scope: ModelMetaScope): string {
  return scope.kind === "provider" ? "全部模型" : `模型 ${scope.modelId}`;
}

function fmtFieldValue(field: ModelMetaField, value: boolean | number | string): string {
  if (typeof value === "number") return formatCount(value);
  return String(value);
}

export function sameMeta(
  a: ModelMetaOverride | undefined,
  b: ModelMetaOverride | undefined,
): boolean {
  const norm = (m: ModelMetaOverride | undefined) => {
    const c = cleanModelMeta(m) ?? {};
    return JSON.stringify(
      Object.keys(c)
        .sort()
        .map((k) => [k, (c as Record<string, unknown>)[k]]),
    );
  };
  return norm(a) === norm(b);
}

export function storedFor(
  input: ModelMetaDialogInput,
  s: ModelMetaScope,
): ModelMetaOverride | undefined {
  return s.kind === "provider"
    ? cleanModelMeta(input.providerMeta)
    : matchExactModelOverride(input.modelOverrides ?? {}, s.modelId)?.modelMeta;
}

export function inheritedFor(
  input: ModelMetaDialogInput,
  s: ModelMetaScope,
): ModelMetaOverride | undefined {
  return s.kind === "provider"
    ? cleanModelMeta(input.base)
    : inheritedModelMetaBelowExact(
        input.base,
        input.providerMeta,
        input.modelOverrides,
        s.modelId,
      );
}

function ownInheritDefault(
  field: ModelMetaField,
  draft: ModelMetaOverride,
  inherited: ModelMetaOverride | undefined,
  tier: ModelMetaOverride | undefined,
): { state: "override" | "inherit" | "default"; display: string } {
  const own = draft[field];
  if (own !== undefined) return { state: "override", display: fmtFieldValue(field, own) };
  const inh = inherited?.[field];
  if (inh !== undefined) return { state: "inherit", display: fmtFieldValue(field, inh) };
  const t = tier?.[field];
  if (t !== undefined) return { state: "default", display: fmtFieldValue(field, t) };
  return { state: "default", display: "" };
}

function fieldStateText(
  field: ModelMetaField,
  draft: ModelMetaOverride,
  inherited: ModelMetaOverride | undefined,
  tier: ModelMetaOverride | undefined,
): string {
  const { state, display } = ownInheritDefault(field, draft, inherited, tier);
  const tag = state === "override" ? "覆写" : state === "inherit" ? "继承" : "默认";
  return display ? `${tag} ${display}` : tag;
}

/* ---------------------------------------------------- count submenu items */

export function countSubmenuOptions(
  field: "contextWindow" | "maxTokens",
  _draft: ModelMetaOverride,
  inherited: ModelMetaOverride | undefined,
  tier: ModelMetaOverride | undefined,
): SelectItemLike[] {
  const presets = field === "contextWindow" ? CONTEXT_PRESETS : MAX_TOKENS_PRESETS;
  const inheritedValue = inherited?.[field] ?? tier?.[field];
  const items: SelectItemLike[] = presets.map((n) => {
    const compact = formatCount(n);
    return {
      value: String(n),
      label: compact === String(n) ? compact : `${compact} · ${n}`,
    };
  });
  items.push({ value: CUSTOM_VALUE, label: "✎ 自定义…", description: "输入数字（可带 k/M）" });
  items.push({
    value: INHERIT_VALUE,
    label:
      inheritedValue === undefined
        ? "不覆写（继承默认）"
        : `不覆写（继承 ${formatCount(inheritedValue as number)}）`,
    description: "清除该字段的覆写",
  });
  return items;
}

/** Resolve a count submenu pick into an action. */
export function resolveCountPick(
  pick: string,
): { kind: "value"; n: number } | { kind: "inherit" } | { kind: "custom" } {
  if (pick === INHERIT_VALUE) return { kind: "inherit" };
  if (pick === CUSTOM_VALUE) return { kind: "custom" };
  const n = Number(pick);
  if (Number.isFinite(n) && n > 0) return { kind: "value", n };
  return { kind: "custom" };
}

/* ------------------------------------------------ thinking submenu items */

export function thinkingSubmenuOptions(
  _draft: ModelMetaOverride,
  inherited: ModelMetaOverride | undefined,
  _tier: ModelMetaOverride | undefined,
): SelectItemLike[] {
  const inheritedValue = inherited?.thinkingFormat;
  const items: SelectItemLike[] = THINKING_FORMATS.map((f) => ({ value: f, label: f }));
  items.push({
    value: INHERIT_VALUE,
    label:
      inheritedValue === undefined
        ? "不覆写（继承默认）"
        : `不覆写（继承 ${inheritedValue}）`,
    description: "清除 thinkingFormat 覆写",
  });
  return items;
}

/* --------------------------------------------------- scope submenu items */

export function scopeSubmenuOptions(input: ModelMetaDialogInput): SelectItemLike[] {
  const providerMeta = cleanModelMeta(input.providerMeta);
  const modelOverrides = input.modelOverrides ?? {};
  const items: SelectItemLike[] = [
    {
      value: "provider",
      label: `全部模型（provider 级）${providerMeta ? " ⚙" : ""}`,
      description: "对该 Provider 所有模型生效",
    },
  ];
  for (const id of input.models ?? []) {
    const hit = matchModelOverride(modelOverrides, id);
    items.push({
      value: `model::${id}`,
      label: `${id}${hit?.modelMeta ? " ⚙" : ""}`,
      description: hit?.modelMeta ? "已有模型级覆写" : "仅本模型",
    });
  }
  items.push({
    value: "manual",
    label: "✎ 手动输入 model id / glob",
    description: "如 gpt-5* / *sonnet*",
  });
  return items;
}

export function parseScopePick(
  pick: string,
): { kind: "provider" } | { kind: "model"; modelId: string } | { kind: "manual" } {
  if (pick === "provider") return { kind: "provider" };
  if (pick === "manual") return { kind: "manual" };
  if (pick.startsWith("model::")) return { kind: "model", modelId: pick.slice("model::".length) };
  return { kind: "manual" };
}

/* ------------------------------------------------- preset submenu items */

export function presetSubmenuOptions(): SelectItemLike[] {
  return MODEL_META_PRESETS.map((p: ModelMetaPreset) => ({
    value: p.label,
    label: `${p.label} · ${p.description}`,
  }));
}

export function findPresetByLabel(label: string): ModelMetaPreset | undefined {
  return MODEL_META_PRESETS.find((p) => p.label === label);
}

export function applyPresetToDraft(draft: ModelMetaOverride, preset: ModelMetaPreset): void {
  Object.assign(draft, cleanModelMeta(preset.modelMeta) ?? {});
}

/* ----------------------------------------------- reasoning inline values */

export function reasoningValues(draft: ModelMetaOverride): string[] {
  // SettingsList's Enter/Space cycles `values`. Put 不覆写 first so the first
  // press from an unset state ratchets toward explicit is intentional (matches
  // fallback ordering).
  return ["不覆写", "true", "false"];
}

export function currentValueForReasoning(
  draft: ModelMetaOverride,
  inherited: ModelMetaOverride | undefined,
  tier: ModelMetaOverride | undefined,
): string {
  return fieldStateText("reasoning", draft, inherited, tier);
}

/* --------------------------------------------------- main items builder */

/**
 * Build the `SettingItem[]` for the SettingsList. `submenu` callbacks are
 * attached by the TUI glue; this builder stays pure (unit-testable, no runtime
 * deps) and only sets label / currentValue / values / description per item.
 */
export function buildFormItems(
  input: ModelMetaDialogInput,
  scope: ModelMetaScope,
  draft: ModelMetaOverride,
): SettingItemLike[] {
  const inherited = inheritedFor(input, scope);
  const tier = input.tier;
  const stored = storedFor(input, scope);
  const hasAnyOverride =
    Boolean(cleanModelMeta(input.providerMeta)) ||
    Object.keys(input.modelOverrides ?? {}).length > 0;

  const items: SettingItemLike[] = [];

  items.push({
    id: FORM_ITEM_ID.scope,
    label: "作用域",
    currentValue: scopeLabel(scope),
    description: "切换编辑哪一层（provider 全部模型 / 单个模型 / glob）",
  });

  items.push({
    id: FORM_ITEM_ID.preset,
    label: "预设",
    currentValue: "选择…",
    description: "一键套用中转兼容 / 完整推理等常用组合",
  });

  items.push({
    id: FORM_ITEM_ID.reasoning,
    label: "reasoning",
    currentValue: currentValueForReasoning(draft, inherited, tier),
    description: "允许 reasoning/thinking；false 在中转拒收时仍用普通模式",
    values: reasoningValues(draft),
  });

  items.push({
    id: FORM_ITEM_ID.contextWindow,
    label: "contextWindow",
    currentValue: fieldStateText("contextWindow", draft, inherited, tier),
    description: "上下文窗口大小",
  });

  items.push({
    id: FORM_ITEM_ID.maxTokens,
    label: "maxTokens",
    currentValue: fieldStateText("maxTokens", draft, inherited, tier),
    description: "单次输出最大 tokens",
  });

  items.push({
    id: FORM_ITEM_ID.thinkingFormat,
    label: "thinkingFormat",
    currentValue: fieldStateText("thinkingFormat", draft, inherited, tier),
    description: "thinking 块解析格式",
  });

  if (cleanModelMeta(draft) || stored) {
    items.push({
      id: FORM_ITEM_ID.clearScope,
      label: "—",
      currentValue: `清除本层覆写（${scopeLabel(scope)}）`,
      description: "删除该层的 modelMeta",
    });
  }
  if (hasAnyOverride) {
    items.push({
      id: FORM_ITEM_ID.clearAll,
      label: "—",
      currentValue: "清除该 Provider 全部覆写",
      description: "删除 provider 级 + 全部按模型覆写",
    });
  }

  items.push({
    id: FORM_ITEM_ID.save,
    label: "保存",
    currentValue: "保存并关闭",
    description: "持久化到 ~/.pi/agent/pi-switch.json",
  });
  items.push({
    id: FORM_ITEM_ID.cancel,
    label: "取消",
    currentValue: "退出",
    description: "放弃改动并关闭",
  });

  return items;
}

/* ----------------------------------------------------------- TUI wrapper */

/** Notify/input/confirm surface drawn from ctx.ui. Mirrors ExtensionUIContext. */
interface FormNotify {
  notify?: ExtensionUIContext["notify"];
  input?: ExtensionUIContext["input"];
  confirm?: ExtensionUIContext["confirm"];
}

/** Title shown above the list. */
export function formTitle(
  input: ModelMetaDialogInput,
  scope: ModelMetaScope,
  dirty: boolean,
): string {
  return `参数覆写 · ${input.provider.displayName} · ${scopeLabel(scope)}${dirty ? " ✱" : ""}`;
}

/**
 * Interactive TUI editor — hand-written render + handleInput matching the
 * three-level-pick visual style (─ border, › row markers, dim meta).
 * Returns the same result shape as the fallback.
 * Caller (`openProviderOverride`) guards with `mode === "tui"` and
 * `typeof ctx.ui?.custom === "function"`, and falls back on any failure.
 *
 * Single view with two modes sharing one state closure:
 *   - "main": bordered list rendered by `renderMain()` — title + meta + rows
 *     from `buildFormItems`. ↑↓ navigate; Enter/Space activate (cycle
 *     reasoning values, open SelectList submenu, save/cancel).
 *   - submenu: `renderSubmenu()` wraps a `SelectList` or `Input` inside the
 *     same border frame; Esc closes back to main.
 * `renderCache` is cleared on every state change via `rerender()`.
 */
export async function runModelMetaForm(
  ctx: PiSwitchCtx,
  input: ModelMetaDialogInput,
): Promise<ModelMetaDialogResult> {
  const ui: FormNotify = ctx.ui ?? {};
  const tuiMod = await import("@earendil-works/pi-tui");
  const { matchesKey, visibleWidth, truncateToWidth, Input, SelectList } = tuiMod as any;

  let scope: ModelMetaScope = input.scope;
  let stored = storedFor(input, scope);
  let draft: ModelMetaOverride = { ...(stored ?? {}) };

  const dirty = (): boolean => !sameMeta(draft, stored);

  const confirmDiscard = async (): Promise<boolean> => {
    if (!dirty()) return true;
    if (typeof ui.confirm !== "function") return true;
    return ui.confirm("未保存改动", "有未保存的修改，放弃并退出？");
  };

  return ctx.ui!.custom!<ModelMetaDialogResult>((tuiAny: any, themeAny: any, _kb: any, done) => {
    let disposed = false;
    const tui = tuiAny as { requestRender?: () => void };
    const theme = themeAny as {
      fg: (c: string, s: string) => string;
      bold: (s: string) => string;
    };

    function fg(key: string, s: string): string {
      return typeof theme?.fg === "function" ? theme.fg(key, s) : s;
    }
    function bold(s: string): string {
      return typeof theme?.bold === "function" ? theme.bold(s) : s;
    }
    function vw(s: string): number {
      return visibleWidth(s);
    }
    function padR(s: string, w: number): string {
      const n = Math.max(0, w - vw(s as any));
      return s + " ".repeat(n);
    }
    function line(s: string, termWidth: number): string {
      const w = Math.max(1, termWidth);
      if (vw(s as any) <= w) return s as any;
      return truncateToWidth(s as any, w, "…", false) as any;
    }
    function border(w: number, color: "accent" | "borderMuted" | "dim" = "accent"): string {
      return fg(color, "─".repeat(Math.max(1, w)));
    }

    function finish(r: ModelMetaDialogResult) {
      if (disposed) return;
      disposed = true;
      done(r);
    }

    /* ---------------- main view state ---------------- */
    // Rebuild items each render; cheap enough and always fresh.
    let selIdx = 0;
    let query = "";
    let queryActive = false;
    let scroll = 0;
    const maxVis = 10;

    // submenu state
    type ViewMode =
      | "main"
      | { kind: "count"; field: "contextWindow" | "maxTokens"; sl: any; opts: SelectItem[] }
      | { kind: "thinking"; sl: any; opts: SelectItem[] }
      | { kind: "scope"; sl: any; opts: SelectItem[] }
      | { kind: "preset"; sl: any; opts: SelectItem[] }
      | { kind: "customCount"; field: "contextWindow" | "maxTokens"; inp: any }
      | { kind: "confirm"; id: "clearScope" | "clearAll"; sl: any; opts: SelectItem[] };
    let viewMode: ViewMode = "main";

    function rerender(): void {
      renderCache = undefined;
      renderCacheWidth = -1;
      tui?.requestRender?.();
    }

    function filteredItems(): SettingItem[] {
      const all = buildFormItems(input, scope, draft);
      if (!queryActive || !query) return all;
      const q = query.toLowerCase();
      return all.filter((i) => (i.label + " " + i.currentValue).toLowerCase().includes(q));
    }

    function ensureScroll(): void {
      const items = filteredItems();
      if (selIdx < 0) selIdx = 0;
      if (selIdx >= items.length) selIdx = Math.max(0, items.length - 1);
      scroll = Math.max(0, Math.min(scroll, Math.max(0, items.length - maxVis)));
      if (selIdx < scroll) scroll = selIdx;
      else if (selIdx >= scroll + maxVis) scroll = selIdx - maxVis + 1;
    }

    function renderMain(width: number): string[] {
      const out: string[] = [];
      const push = (s: string) => out.push(line(s, width) as any);
      push(border(width, "accent"));
      push(fg("accent", bold(formTitle(input, scope, dirty()))));
      const metaParts: string[] = [];
      metaParts.push(`${filteredItems().length} 项`);
      if (queryActive) metaParts.push(`搜索 "${query}"`);
      push(fg("dim", metaParts.join(" · ")));
      push(border(width, "borderMuted"));
      const items = filteredItems();
      const maxLabelW = Math.min(20, Math.max(...items.map((i) => vw(i.label as any)), 8));
      ensureScroll();
      for (let r = 0; r < maxVis; r++) {
        const idx = scroll + r;
        if (idx >= items.length) {
          push("");
          continue;
        }
        const it = items[idx];
        const sel = idx === selIdx;
        const marker = sel ? fg("accent", "›") : " ";
        const label = padR(it.label, maxLabelW);
        const labelText = sel ? fg("accent", bold(label as any)) : label;
        // Paint currentValue with accent when selected (was computed then unused).
        const rawVal = it.currentValue;
        const valuePadded = "  " + padR(rawVal, Math.max(20, width - maxLabelW - 6));
        const valText = sel ? fg("accent", valuePadded as any) : fg("muted", valuePadded as any);
        // Keep description only when it fits; avoid overwriting the value column.
        const base = `${marker} ${labelText}${valText}`;
        const desc =
          it.description && sel && vw(base as any) < width - 12
            ? fg("dim", `  → ${it.description}`)
            : "";
        push(`${base}${desc}`);
      }
      push(border(width, "dim"));
      const hint = queryActive
        ? fg("dim", "输入搜索 · Esc 关闭搜索")
        : fg("dim", "Enter 切换/子菜单 · ↑↓ 选择 · / 搜索 · s 保存 · Esc 返回");
      push(hint);
      return out;
    }

    /* ---------------- submenu openers ---------------- */

    function openCountSubmenu(field: "contextWindow" | "maxTokens"): void {
      const inherited = inheritedFor(input, scope);
      const opts = countSubmenuOptions(field, draft, inherited, input.tier).map((o) => ({
        value: o.value,
        label: o.label,
        description: o.description,
      })) as SelectItem[];
      const sl = new SelectList(opts, Math.min(opts.length, 12), makeSelectTheme());
      const idx = opts.findIndex((o) => o.value === (draft[field] != null ? String(draft[field]) : undefined));
      if (idx >= 0) sl.setSelectedIndex(idx);
      sl.onSelect = (item: SelectItem) => onCountPick(field, item.value);
      sl.onCancel = () => closeSubmenu();
      viewMode = { kind: "count", field, sl, opts };
      rerender();
    }

    function openThinkingSubmenu(): void {
      const inherited = inheritedFor(input, scope);
      const opts = thinkingSubmenuOptions(draft, inherited, input.tier).map((o) => ({
        value: o.value,
        label: o.label,
        description: o.description,
      })) as SelectItem[];
      const sl = new SelectList(opts, Math.min(opts.length, 12), makeSelectTheme());
      const idx = opts.findIndex((o) => o.value === draft.thinkingFormat);
      if (idx >= 0) sl.setSelectedIndex(idx);
      sl.onSelect = (item: SelectItem) => onThinkingPick(item.value);
      sl.onCancel = () => closeSubmenu();
      viewMode = { kind: "thinking", sl, opts };
      rerender();
    }

    function openScopeSubmenu(): void {
      const opts = scopeSubmenuOptions(input).map((o) => ({
        value: o.value,
        label: o.label,
        description: o.description,
      })) as SelectItem[];
      const sl = new SelectList(opts, Math.min(opts.length, 12), makeSelectTheme());
      const cur = scope.kind === "provider" ? "provider" : `model::${scope.modelId}`;
      const idx = opts.findIndex((o) => o.value === cur);
      if (idx >= 0) sl.setSelectedIndex(idx);
      sl.onSelect = (item: SelectItem) => {
        void onScopePick(item.value);
      };
      sl.onCancel = () => closeSubmenu();
      viewMode = { kind: "scope", sl, opts };
      rerender();
    }

    function openPresetSubmenu(): void {
      const opts = presetSubmenuOptions().map((o) => ({
        value: o.value,
        label: o.label,
        description: o.description,
      })) as SelectItem[];
      const sl = new SelectList(opts, Math.min(opts.length, 12), makeSelectTheme());
      sl.onSelect = (item: SelectItem) => onPresetPick(item.value);
      sl.onCancel = () => closeSubmenu();
      viewMode = { kind: "preset", sl, opts };
      rerender();
    }

    function openConfirmSubmenu(id: "clearScope" | "clearAll"): void {
      const msg =
        id === "clearScope"
          ? `清除 ${input.provider.displayName} · ${scopeLabel(scope)} 的 modelMeta 覆写？`
          : `清除 ${input.provider.displayName} 的 provider 级与全部按模型覆写？`;
      const opts: SelectItem[] = [
        { value: "confirm", label: `确认：${msg}` },
        { value: "cancel", label: "取消" },
      ];
      const sl = new SelectList(opts, 8, makeSelectTheme());
      sl.onSelect = (item: SelectItem) => {
        if (item.value === "confirm") {
          if (id === "clearScope") finish({ kind: "clear", scope });
          else finish({ kind: "clearAll" });
        } else {
          closeSubmenu();
        }
      };
      sl.onCancel = () => closeSubmenu();
      viewMode = { kind: "confirm", id, sl, opts };
      rerender();
    }

    function openCustomCountInput(field: "contextWindow" | "maxTokens"): void {
      const inp = new Input();
      if (draft[field] != null) inp.setValue(String(draft[field]));
      inp.onSubmit = (val: string) => onCustomCountSubmit(field, val);
      inp.onEscape = () => closeSubmenu();
      viewMode = { kind: "customCount", field, inp };
      rerender();
    }

    function closeSubmenu(): void {
      viewMode = "main";
      selIdx = Math.min(selIdx, Math.max(0, filteredItems().length - 1));
      rerender();
    }

    /* ---------------- submenu pick handlers ---------------- */

    function onCountPick(field: "contextWindow" | "maxTokens", value: string): void {
      const r = resolveCountPick(value);
      if (r.kind === "inherit") {
        delete draft[field];
        closeSubmenu();
      } else if (r.kind === "value") {
        draft[field] = r.n;
        closeSubmenu();
      } else {
        openCustomCountInput(field);
      }
    }

    function onCustomCountSubmit(field: "contextWindow" | "maxTokens", val: string): void {
      const n = parseCount(val);
      if (n === undefined) {
        closeSubmenu();
        return;
      }
      if (Number.isNaN(n as number)) {
        ui.notify?.("请输入正整数，可带 k/M 后缀", "warning");
        return;
      }
      draft[field] = n as number;
      ui.notify?.(`${field} = ${formatCount(n as number)}（未保存）`, "info");
      closeSubmenu();
    }

    function onThinkingPick(value: string): void {
      if (value === INHERIT_VALUE) delete draft.thinkingFormat;
      else draft.thinkingFormat = value;
      closeSubmenu();
    }

    function onPresetPick(label: string): void {
      const preset = findPresetByLabel(label);
      if (preset) {
        applyPresetToDraft(draft, preset);
        ui.notify?.(`已应用预设：${preset.label}（未保存）`, "info");
      }
      closeSubmenu();
    }

    async function onScopePick(value: string): Promise<void> {
      // Switching scope reloads draft from disk layers; confirm before discard.
      if (dirty() && !(await confirmDiscard())) {
        closeSubmenu();
        return;
      }
      const r = parseScopePick(value);
      if (r.kind === "manual") {
        if (typeof ui.input === "function") {
          const raw = await ui.input("model id 或 glob（如 gpt-5* / *sonnet*）", "");
          const id = raw?.trim();
          if (id) {
            scope = { kind: "model", modelId: id };
            stored = storedFor(input, scope);
            draft = { ...(stored ?? {}) };
          }
        }
      } else if (r.kind === "provider") {
        scope = { kind: "provider" };
        stored = storedFor(input, scope);
        draft = { ...(stored ?? {}) };
      } else {
        scope = { kind: "model", modelId: r.modelId };
        stored = storedFor(input, scope);
        draft = { ...(stored ?? {}) };
      }
      selIdx = 0;
      closeSubmenu();
    }

    /* ---------------- main item activation ---------------- */

    function activateMain(): void {
      const items = filteredItems();
      const it = items[selIdx];
      if (!it) return;
      const id = it.id;
      switch (id) {
        case FORM_ITEM_ID.scope:
          openScopeSubmenu();
          return;
        case FORM_ITEM_ID.preset:
          openPresetSubmenu();
          return;
        case FORM_ITEM_ID.contextWindow:
          openCountSubmenu("contextWindow");
          return;
        case FORM_ITEM_ID.maxTokens:
          openCountSubmenu("maxTokens");
          return;
        case FORM_ITEM_ID.thinkingFormat:
          openThinkingSubmenu();
          return;
        case FORM_ITEM_ID.reasoning: {
          // inline cycle 覆写true→覆写false→不覆写→覆写true
          const cur = currentValueForReasoning(draft, inheritedFor(input, scope), input.tier);
          if (cur === "覆写 true") draft.reasoning = false;
          else if (cur === "覆写 false") delete draft.reasoning;
          else draft.reasoning = true;
          rerender();
          return;
        }
        case FORM_ITEM_ID.clearScope:
          openConfirmSubmenu("clearScope");
          return;
        case FORM_ITEM_ID.clearAll:
          openConfirmSubmenu("clearAll");
          return;
        case FORM_ITEM_ID.save: {
          if (!dirty()) {
            ui.notify?.("无改动", "info");
            finish({ kind: "cancel" });
            return;
          }
          const cleaned = cleanModelMeta(draft);
          if (!cleaned) finish({ kind: "clear", scope });
          else finish({ kind: "save", scope, modelMeta: cleaned });
          return;
        }
        case FORM_ITEM_ID.cancel: {
          void (async () => {
            const ok = await confirmDiscard();
            if (ok) finish({ kind: "cancel" });
            else if (!disposed) rerender(); // nested confirm closed without discard
          })();
          return;
        }
        default:
          return;
      }
    }

    /* ---------------- input routing ---------------- */

    function handleInput(data: string): void {
      if (disposed) return;
      const vm = viewMode;
      // submenu input first
      if (vm !== "main") {
        if (vm.kind === "customCount") {
          // Esc custom to main
          if (matchesKey(data, "escape")) {
            closeSubmenu();
            return;
          }
          vm.inp.handleInput(data);
          // Input mutates in place (typing); onSubmit/onEscape may close via
          // callbacks. Always repaint while still on this view so the value
          // is visible — without this, custom count looks frozen.
          if (viewMode !== "main") rerender();
          return;
        }
        // other submenus (SelectList or confirm)
        if (matchesKey(data, "escape")) {
          closeSubmenu();
          return;
        }
        // Main form treats Space as activate; SelectList only binds Enter.
        // Map Space → confirm so preset/count/scope submenus feel consistent.
        if (matchesKey(data, "space")) {
          const item = typeof vm.sl.getSelectedItem === "function" ? vm.sl.getSelectedItem() : null;
          if (item && typeof vm.sl.onSelect === "function") vm.sl.onSelect(item);
          if (viewMode !== "main") rerender();
          return;
        }
        vm.sl.handleInput(data);
        // SelectList updates selectedIndex in place. onSelect → closeSubmenu
        // already rerenders; up/down would otherwise leave renderCache stale
        // so the › cursor never moves (user reports "无法修改").
        if (viewMode !== "main") rerender();
        return;
      }
      // main view
      if (queryActive) {
        if (matchesKey(data, "escape")) {
          queryActive = false;
          query = "";
          rerender();
          return;
        }
        if (matchesKey(data, "enter")) {
          // Capture the filtered hit BEFORE clearing search. Otherwise selIdx
          // is re-interpreted against the full list and activates the wrong row.
          const hit = filteredItems()[selIdx];
          queryActive = false;
          query = "";
          if (hit) {
            const full = buildFormItems(input, scope, draft);
            const fullIdx = full.findIndex((i) => i.id === hit.id);
            if (fullIdx >= 0) selIdx = fullIdx;
            activateMain();
          }
          if (!disposed && viewMode === "main") rerender();
          return;
        }
        // Backspace / DEL before printable: \x7f has code 127 (>= 32) and would
        // otherwise be appended to the query as a visible control char.
        if (data === "\x7f" || data === "\b") {
          query = query.slice(0, -1);
          selIdx = 0;
          rerender();
          return;
        }
        // type into query: accept printable chars (exclude DEL handled above)
        const ch = data;
        if (ch && ch.length === 1 && ch.charCodeAt(0) >= 32 && ch !== "\x7f") {
          query += ch;
          selIdx = 0;
          scroll = 0;
          rerender();
        } else if (matchesKey(data, "up") || matchesKey(data, "down")) {
          const items = filteredItems();
          if (matchesKey(data, "up") && selIdx > 0) selIdx--;
          else if (matchesKey(data, "down") && selIdx < items.length - 1) selIdx++;
          ensureScroll();
          rerender();
        }
        return;
      }
      if (matchesKey(data, "up")) {
        selIdx = Math.max(0, selIdx - 1);
        ensureScroll();
        rerender();
        return;
      }
      if (matchesKey(data, "down")) {
        selIdx = Math.min(filteredItems().length - 1, selIdx + 1);
        ensureScroll();
        rerender();
        return;
      }
      if (matchesKey(data, "enter") || matchesKey(data, "space")) {
        activateMain();
        return;
      }
      if (data === "/") {
        queryActive = true;
        query = "";
        rerender();
        return;
      }
      if (data === "s") {
        const items = filteredItems();
        const save = items.find((i) => i.id === FORM_ITEM_ID.save);
        if (save) {
          selIdx = items.indexOf(save);
          activateMain();
        }
        return;
      }
      if (matchesKey(data, "escape")) {
        void (async () => {
          const ok = await confirmDiscard();
          if (ok) finish({ kind: "cancel" });
          else if (!disposed) rerender(); // nested confirm closed without discard
        })();
        return;
      }
    }

    /* ---------------- submenu render ---------------- */

    function renderSubmenu(width: number): string[] {
      if (viewMode === "main") return [];
      const vm: Exclude<ViewMode, "main"> = viewMode;
      const out: string[] = [];
      const push = (s: string) => out.push(line(s, width) as any);
      push(border(width, "accent"));
      let title = "";
      if (vm.kind === "count") title = `${vm.field} · ${scopeLabel(scope)}`;
      else if (vm.kind === "thinking") title = `thinkingFormat · ${scopeLabel(scope)}`;
      else if (vm.kind === "scope") title = `作用域 · ${input.provider.displayName}`;
      else if (vm.kind === "preset") title = "预设 · 选择常用组合";
      else if (vm.kind === "confirm")
        title = vm.id === "clearScope" ? "清除本层覆写" : "清除全部覆写";
      else if (vm.kind === "customCount") title = `自定义 ${vm.field}`;
      push(fg("accent", bold(title)));
      push(border(width, "borderMuted"));
      if (vm.kind === "customCount") {
        const val = (vm.inp as any).getValue?.() ?? "";
        push(`  ${fg("accent", val)}${fg("dim", "_")}`);
        push("");
        push(fg("dim", "输入数字（200k / 1M / 200000）· Enter 确认 · Esc 返回"));
        return out;
      }
      // SelectList renders its own rows (customCount returned above).
      const lines = vm.sl.render(width - 4) as string[];
      for (const l of lines) push(`  ${l}`);
      push("");
      push(fg("dim", "Enter 选择 · Esc 返回"));
      return out;
    }

    /* ---------------- overall render ---------------- */

    let renderCache: string[] | undefined;
    let renderCacheWidth = -1;

    function makeSelectTheme(): any {
      return {
        selectedPrefix: (t: string) => fg("accent", `› ${t}`),
        selectedText: (t: string) => t,
        description: (t: string) => `  ${t}`,
        scrollInfo: (t: string) => t,
        noMatch: (t: string) => t,
      };
    }

    return {
      render: (w: number) => {
        if (!renderCache || renderCacheWidth !== w) {
          renderCache = viewMode === "main" ? renderMain(w) : renderSubmenu(w);
          renderCacheWidth = w;
        }
        return renderCache;
      },
      invalidate: () => {
        renderCache = undefined;
        renderCacheWidth = -1;
      },
      handleInput: (data: string) => {
        try {
          handleInput(data);
        } catch (err) {
          console.error("[pi-switch] model-meta form input:", err);
        }
      },
      dispose: () => {
        disposed = true;
      },
    };
  });
}

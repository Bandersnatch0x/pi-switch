/**
 * Model meta override dialog using Pi native select/input/confirm.
 * Avoids the cramped three-column TUI for multi-field editing.
 *
 * Editing model:
 *   - scope: provider (all models) or one model id
 *   - every field is an enum/quick-pick, never free text (thinkingFormat,
 *     reasoning tri-state, contextWindow/maxTokens presets + custom)
 *   - each row shows 覆写 / 继承 / 默认 so inheritance is visible
 *   - unsaved edits are marked and confirmed before discard
 */

import type { CcProvider } from "../types.ts";
import { THINKING_FORMATS } from "../types.ts";
import type { ModelMetaOverride } from "../types.ts";
import {
  cleanModelMeta,
  inheritedModelMetaBelowExact,
  mergeModelMeta,
  matchExactModelOverride,
  matchModelOverride,
  MODEL_META_PRESETS,
  type ModelMetaPreset,
} from "../model-meta.ts";

export type ModelMetaDialogUi = {
  select: (title: string, options: string[]) => Promise<string | undefined | null>;
  input: (prompt: string, defaultValue?: string) => Promise<string | undefined | null>;
  confirm: (message: string) => Promise<boolean>;
  notify?: (message: string, level?: "info" | "warning" | "error" | string) => void;
};

/** Which layer an edit writes to. */
export type ModelMetaScope =
  | { kind: "provider" }
  | { kind: "model"; modelId: string };

export interface ModelMetaDialogInput {
  provider: Pick<CcProvider, "id" | "displayName" | "piName">;
  /** Scope the dialog opens in. */
  scope: ModelMetaScope;
  /** Explicit provider-scope override on disk. */
  providerMeta?: ModelMetaOverride;
  /** Explicit per-model overrides on disk (keys may be globs). */
  modelOverrides?: Record<string, ModelMetaOverride>;
  /** config.defaultModelMeta */
  base?: ModelMetaOverride;
  /** Protocol-tier fallback, shown as 默认 when no layer sets a field. */
  tier?: ModelMetaOverride;
  /** Model ids offered when switching scope. */
  models?: string[];
}

export type ModelMetaDialogResult =
  | { kind: "save"; scope: ModelMetaScope; modelMeta: ModelMetaOverride }
  | { kind: "clear"; scope: ModelMetaScope }
  | { kind: "clearAll" }
  | { kind: "cancel" };

// User-requested commonly-used context windows; `自定义` covers the rest.
const CONTEXT_PRESETS = [200_000, 256_000, 500_000, 1_000_000];
const MAX_TOKENS_PRESETS = [4_096, 8_192, 16_000, 32_000, 64_000, 128_000];

const BACK = "← 返回";

/** Compact human form: 128000 → 128k, 1000000 → 1M, else exact digits. */
export function formatCount(n: number): string {
  if (n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n % 1_000 === 0) return `${n / 1_000}k`;
  return String(n);
}

/**
 * Accept 200000 / 200k / 200K / 1m / 1_000_000 / 1,000,000.
 * Returns undefined for empty, NaN for invalid.
 */
export function parseCount(raw: string): number | undefined | typeof NaN {
  const t = raw.trim().replace(/[_,\s]/g, "");
  if (!t) return undefined;
  const m = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(t);
  if (!m) return NaN;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return NaN;
  const mult = m[2] ? (m[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1;
  const n = Math.floor(value * mult);
  return n > 0 ? n : NaN;
}

function fmtFieldValue(
  field: keyof ModelMetaOverride,
  value: boolean | number | string,
): string {
  if (typeof value === "number") return formatCount(value);
  return String(value);
}

function scopeLabel(scope: ModelMetaScope): string {
  return scope.kind === "provider" ? "全部模型" : `模型 ${scope.modelId}`;
}

function sameMeta(a: ModelMetaOverride | undefined, b: ModelMetaOverride | undefined): boolean {
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

function applyPreset(draft: ModelMetaOverride, preset: ModelMetaPreset): void {
  Object.assign(draft, cleanModelMeta(preset.modelMeta) ?? {});
}

/**
 * Interactive loop to edit modelMeta for one provider or one model.
 * Returns save/clear/clearAll/cancel; caller persists.
 */
export async function runModelMetaDialog(
  ui: ModelMetaDialogUi,
  input: ModelMetaDialogInput,
): Promise<ModelMetaDialogResult> {
  const { provider } = input;
  const modelOverrides = input.modelOverrides ?? {};

  let scope: ModelMetaScope = input.scope;

  /** Explicit override stored at the current scope. */
  const storedFor = (s: ModelMetaScope): ModelMetaOverride | undefined =>
    s.kind === "provider"
      ? cleanModelMeta(input.providerMeta)
      : matchExactModelOverride(modelOverrides, s.modelId)?.modelMeta;

  /** Layers below the current scope (model: base ⊕ provider ⊕ glob-only). */
  const inheritedFor = (s: ModelMetaScope): ModelMetaOverride | undefined =>
    s.kind === "provider"
      ? cleanModelMeta(input.base)
      : inheritedModelMetaBelowExact(
          input.base,
          input.providerMeta,
          modelOverrides,
          s.modelId,
        );

  let stored = storedFor(scope);
  let draft: ModelMetaOverride = { ...(stored ?? {}) };

  const dirty = (): boolean => !sameMeta(draft, stored);

  const hasAnyOverride = (): boolean =>
    Boolean(cleanModelMeta(input.providerMeta)) || Object.keys(modelOverrides).length > 0;

  const confirmDiscard = async (): Promise<boolean> =>
    !dirty() || (await ui.confirm("有未保存的修改，放弃并退出？"));

  /** Row label for one field: 覆写 / 继承 / 默认. */
  const fieldRow = (
    field: keyof ModelMetaOverride,
    inherited: ModelMetaOverride | undefined,
  ): string => {
    const own = draft[field];
    if (own !== undefined) return `${field} · 覆写 ${fmtFieldValue(field, own)}`;
    const inh = inherited?.[field];
    if (inh !== undefined) return `${field} · 继承 ${fmtFieldValue(field, inh)}`;
    const tier = input.tier?.[field];
    if (tier !== undefined) return `${field} · 默认 ${fmtFieldValue(field, tier)}`;
    return `${field} · 默认`;
  };

  async function pickScope(): Promise<void> {
    if (!(await confirmDiscard())) return;
    const rows: { label: string; scope: ModelMetaScope }[] = [
      {
        label: `全部模型（provider 级）${cleanModelMeta(input.providerMeta) ? " ⚙" : ""}`,
        scope: { kind: "provider" },
      },
    ];
    for (const id of input.models ?? []) {
      const hit = matchModelOverride(modelOverrides, id);
      rows.push({ label: `${id}${hit?.modelMeta ? " ⚙" : ""}`, scope: { kind: "model", modelId: id } });
    }
    const MANUAL = "✎ 手动输入 model id / glob";
    const labels = [...rows.map((r) => r.label), MANUAL, BACK];
    const pick = await ui.select(`作用域 · ${provider.displayName}`, labels);
    if (!pick || pick === BACK) return;

    let next: ModelMetaScope | undefined;
    if (pick === MANUAL) {
      const raw = await ui.input("model id 或 glob（如 gpt-5* / *sonnet*）", "");
      const id = raw?.trim();
      if (!id) return;
      next = { kind: "model", modelId: id };
    } else {
      next = rows[labels.indexOf(pick)]?.scope;
    }
    if (!next) return;

    scope = next;
    stored = storedFor(scope);
    draft = { ...(stored ?? {}) };
  }

  async function pickPreset(): Promise<void> {
    const labels = [
      ...MODEL_META_PRESETS.map((p) => `${p.label} · ${p.description}`),
      BACK,
    ];
    const pick = await ui.select("预设", labels);
    if (!pick || pick === BACK) return;
    const hit = MODEL_META_PRESETS[labels.indexOf(pick)];
    if (!hit) return;
    applyPreset(draft, hit);
    ui.notify?.(`已应用预设：${hit.label}（未保存）`, "info");
  }

  async function pickReasoning(inherited: ModelMetaOverride | undefined): Promise<void> {
    const inheritedValue = inherited?.reasoning ?? input.tier?.reasoning;
    const inheritLabel =
      inheritedValue === undefined ? "不覆写（继承默认）" : `不覆写（继承 ${inheritedValue}）`;
    const labels = [inheritLabel, "true · 允许 reasoning/thinking", "false · 中转拒收时用", BACK];
    const pick = await ui.select("reasoning", labels);
    if (!pick || pick === BACK) return;
    if (pick === inheritLabel) delete draft.reasoning;
    else draft.reasoning = pick.startsWith("true");
  }

  async function pickCount(
    field: "contextWindow" | "maxTokens",
    inherited: ModelMetaOverride | undefined,
  ): Promise<void> {
    const presets = field === "contextWindow" ? CONTEXT_PRESETS : MAX_TOKENS_PRESETS;
    const inheritedValue = inherited?.[field] ?? input.tier?.[field];
    const inheritLabel =
      inheritedValue === undefined
        ? "不覆写（继承默认）"
        : `不覆写（继承 ${formatCount(inheritedValue as number)}）`;
    const CUSTOM = "✎ 自定义…";
    // Avoid "4096 · 4096": show exact value only when compact form differs.
    const presetLabel = (n: number): string => {
      const compact = formatCount(n);
      return compact === String(n) ? compact : `${compact} · ${n}`;
    };
    const labels = [
      ...presets.map(presetLabel),
      CUSTOM,
      inheritLabel,
      BACK,
    ];
    const pick = await ui.select(field, labels);
    if (!pick || pick === BACK) return;
    if (pick === inheritLabel) {
      delete draft[field];
      return;
    }
    if (pick === CUSTOM) {
      const raw = await ui.input(
        `${field}（支持 200k / 1M / 200000；空=取消）`,
        draft[field] != null ? String(draft[field]) : "",
      );
      if (raw == null) return;
      const n = parseCount(raw);
      if (n === undefined) return;
      if (Number.isNaN(n)) {
        ui.notify?.("请输入正整数，可带 k/M 后缀", "warning");
        return;
      }
      draft[field] = n as number;
      return;
    }
    const idx = labels.indexOf(pick);
    const value = presets[idx];
    if (typeof value === "number") draft[field] = value;
  }

  async function pickThinkingFormat(inherited: ModelMetaOverride | undefined): Promise<void> {
    const inheritedValue = inherited?.thinkingFormat;
    const inheritLabel =
      inheritedValue === undefined
        ? "不覆写（继承默认）"
        : `不覆写（继承 ${inheritedValue}）`;
    const labels = [inheritLabel, ...THINKING_FORMATS, BACK];
    const pick = await ui.select("thinkingFormat", labels);
    if (!pick || pick === BACK) return;
    if (pick === inheritLabel) {
      delete draft.thinkingFormat;
      return;
    }
    draft.thinkingFormat = pick;
  }

  while (true) {
    const inherited = inheritedFor(scope);
    const title = `参数覆写 · ${provider.displayName} · ${scopeLabel(scope)}${dirty() ? " ✱" : ""}`;

    const SCOPE_ROW = `作用域 · ${scopeLabel(scope)}`;
    const PRESET_ROW = "预设 · 中转兼容 / 完整推理";
    const REASONING_ROW = fieldRow("reasoning", inherited);
    const CONTEXT_ROW = fieldRow("contextWindow", inherited);
    const MAXTOKENS_ROW = fieldRow("maxTokens", inherited);
    const THINKING_ROW = fieldRow("thinkingFormat", inherited);
    const CLEAR_SCOPE_ROW = `清除本层覆写（${scopeLabel(scope)}）`;
    const CLEAR_ALL_ROW = "清除该 Provider 全部覆写";
    const SAVE_ROW = dirty() ? "保存 ✱" : "保存（无改动）";
    const CANCEL_ROW = "取消";

    const options = [SCOPE_ROW, PRESET_ROW, REASONING_ROW, CONTEXT_ROW, MAXTOKENS_ROW, THINKING_ROW];
    if (cleanModelMeta(draft) || stored) options.push(CLEAR_SCOPE_ROW);
    if (hasAnyOverride()) options.push(CLEAR_ALL_ROW);
    options.push(SAVE_ROW, CANCEL_ROW);

    const pick = await ui.select(title, options);

    // esc / dismiss
    if (!pick) {
      if (await confirmDiscard()) return { kind: "cancel" };
      continue;
    }

    if (pick === SCOPE_ROW) {
      await pickScope();
      continue;
    }
    if (pick === PRESET_ROW) {
      await pickPreset();
      continue;
    }
    if (pick === REASONING_ROW) {
      await pickReasoning(inherited);
      continue;
    }
    if (pick === CONTEXT_ROW) {
      await pickCount("contextWindow", inherited);
      continue;
    }
    if (pick === MAXTOKENS_ROW) {
      await pickCount("maxTokens", inherited);
      continue;
    }
    if (pick === THINKING_ROW) {
      await pickThinkingFormat(inherited);
      continue;
    }
    if (pick === CLEAR_SCOPE_ROW) {
      const ok = await ui.confirm(
        `清除 ${provider.displayName} · ${scopeLabel(scope)} 的 modelMeta 覆写？`,
      );
      if (ok) return { kind: "clear", scope };
      continue;
    }
    if (pick === CLEAR_ALL_ROW) {
      const ok = await ui.confirm(
        `清除 ${provider.displayName} 的 provider 级与全部按模型覆写？`,
      );
      if (ok) return { kind: "clearAll" };
      continue;
    }
    if (pick === SAVE_ROW) {
      if (!dirty()) {
        ui.notify?.("无改动", "info");
        return { kind: "cancel" };
      }
      const cleaned = cleanModelMeta(draft);
      if (!cleaned) return { kind: "clear", scope };
      return { kind: "save", scope, modelMeta: cleaned };
    }
    if (pick === CANCEL_ROW) {
      if (await confirmDiscard()) return { kind: "cancel" };
      continue;
    }
  }
}

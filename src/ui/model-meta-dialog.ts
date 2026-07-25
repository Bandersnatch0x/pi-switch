/**
 * Model meta override dialog using Pi native select/input/confirm.
 * Avoids the cramped three-column TUI for multi-field editing.
 *
 * Includes presets for common upstream rejection policies
 * (relay-safe / full-reasoning).
 */

import type { CcProvider } from "../types.ts";
import { isThinkingFormat, THINKING_FORMATS } from "../types.ts";
import type { ModelMetaOverride } from "../types.ts";
import { MODEL_META_PRESETS, type ModelMetaPreset } from "../model-meta.ts";

export type ModelMetaDialogUi = {
  select: (title: string, options: string[]) => Promise<string | undefined | null>;
  input: (prompt: string, defaultValue?: string) => Promise<string | undefined | null>;
  confirm: (message: string) => Promise<boolean>;
  notify?: (message: string, level?: "info" | "warning" | "error" | string) => void;
};

export type ModelMetaDialogResult =
  | { kind: "save"; modelMeta: ModelMetaOverride }
  | { kind: "clear" }
  | { kind: "cancel" };

function fmtReasoning(v: boolean | undefined): string {
  if (v === true) return "true";
  if (v === false) return "false";
  return "默认";
}

function fmtNum(v: number | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "默认";
}

function fmtStr(v: string | undefined): string {
  const t = v?.trim();
  return t ? t : "默认";
}

function parsePositiveInt(raw: string): number | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return Math.floor(n);
}

function presetOption(p: ModelMetaPreset): string {
  return `预设 · ${p.label}（${p.description.split(" — ")[0] ?? p.id}）`;
}

function applyPreset(draft: ModelMetaOverride, preset: ModelMetaPreset): void {
  // Replace known fields from preset; keep unrelated custom fields.
  if (typeof preset.modelMeta.reasoning === "boolean") {
    draft.reasoning = preset.modelMeta.reasoning;
  } else {
    delete draft.reasoning;
  }
  if (preset.modelMeta.thinkingFormat) {
    draft.thinkingFormat = preset.modelMeta.thinkingFormat;
  }
  if (typeof preset.modelMeta.contextWindow === "number") {
    draft.contextWindow = preset.modelMeta.contextWindow;
  }
  if (typeof preset.modelMeta.maxTokens === "number") {
    draft.maxTokens = preset.modelMeta.maxTokens;
  }
}

/**
 * Interactive loop to edit modelMeta for one provider.
 * Returns save/clear/cancel; caller is responsible for persistence.
 */
export async function runModelMetaDialog(
  ui: ModelMetaDialogUi,
  provider: Pick<CcProvider, "id" | "displayName" | "piName">,
  initial: ModelMetaOverride | undefined,
): Promise<ModelMetaDialogResult> {
  const draft: ModelMetaOverride = { ...(initial ?? {}) };

  while (true) {
    const title = `参数覆写 · ${provider.displayName}`;
    const presetOptions = MODEL_META_PRESETS.map(presetOption);
    const options = [
      ...presetOptions,
      `reasoning · ${fmtReasoning(draft.reasoning)}`,
      `contextWindow · ${fmtNum(draft.contextWindow)}`,
      `maxTokens · ${fmtNum(draft.maxTokens)}`,
      `thinkingFormat · ${fmtStr(draft.thinkingFormat)}`,
      "清除全部覆写",
      "保存",
      "取消",
    ];

    const pick = await ui.select(title, options);
    if (!pick) return { kind: "cancel" };

    const presetHit = MODEL_META_PRESETS.find((p) => pick === presetOption(p));
    if (presetHit) {
      applyPreset(draft, presetHit);
      ui.notify?.(`已应用预设：${presetHit.label}`, "info");
      continue;
    }

    if (pick.startsWith("reasoning")) {
      const choice = await ui.select("reasoning", ["默认", "true", "false", "返回"]);
      if (!choice || choice === "返回") continue;
      if (choice === "默认") delete draft.reasoning;
      else draft.reasoning = choice === "true";
      continue;
    }

    if (pick.startsWith("contextWindow")) {
      const raw = await ui.input(
        "contextWindow（空=默认）",
        draft.contextWindow != null ? String(draft.contextWindow) : "",
      );
      if (raw == null) continue;
      const n = parsePositiveInt(raw);
      if (raw.trim() === "") {
        delete draft.contextWindow;
      } else if (n === undefined || Number.isNaN(n)) {
        ui.notify?.("请输入正整数", "warning");
      } else {
        draft.contextWindow = n;
      }
      continue;
    }

    if (pick.startsWith("maxTokens")) {
      const raw = await ui.input(
        "maxTokens（空=默认）",
        draft.maxTokens != null ? String(draft.maxTokens) : "",
      );
      if (raw == null) continue;
      const n = parsePositiveInt(raw);
      if (raw.trim() === "") {
        delete draft.maxTokens;
      } else if (n === undefined || Number.isNaN(n)) {
        ui.notify?.("请输入正整数", "warning");
      } else {
        draft.maxTokens = n;
      }
      continue;
    }

    if (pick.startsWith("thinkingFormat")) {
      const raw = await ui.input(
        `thinkingFormat（空=默认；允许: ${THINKING_FORMATS.join("|")}）`,
        draft.thinkingFormat ?? "",
      );
      if (raw == null) continue;
      const t = raw.trim();
      if (!t) {
        delete draft.thinkingFormat;
      } else if (!isThinkingFormat(t)) {
        ui.notify?.(
          `非法 thinkingFormat: ${t}`,
          "warning",
        );
      } else {
        draft.thinkingFormat = t;
      }
      continue;
    }

    if (pick === "清除全部覆写") {
      const ok = await ui.confirm(`清除 ${provider.displayName} 的全部 modelMeta 覆写？`);
      if (ok) return { kind: "clear" };
      continue;
    }

    if (pick === "保存") {
      return { kind: "save", modelMeta: { ...draft } };
    }

    if (pick === "取消") {
      return { kind: "cancel" };
    }
  }
}

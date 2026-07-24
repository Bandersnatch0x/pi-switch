/**
 * Model-meta presets and resolution for upstream request shaping.
 *
 * Pi only exposes a subset of model config fields at register time
 * (reasoning / thinkingFormat / contextWindow / maxTokens). These are the
 * knobs we can use to avoid common relay 400s (especially reasoning/thinking).
 * This is register-time modelMeta — not HTTP body field stripping.
 */

import type { CcProvider, ModelMetaOverride, PiSwitchConfig } from "./types.ts";
import { isThinkingFormat } from "./types.ts";
import { resolveProviderOverride } from "./provider-override.ts";

export type ModelMetaPresetId = "relay-safe" | "full-reasoning";

export interface ModelMetaPreset {
  id: ModelMetaPresetId;
  /** Short Chinese label for dialog menus. */
  label: string;
  /** One-line description. */
  description: string;
  modelMeta: ModelMetaOverride;
}

/**
 * Built-in strategies for upstreams that reject reasoning/thinking params.
 * - relay-safe: reasoning=false (GLM/Qwen/DeepSeek via claude/codex protocol)
 * - full-reasoning: reasoning=true for true Claude/GPT reasoning models
 */
export const MODEL_META_PRESETS: readonly ModelMetaPreset[] = [
  {
    id: "relay-safe",
    label: "中转兼容",
    description: "reasoning=false — 拒收 thinking/reasoning 的中转默认策略",
    modelMeta: { reasoning: false },
  },
  {
    id: "full-reasoning",
    label: "完整推理",
    description: "reasoning=true — 真 Claude/GPT reasoning 上游",
    modelMeta: { reasoning: true },
  },
] as const;

export function getModelMetaPreset(id: string): ModelMetaPreset | undefined {
  return MODEL_META_PRESETS.find((p) => p.id === id);
}

/** Clean/normalize a modelMeta object; drop invalid fields. */
export function cleanModelMeta(meta: ModelMetaOverride | null | undefined): ModelMetaOverride | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const cleaned: ModelMetaOverride = {};
  if (typeof meta.reasoning === "boolean") cleaned.reasoning = meta.reasoning;
  if (typeof meta.thinkingFormat === "string" && meta.thinkingFormat.trim()) {
    const fmt = meta.thinkingFormat.trim();
    // Read path must reject unknown formats (write path already validates).
    if (isThinkingFormat(fmt)) cleaned.thinkingFormat = fmt;
  }
  if (typeof meta.contextWindow === "number" && Number.isFinite(meta.contextWindow) && meta.contextWindow > 0) {
    cleaned.contextWindow = Math.floor(meta.contextWindow);
  }
  if (typeof meta.maxTokens === "number" && Number.isFinite(meta.maxTokens) && meta.maxTokens > 0) {
    cleaned.maxTokens = Math.floor(meta.maxTokens);
  }
  return Object.keys(cleaned).length ? cleaned : undefined;
}

/**
 * Resolve effective modelMeta for a provider:
 *   providerOverrides[dbId].modelMeta  >  config.defaultModelMeta  >  undefined
 */
export function resolveEffectiveModelMeta(
  config: Pick<PiSwitchConfig, "providerOverrides" | "defaultModelMeta">,
  provider: Pick<CcProvider, "id" | "piName" | "displayName">,
): ModelMetaOverride | undefined {
  const explicit = resolveProviderOverride(config.providerOverrides, provider)?.modelMeta;
  const cleanedExplicit = cleanModelMeta(explicit);
  if (cleanedExplicit) return cleanedExplicit;
  return cleanModelMeta(config.defaultModelMeta);
}

/** Human summary for notify / doctor. */
export function summarizeModelMeta(meta: ModelMetaOverride | undefined): string {
  if (!meta) return "默认协议档";
  const parts: string[] = [];
  if (typeof meta.reasoning === "boolean") parts.push(`reasoning=${meta.reasoning}`);
  if (meta.thinkingFormat) parts.push(`thinkingFormat=${meta.thinkingFormat}`);
  if (typeof meta.contextWindow === "number") parts.push(`ctx=${meta.contextWindow}`);
  if (typeof meta.maxTokens === "number") parts.push(`maxTokens=${meta.maxTokens}`);
  return parts.length ? parts.join(", ") : "默认协议档";
}

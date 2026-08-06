/**
 * Model-meta presets and resolution for upstream request shaping.
 *
 * Pi only exposes a subset of model config fields at register time
 * (reasoning / thinkingFormat / contextWindow / maxTokens). These are the
 * knobs we can use to avoid common relay 400s (especially reasoning/thinking).
 * This is register-time modelMeta — not HTTP body field stripping.
 *
 * Layering (low → high precedence):
 *   defaultModelMeta
 *   providerOverrides[key].modelMeta          (provider scope)
 *   providerOverrides[key].modelOverrides[id] (model scope, glob-aware)
 * Layers merge per field; a higher layer only overrides fields it sets.
 */

import type {
  CcProvider,
  ModelMetaOverride,
  PiSwitchConfig,
  ThinkingLevelMap,
} from "./types.ts";
import { isThinkingFormat, THINKING_LEVELS } from "./types.ts";
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

/** Editable modelMeta field keys, in dialog display order. */
export const MODEL_META_FIELDS = [
  "reasoning",
  "contextWindow",
  "maxTokens",
  "thinkingFormat",
] as const;

export type ModelMetaField = (typeof MODEL_META_FIELDS)[number];

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

/**
 * Clean thinkingLevelMap: keep only known levels; values are trimmed non-empty
 * strings or explicit `null`. Drop empty strings, arrays, and unknown keys.
 */
export function cleanThinkingLevelMap(
  map: ThinkingLevelMap | null | undefined,
): ThinkingLevelMap | undefined {
  if (!map || typeof map !== "object" || Array.isArray(map)) return undefined;
  const out: ThinkingLevelMap = {};
  for (const level of THINKING_LEVELS) {
    if (!Object.prototype.hasOwnProperty.call(map, level)) continue;
    const raw = map[level];
    if (raw === null) {
      out[level] = null;
      continue;
    }
    if (typeof raw === "string") {
      const v = raw.trim();
      if (v) out[level] = v;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Deep-merge thinkingLevelMap left→right; higher-layer `null` overwrites strings. */
export function mergeThinkingLevelMap(
  ...layers: (ThinkingLevelMap | undefined)[]
): ThinkingLevelMap | undefined {
  const out: ThinkingLevelMap = {};
  let any = false;
  for (const layer of layers) {
    const clean = cleanThinkingLevelMap(layer);
    if (!clean) continue;
    for (const [level, value] of Object.entries(clean) as [
      keyof ThinkingLevelMap,
      string | null,
    ][]) {
      out[level] = value;
      any = true;
    }
  }
  return any ? out : undefined;
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
  if (typeof meta.requiresReasoningContentOnAssistantMessages === "boolean") {
    cleaned.requiresReasoningContentOnAssistantMessages =
      meta.requiresReasoningContentOnAssistantMessages;
  }
  // Legacy flat developer-role (issue #64); stripped from capability layers
  // elsewhere — kept here so deprecation resolution can still see it.
  if (typeof meta.supportsDeveloperRole === "boolean") {
    cleaned.supportsDeveloperRole = meta.supportsDeveloperRole;
  }
  const levelMap = cleanThinkingLevelMap(meta.thinkingLevelMap);
  if (levelMap) cleaned.thinkingLevelMap = levelMap;
  return Object.keys(cleaned).length ? cleaned : undefined;
}

/**
 * Merge modelMeta layers left→right (right wins per field).
 * Unset fields never clobber a lower layer.
 * `thinkingLevelMap` is deep-merged per level; higher-layer `null` overwrites.
 */
export function mergeModelMeta(
  ...layers: (ModelMetaOverride | undefined)[]
): ModelMetaOverride | undefined {
  const out: ModelMetaOverride = {};
  const mapLayers: (ThinkingLevelMap | undefined)[] = [];
  for (const layer of layers) {
    const clean = cleanModelMeta(layer);
    if (!clean) continue;
    const { thinkingLevelMap, ...rest } = clean;
    Object.assign(out, rest);
    mapLayers.push(thinkingLevelMap);
  }
  const mergedMap = mergeThinkingLevelMap(...mapLayers);
  if (mergedMap) out.thinkingLevelMap = mergedMap;
  else delete out.thinkingLevelMap;
  return Object.keys(out).length ? out : undefined;
}

/** Escape regex metachars except `*`, which becomes `.*`. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/** Non-wildcard char count — higher means more specific. */
function globSpecificity(pattern: string): number {
  return pattern.replace(/\*/g, "").length;
}

/**
 * Pick the modelOverrides entry for a model id.
 * Match order: exact → case-insensitive exact → most specific glob.
 */
export function matchModelOverride(
  modelOverrides: Record<string, ModelMetaOverride> | undefined,
  modelId: string | undefined,
): { key: string; modelMeta: ModelMetaOverride | undefined } | undefined {
  if (!modelOverrides || typeof modelOverrides !== "object") return undefined;
  const id = modelId?.trim();
  if (!id) return undefined;

  const exact = matchExactModelOverride(modelOverrides, id);
  if (exact) return exact;

  const entries = Object.entries(modelOverrides);
  const globs = entries
    .filter(([k]) => k.includes("*") && globToRegExp(k).test(id))
    .sort((a, b) => globSpecificity(b[0]) - globSpecificity(a[0]));
  const hit = globs[0];
  if (!hit) return undefined;
  return { key: hit[0], modelMeta: cleanModelMeta(hit[1]) };
}

/** Pick only an exact modelOverrides key (case-insensitive), never a matching glob. */
export function matchExactModelOverride(
  modelOverrides: Record<string, ModelMetaOverride> | undefined,
  modelId: string | undefined,
): { key: string; modelMeta: ModelMetaOverride | undefined } | undefined {
  if (!modelOverrides || typeof modelOverrides !== "object") return undefined;
  const id = modelId?.trim();
  if (!id) return undefined;

  if (Object.prototype.hasOwnProperty.call(modelOverrides, id)) {
    return { key: id, modelMeta: cleanModelMeta(modelOverrides[id]) };
  }

  const ci = Object.entries(modelOverrides).find(
    ([key]) => key.toLowerCase() === id.toLowerCase(),
  );
  return ci ? { key: ci[0], modelMeta: cleanModelMeta(ci[1]) } : undefined;
}

export interface ModelMetaLayers {
  /** config.defaultModelMeta */
  base: ModelMetaOverride | undefined;
  /** providerOverrides[key].modelMeta */
  provider: ModelMetaOverride | undefined;
  /** providerOverrides[key].modelOverrides[matchedKey] */
  model: ModelMetaOverride | undefined;
  /** Key that matched in modelOverrides (may be a glob). */
  modelKey?: string;
  /** base ⊕ provider ⊕ model */
  effective: ModelMetaOverride | undefined;
  /**
   * What a model-scope *exact* edit inherits:
   * base ⊕ provider ⊕ (glob-only match when no exact key for this id).
   * Exact modelOverrides are the "own" layer, not inherited.
   */
  inheritedForModel: ModelMetaOverride | undefined;
}

/**
 * Layers below a model-scope exact override.
 * When only a glob matches `modelId`, include that glob as inherit (read-only
 * display); never treat an exact key as inherit — that is the draft/own layer.
 */
export function inheritedModelMetaBelowExact(
  base: ModelMetaOverride | undefined,
  providerMeta: ModelMetaOverride | undefined,
  modelOverrides: Record<string, ModelMetaOverride> | undefined,
  modelId: string | undefined,
): ModelMetaOverride | undefined {
  const below = mergeModelMeta(base, providerMeta);
  if (!modelId?.trim()) return below;
  if (matchExactModelOverride(modelOverrides, modelId)) return below;
  const matched = matchModelOverride(modelOverrides, modelId);
  return mergeModelMeta(below, matched?.modelMeta);
}

/** Full layer breakdown for one provider(+model). Used by dialog and doctor. */
export function resolveModelMetaLayers(
  config: Pick<PiSwitchConfig, "providerOverrides" | "defaultModelMeta">,
  provider: Pick<CcProvider, "id" | "piName" | "displayName">,
  modelId?: string,
): ModelMetaLayers {
  const entry = resolveProviderOverride(config.providerOverrides, provider);
  const base = cleanModelMeta(config.defaultModelMeta);
  const providerMeta = cleanModelMeta(entry?.modelMeta);
  const matched = matchModelOverride(entry?.modelOverrides, modelId);
  const modelMeta = matched?.modelMeta;
  return {
    base,
    provider: providerMeta,
    model: modelMeta,
    modelKey: matched?.key,
    effective: mergeModelMeta(base, providerMeta, modelMeta),
    inheritedForModel: inheritedModelMetaBelowExact(
      base,
      providerMeta,
      entry?.modelOverrides,
      modelId,
    ),
  };
}

/**
 * Resolve effective modelMeta for a provider(+model):
 *   modelOverrides[model] ⊕ providerOverrides.modelMeta ⊕ defaultModelMeta
 */
export function resolveEffectiveModelMeta(
  config: Pick<PiSwitchConfig, "providerOverrides" | "defaultModelMeta">,
  provider: Pick<CcProvider, "id" | "piName" | "displayName">,
  modelId?: string,
): ModelMetaOverride | undefined {
  return resolveModelMetaLayers(config, provider, modelId).effective;
}

/** Human summary for notify / doctor. */
export function summarizeModelMeta(meta: ModelMetaOverride | undefined): string {
  if (!meta) return "默认协议档";
  const parts: string[] = [];
  if (typeof meta.reasoning === "boolean") parts.push(`reasoning=${meta.reasoning}`);
  if (meta.thinkingFormat) parts.push(`thinkingFormat=${meta.thinkingFormat}`);
  if (typeof meta.contextWindow === "number") parts.push(`ctx=${meta.contextWindow}`);
  if (typeof meta.maxTokens === "number") parts.push(`maxTokens=${meta.maxTokens}`);
  if (meta.thinkingLevelMap) {
    parts.push(`thinkingLevelMap=${Object.keys(meta.thinkingLevelMap).length}`);
  }
  if (typeof meta.requiresReasoningContentOnAssistantMessages === "boolean") {
    parts.push(
      `requiresReasoningContentOnAssistantMessages=${meta.requiresReasoningContentOnAssistantMessages}`,
    );
  }
  return parts.length ? parts.join(", ") : "默认协议档";
}

/** Count configured per-model overrides across all providerOverrides entries. */
export function countModelOverrides(
  overrides: PiSwitchConfig["providerOverrides"] | undefined,
): number {
  if (!overrides) return 0;
  let n = 0;
  for (const entry of Object.values(overrides)) {
    const mo = entry?.modelOverrides;
    if (mo && typeof mo === "object") n += Object.keys(mo).length;
  }
  return n;
}

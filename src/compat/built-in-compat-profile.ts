/**
 * Built-in compat profiles for well-known model id families.
 *
 * Purpose: fill Pi registration fields that models.dev does not supply
 * (thinkingFormat / thinkingLevelMap / OpenAI compat flags). Never sets
 * capability scalars (contextWindow / maxTokens / reasoning) — those stay
 * on the models.dev → protocol-default chain (issue #15).
 *
 * Precedence at registration:
 *   user override > built-in compat profile > (capability layers for scalars)
 *
 * Keys are exact ids or globs (`deepseek*`); most-specific glob wins
 * (same matcher as modelOverrides).
 */

import { cleanModelMeta, matchModelOverride, mergeModelMeta } from "../model-meta.ts";
import type { ModelMetaOverride } from "../types.ts";

export interface BuiltInCompatMatch {
  /** Matched profile key (exact id or glob). */
  key: string;
  /** Compat-only meta (capability scalars stripped). */
  modelMeta: ModelMetaOverride;
}

/**
 * DeepSeek OpenAI-compat thinking (README recommended override).
 * Matches official DeepSeek API shape; relays that reject this still need
 * user override (e.g. relay-safe reasoning=false).
 */
const DEEPSEEK_COMPAT: ModelMetaOverride = {
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
  thinkingLevelMap: {
    minimal: "high",
    low: "high",
    medium: "high",
    high: "high",
    xhigh: "max",
  },
};

/**
 * PR1 + PR2 whitelist. Keep small; only add families with documented / known
 * Pi thinkingFormat literals. Do not invent context/maxTokens here.
 */
export const BUILT_IN_COMPAT_PROFILES: Readonly<
  Record<string, ModelMetaOverride>
> = {
  // PR1
  "deepseek*": DEEPSEEK_COMPAT,
  // PR2 — format-only; effort maps vary by upstream
  "qwen*": { thinkingFormat: "qwen" },
};

/** Keep only compat fields; drop capability scalars even if a profile sets them. */
export function compatOnlyMeta(
  meta: ModelMetaOverride | null | undefined,
): ModelMetaOverride | undefined {
  if (!meta) return undefined;
  return cleanModelMeta({
    thinkingFormat: meta.thinkingFormat,
    thinkingLevelMap: meta.thinkingLevelMap,
    requiresReasoningContentOnAssistantMessages:
      meta.requiresReasoningContentOnAssistantMessages,
  });
}

/** Match a model id against the built-in table (exact → ci exact → specific glob). */
export function matchBuiltInCompatProfile(
  modelId: string | undefined,
): BuiltInCompatMatch | undefined {
  const hit = matchModelOverride(
    BUILT_IN_COMPAT_PROFILES as Record<string, ModelMetaOverride>,
    modelId,
  );
  if (!hit?.modelMeta) return undefined;
  const modelMeta = compatOnlyMeta(hit.modelMeta);
  if (!modelMeta) return undefined;
  return { key: hit.key, modelMeta };
}

/** True when user layers explicitly disable built-in compat for this scope. */
export function isBuiltInCompatDisabled(
  userMeta: ModelMetaOverride | undefined,
): boolean {
  return userMeta?.useBuiltInCompat === false;
}

/**
 * Merge built-in under user **compat-only** fields: user wins per field.
 * Used by resolveRegistrationMeta when attaching thinkingFormat / flags.
 * Skipped entirely when `userMeta.useBuiltInCompat === false`.
 * Returns undefined when neither side contributes compat fields.
 */
export function mergeBuiltInCompatUnderUser(
  modelId: string | undefined,
  userMeta: ModelMetaOverride | undefined,
): ModelMetaOverride | undefined {
  const userCompat = compatOnlyMeta(userMeta);
  if (isBuiltInCompatDisabled(userMeta)) return userCompat;
  const builtIn = matchBuiltInCompatProfile(modelId)?.modelMeta;
  if (!builtIn && !userCompat) return undefined;
  // mergeModelMeta is left→right (right wins); user must be right.
  return mergeModelMeta(builtIn, userCompat);
}

/**
 * Full user meta with built-in compat underneath (user wins per field).
 * Single source of truth for display / doctor / switch notify / modelMetaFor —
 * same compat the registration path applies, plus user capability scalars.
 * Honors `useBuiltInCompat: false` (whole-profile opt-out).
 */
export function withBuiltInCompatUnderUser(
  modelId: string | undefined,
  userMeta: ModelMetaOverride | undefined,
): ModelMetaOverride | undefined {
  if (isBuiltInCompatDisabled(userMeta)) return userMeta;
  const builtIn = matchBuiltInCompatProfile(modelId)?.modelMeta;
  if (!builtIn) return userMeta;
  return mergeModelMeta(builtIn, userMeta);
}

/**
 * Built-in compat blob for a model id, if any — and only when the user has
 * not disabled built-in via `useBuiltInCompat: false` on `userMeta`.
 * Pass userMeta from the current form draft / inherited layers so UI can
 * hide 「内置」 once opt-out is set.
 */
export function builtInCompatForModelId(
  modelId: string | undefined,
  userMeta?: ModelMetaOverride,
): ModelMetaOverride | undefined {
  if (isBuiltInCompatDisabled(userMeta)) return undefined;
  return matchBuiltInCompatProfile(modelId)?.modelMeta;
}

/** Whether a model id has a matching built-in profile (ignores opt-out). */
export function hasBuiltInCompatProfile(modelId: string | undefined): boolean {
  return matchBuiltInCompatProfile(modelId) !== undefined;
}

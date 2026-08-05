/**
 * Registration-time capability assembly (issue #36 + #63).
 * Pure functions only — no IO, no await. Callers supply cache/network facts.
 *
 * Issue #63: do not invent protocol maxTokens floors; models without a trusted
 * maxTokens authority are not registration-eligible.
 */

import type { ModelMetaOverride, PiApi } from "../types.ts";
import { API_MODEL_META, DEFAULT_MODEL_META } from "../types.ts";
import { applyAnyrouterModelMeta } from "../headers/anyrouter.ts";
import { bracketContextWindow } from "../parse/common.ts";
import { mergeBuiltInCompatUnderUser } from "../compat/built-in-compat-profile.ts";
import type { ModelsDevCapabilities } from "./models-dev.ts";
import {
  isMaxTokensResolved,
  resolveModelCapabilities,
  type CapabilityMeta,
  type CapabilitySource,
  type ResolvedCapabilities,
} from "./resolve.ts";

/** Extract capability fields from a provider's cc-switch meta blob. */
export function ccMetaFrom(
  meta: Record<string, unknown> | undefined,
): CapabilityMeta | undefined {
  if (!meta) return undefined;
  if (
    typeof meta.contextWindow !== "number" &&
    typeof meta.maxTokens !== "number" &&
    typeof meta.reasoning !== "boolean" &&
    typeof meta.vision !== "boolean"
  ) {
    return undefined;
  }
  return {
    contextWindow:
      typeof meta.contextWindow === "number" ? meta.contextWindow : undefined,
    maxTokens: typeof meta.maxTokens === "number" ? meta.maxTokens : undefined,
    reasoning: typeof meta.reasoning === "boolean" ? meta.reasoning : undefined,
    vision: typeof meta.vision === "boolean" ? meta.vision : undefined,
  };
}

/**
 * Protocol structural floors for registration/doctor.
 * Issue #63: contextWindow may still use protocol tier; maxTokens and
 * reasoning must NOT — those come only from the trusted authority chain.
 * Compat fields come later via mergeBuiltInCompatUnderUser (user > built-in).
 */
export function protocolCapabilityDefaults(
  api: PiApi | null | undefined,
): CapabilityMeta {
  const tier = api ? API_MODEL_META[api] : undefined;
  if (tier) {
    return {
      contextWindow: tier.contextWindow,
      // intentionally omit maxTokens + reasoning (#63)
    };
  }
  return {
    contextWindow: DEFAULT_MODEL_META.contextWindow,
  };
}

export type RegistrationCapabilityDecision = {
  /** Full resolved chain (for doctor / effective config / precheck). */
  resolved: ResolvedCapabilities;
  /**
   * Registration-facing meta when maxTokens is resolved.
   * Undefined when the model must not be registered as switchable.
   */
  meta: ModelMetaOverride | undefined;
  /** True when maxTokens has no trusted authority. */
  maxTokensUnresolved: boolean;
  /** True when reasoning came from the runtime conservative derivation. */
  reasoningConservative: boolean;
};

/** Human-readable fix for an unresolved maxTokens gate. */
export function maxTokensUnresolvedFix(modelId: string): string {
  return (
    `在 providerOverrides 为 model "${modelId}" 写 exact-model maxTokens ` +
    `(modelOverrides.<id>.maxTokens)，或等待 models.dev / CC Switch meta 提供权威值`
  );
}

/** Redacted one-line decision for doctor/precheck (no secrets, no full URLs). */
export function formatCapabilityDecision(
  modelId: string,
  decision: RegistrationCapabilityDecision,
  providerLabel?: string,
): string {
  const prefix = providerLabel ? `${providerLabel} · ${modelId}` : modelId;
  const mt = decision.resolved.maxTokens;
  const rs = decision.resolved.reasoning;
  const maxPart = decision.maxTokensUnresolved
    ? "maxTokens=unresolved"
    : `maxTokens=${mt.value}(${mt.source})`;
  const reasonPart =
    decision.reasoningConservative
      ? "reasoning=unknown→conservative false"
      : `reasoning=${rs.value}(${rs.source})`;
  return `${prefix}: ${maxPart} · ${reasonPart}`;
}

/**
 * Resolve registration-facing model meta through the full capability chain.
 * Returns undefined meta when maxTokens is unresolved (model must not register).
 */
export function resolveRegistrationCapability(input: {
  modelId: string;
  api: PiApi | null;
  baseUrl: string;
  userMeta?: ModelMetaOverride;
  modelsDev?: ModelsDevCapabilities;
  ccMeta?: CapabilityMeta;
}): RegistrationCapabilityDecision {
  const defaults = protocolCapabilityDefaults(input.api);

  const cw = bracketContextWindow(input.modelId);
  const idTag: CapabilityMeta | undefined =
    cw !== undefined ? { contextWindow: cw } : undefined;

  const hostAdaptation = applyAnyrouterModelMeta(input.api, input.baseUrl);

  const resolved = resolveModelCapabilities({
    user: input.userMeta,
    idTag,
    hostAdaptation,
    modelsDev: input.modelsDev,
    ccMeta: input.ccMeta,
    defaults,
  });

  const maxTokensUnresolved = !isMaxTokensResolved(resolved.maxTokens);
  const reasoningConservative = resolved.reasoning.source === "conservative-default";

  if (maxTokensUnresolved) {
    return {
      resolved,
      meta: undefined,
      maxTokensUnresolved: true,
      reasoningConservative,
    };
  }

  const out: ModelMetaOverride = {
    contextWindow:
      typeof resolved.contextWindow.value === "number"
        ? resolved.contextWindow.value
        : defaults.contextWindow,
    maxTokens: resolved.maxTokens.value as number,
    reasoning: resolved.reasoning.value === true,
  };
  // Compat/effort: user override > built-in profile (not capability layers).
  const compat = mergeBuiltInCompatUnderUser(input.modelId, input.userMeta);
  if (compat?.thinkingFormat) out.thinkingFormat = compat.thinkingFormat;
  if (compat?.thinkingLevelMap) out.thinkingLevelMap = compat.thinkingLevelMap;
  if (typeof compat?.requiresReasoningContentOnAssistantMessages === "boolean") {
    out.requiresReasoningContentOnAssistantMessages =
      compat.requiresReasoningContentOnAssistantMessages;
  }
  // Developer-role flag: user-only (not in built-in profiles); request-hook uses it.
  if (typeof input.userMeta?.supportsDeveloperRole === "boolean") {
    out.supportsDeveloperRole = input.userMeta.supportsDeveloperRole;
  }
  return {
    resolved,
    meta: out,
    maxTokensUnresolved: false,
    reasoningConservative,
  };
}

/**
 * Back-compat wrapper: returns registration meta, or a partial shell when
 * maxTokens is unresolved (callers that still need a number should use
 * resolveRegistrationCapability and gate on maxTokensUnresolved).
 *
 * Prefer resolveRegistrationCapability for new code.
 */
export function resolveRegistrationMeta(input: {
  modelId: string;
  api: PiApi | null;
  baseUrl: string;
  userMeta?: ModelMetaOverride;
  modelsDev?: ModelsDevCapabilities;
  ccMeta?: CapabilityMeta;
}): ModelMetaOverride {
  const decision = resolveRegistrationCapability(input);
  if (decision.meta) return decision.meta;
  // Unresolved path: expose conservative reasoning + context only; omit maxTokens
  // so register can detect absence and skip the model.
  const defaults = protocolCapabilityDefaults(input.api);
  const out: ModelMetaOverride = {
    contextWindow:
      typeof decision.resolved.contextWindow.value === "number"
        ? decision.resolved.contextWindow.value
        : defaults.contextWindow,
    reasoning: decision.resolved.reasoning.value === true,
  };
  // Same compat merge as the resolved path (user > built-in).
  const compat = mergeBuiltInCompatUnderUser(input.modelId, input.userMeta);
  if (compat?.thinkingFormat) out.thinkingFormat = compat.thinkingFormat;
  if (compat?.thinkingLevelMap) out.thinkingLevelMap = compat.thinkingLevelMap;
  if (typeof compat?.requiresReasoningContentOnAssistantMessages === "boolean") {
    out.requiresReasoningContentOnAssistantMessages =
      compat.requiresReasoningContentOnAssistantMessages;
  }
  return out;
}

export type { CapabilitySource, ResolvedCapabilities };

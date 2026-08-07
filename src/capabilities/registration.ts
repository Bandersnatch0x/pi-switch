/**
 * Registration-time capability assembly (issue #36 + #63).
 * Pure functions only — no IO, no await. Callers supply cache/network facts.
 *
 * Issue #63: do not invent protocol maxTokens floors; models without a trusted
 * maxTokens authority are not registration-eligible.
 */

import type { ModelMetaOverride, PiApi } from "../types.ts";
import { mergeBuiltInCompatUnderUser } from "../compat/built-in-compat-profile.ts";
import type { ModelsDevCapabilities } from "./models-dev.ts";
import {
  assembleCapabilityLayers,
  protocolCapabilityDefaults,
} from "./layers.ts";
import {
  isMaxTokensResolved,
  resolveModelCapabilities,
  type CapabilityMeta,
  type CapabilitySource,
  type ResolvedCapabilities,
} from "./resolve.ts";

// Deep-import compat: helpers live in layers.ts; keep prior registration
// surface so existing `from "./registration.ts"` importers still resolve.
export { ccMetaFrom, protocolCapabilityDefaults } from "./layers.ts";

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

/** Human-readable message explaining how to resolve an unresolved maxTokens gate. */
export function formatMaxTokensUnresolvedMessage(modelId: string): string {
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
  const resolved = resolveModelCapabilities(
    assembleCapabilityLayers({
      modelId: input.modelId,
      api: input.api,
      baseUrl: input.baseUrl,
      user: input.userMeta,
      modelsDev: input.modelsDev,
      ccMeta: input.ccMeta,
    }),
  );

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
        : protocolCapabilityDefaults(input.api).contextWindow,
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

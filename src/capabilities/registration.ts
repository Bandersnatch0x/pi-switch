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
export { trustedMaxTokensHint, type TrustedMaxTokensHint } from "./resolve.ts";

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

export type { CapabilitySource, ResolvedCapabilities };

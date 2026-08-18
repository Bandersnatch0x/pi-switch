/**
 * Registration-time capability assembly (issue #36 + #63).
 * Pure functions only — no IO, no await. Callers supply cache/network facts.
 *
 * Issue #63: do not invent protocol maxTokens floors; models without a trusted
 * maxTokens authority are not registration-eligible.
 */

import type { ModelMetaOverride, PiApi } from "../types.ts";
import {
  isBuiltInCompatDisabled,
  matchBuiltInCompatProfile,
  mergeBuiltInCompatUnderUser,
} from "../compat/built-in-compat-profile.ts";
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
import { tf } from "../ui/tui-locale.ts";
import {
  resolveThinkingProjection,
  type PiThinkingRuntimeCapability,
  type ProviderEndpointTupleInput,
  type ProviderReasoningProfile,
  type ThinkingProjectionDecision,
  type UserThinkingMapScope,
  type UserThinkingMapScopes,
} from "./thinking-projection.ts";

// Deep-import compat: helpers live in layers.ts; keep prior registration
// surface so existing `from "./registration.ts"` importers still resolve.
export { ccMetaFrom, protocolCapabilityDefaults } from "./layers.ts";
export { trustedMaxTokensHint, type TrustedMaxTokensHint } from "./resolve.ts";

export interface RegistrationModelMetaFacts {
  /** User-configured layers only; built-in compat is resolved inside registration. */
  userMeta: ModelMetaOverride | undefined;
  /** Per-level provenance after user thinkingLevelMap layers are deep-merged. */
  userMapScopes: UserThinkingMapScopes;
}

export interface RegistrationThinkingFacts {
  tuple: ProviderEndpointTupleInput;
  profile?: ProviderReasoningProfile;
  runtime: PiThinkingRuntimeCapability;
  userMapScope: UserThinkingMapScope;
  userMapScopes?: UserThinkingMapScopes;
}

export interface RegistrationCapabilityInput {
  modelId: string;
  api: PiApi | null;
  baseUrl: string;
  userMeta?: ModelMetaOverride;
  modelsDev?: ModelsDevCapabilities;
  ccMeta?: CapabilityMeta;
  /** Full tuple identity plus profile/runtime evidence for thinking projection. */
  thinking?: RegistrationThinkingFacts;
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
  /** One tuple-scoped thinking decision shared by registration and diagnostics. */
  thinkingProjection: ThinkingProjectionDecision | undefined;
};

function resolveRegistrationThinking(
  input: RegistrationCapabilityInput,
  reasoningEnabled: boolean,
): ThinkingProjectionDecision | undefined {
  if (!reasoningEnabled || !input.thinking || !input.api) return undefined;
  const builtInDisabled = isBuiltInCompatDisabled(input.userMeta);
  const profile =
    builtInDisabled && input.thinking.profile?.source === "built-in"
      ? undefined
      : input.thinking.profile;
  const builtInMap = builtInDisabled
    ? undefined
    : matchBuiltInCompatProfile(input.modelId)?.modelMeta.thinkingLevelMap;
  const userMap = input.userMeta?.thinkingLevelMap;
  if (!profile && !builtInMap && !userMap) return undefined;
  return resolveThinkingProjection({
    tuple: input.thinking.tuple,
    profile,
    runtime: input.thinking.runtime,
    builtInMap,
    userMap,
    userMapScope: input.thinking.userMapScope,
    userMapScopes: input.thinking.userMapScopes,
  });
}

/**
 * Redacted one-line decision for doctor/precheck (no secrets, no full URLs).
 * Appends the stale last-good suffix when models.dev is expired, so every
 * diagnostic site formats through this single exit instead of hand-rolling.
 */
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
  const staleSuffix =
    mt.source === "models-dev" && mt.stale
      ? tf("precheckStaleSuffix", { at: mt.fetchedAt ?? "?" })
      : "";
  return `${prefix}: ${maxPart} · ${reasonPart}${staleSuffix}`;
}

/**
 * Resolve registration-facing model meta through the full capability chain.
 * Returns undefined meta when maxTokens is unresolved (model must not register).
 */
export function resolveRegistrationCapability(
  input: RegistrationCapabilityInput,
): RegistrationCapabilityDecision {
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
  const thinkingProjection = resolveRegistrationThinking(
    input,
    resolved.reasoning.value === true,
  );

  if (maxTokensUnresolved) {
    return {
      resolved,
      meta: undefined,
      maxTokensUnresolved: true,
      reasoningConservative,
      thinkingProjection,
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
  const thinkingLevelMap = out.reasoning
    ? thinkingProjection
      ? thinkingProjection.map
      : compat?.thinkingLevelMap
    : undefined;
  if (thinkingLevelMap) out.thinkingLevelMap = thinkingLevelMap;
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
    thinkingProjection,
  };
}

export type { CapabilitySource, ResolvedCapabilities };

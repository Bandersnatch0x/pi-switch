/**
 * Config-derived provider views used by Runtime, registration, and doctor.
 *
 * Pure over PiSwitchConfig — no IO. Runtime holds one instance bound to
 * `() => this.config` so reloads are visible without reconstruction.
 */

import {
  THINKING_LEVELS,
  type CcProvider,
  type ModelMetaOverride,
  type PiSwitchConfig,
  type ThinkingLevel,
} from "./types.ts";
import { resolveProviderOverride } from "./provider-override.ts";
import {
  resolveProviderWireCompat,
  type ResolvedProviderWireCompat,
} from "./provider-wire-compat.ts";
import {
  resolveOverrideHeaders,
  isFingerprintPreset,
} from "./headers/fingerprints.ts";
import {
  resolveEffectiveModelMeta,
  resolveModelMetaLayers,
  cleanModelMeta,
  matchExactModelOverrideEntry,
} from "./model-meta.ts";
import { withBuiltInCompatUnderUser } from "./compat/built-in-compat-profile.ts";
import { shouldApplyClaudeCodeCompat } from "./compat/claude-code.ts";
import { shouldApplyGeminiToolCompat } from "./compat/gemini-tool-compat.ts";
import type { ModelTupleCompat } from "./model-tuple-compat.ts";
import type { RegistrationModelMetaFacts } from "./capabilities/registration.ts";
import type { UserThinkingMapScope } from "./capabilities/thinking-projection.ts";
import type { UserReasoningProfileOverride } from "./capabilities/thinking-projection.ts";

/** Exact-model tuple pick: the tuple plus legacy flat dialect fields (#64/#67). */
export interface TupleCompatSelection {
  tuple?: ModelTupleCompat;
  legacyFlat?: ModelMetaOverride;
}

export interface EffectiveProviderCompatibility {
  claudeCodeCompat?: boolean;
  geminiToolCompat?: boolean;
}

type CompatibilityProvider = Pick<
  CcProvider,
  "id" | "piName" | "displayName" | "api" | "baseUrl"
> & { appType?: string };

/**
 * Resolve the one compatibility interpretation shared by hooks, registration,
 * Probe, and Repair. The returned shape only contains enabled behaviors; an
 * omitted key means the effective behavior is disabled for this provider.
 */
export function resolveEffectiveProviderCompatibility(
  config: PiSwitchConfig,
  provider: CompatibilityProvider,
): EffectiveProviderCompatibility {
  const entry = resolveProviderOverride(config.providerOverrides, provider);
  const claudeCodeCompat = shouldApplyClaudeCodeCompat({
    mode: config.claudeCodeCompat?.mode,
    hosts: config.claudeCodeCompat?.hosts,
    api: provider.api,
    baseUrl: provider.baseUrl,
    providerForce:
      typeof entry?.claudeCodeCompat === "boolean"
        ? entry.claudeCodeCompat
        : null,
  });
  const geminiToolCompat = shouldApplyGeminiToolCompat({
    mode: config.geminiToolCompat?.mode,
    hosts: config.geminiToolCompat?.hosts,
    api: provider.api,
    baseUrl: provider.baseUrl,
    providerForce:
      typeof entry?.geminiToolCompat === "boolean"
        ? entry.geminiToolCompat
        : null,
  });

  return {
    ...(claudeCodeCompat ? { claudeCodeCompat: true } : {}),
    ...(geminiToolCompat ? { geminiToolCompat: true } : {}),
  };
}

export class ProviderConfigViews {
  constructor(private readonly getConfig: () => PiSwitchConfig) {}

  effectiveCompatibilityFor(
    provider: CompatibilityProvider,
  ): EffectiveProviderCompatibility {
    return resolveEffectiveProviderCompatibility(this.getConfig(), provider);
  }

  overridesFor(provider: Pick<CcProvider, "id" | "piName" | "displayName">) {
    const ov = resolveProviderOverride(
      this.getConfig().providerOverrides,
      provider,
    );
    if (!ov) return undefined;
    const fingerprint =
      typeof ov.fingerprint === "string" && isFingerprintPreset(ov.fingerprint)
        ? ov.fingerprint
        : undefined;
    // May set skipRules when fingerprint is "none" (clear default CLI disguise).
    const resolved = resolveOverrideHeaders({
      fingerprint,
      headers: ov.headers,
    });
    if (!resolved.headers && !resolved.skipRules) return undefined;
    return resolved;
  }

  /** Spread into lifecycle provider registration options. */
  headerOverrideOpts(
    provider: Pick<CcProvider, "id" | "piName" | "displayName">,
  ) {
    const resolved = this.overridesFor(provider);
    if (!resolved) return {};
    return {
      overrideHeaders: resolved.headers,
      skipRules: resolved.skipRules,
    };
  }

  /**
   * Display-facing effective modelMeta:
   *   built-in compat < defaultModelMeta < provider.modelMeta < modelOverrides
   * (user wins per field). Registration uses registrationModelMetaFor so it
   * retains user-map provenance before built-in compat is applied.
   */
  modelMetaFor(
    provider: Pick<CcProvider, "id" | "piName" | "displayName">,
    modelId?: string,
  ) {
    return withBuiltInCompatUnderUser(
      modelId,
      resolveEffectiveModelMeta(this.getConfig(), provider, modelId),
    );
  }

  /**
   * Registration facts before built-in compat is applied. Keeping provenance
   * here prevents registration/runtime callers from guessing map scope from a
   * flattened ModelMetaOverride.
   */
  registrationModelMetaFor(
    provider: Pick<CcProvider, "id" | "piName" | "displayName">,
    modelId: string,
  ): RegistrationModelMetaFacts {
    const layers = this.modelMetaLayers(provider, modelId);
    const userMapScopes: Partial<
      Record<ThinkingLevel, UserThinkingMapScope>
    > = {};
    const modelScope = layers.modelKey?.includes("*")
      ? "model-glob"
      : "exact-model";
    for (const level of THINKING_LEVELS) {
      if (
        Object.prototype.hasOwnProperty.call(
          layers.model?.thinkingLevelMap ?? {},
          level,
        )
      ) {
        userMapScopes[level] = modelScope;
      } else if (
        Object.prototype.hasOwnProperty.call(
          layers.provider?.thinkingLevelMap ?? {},
          level,
        )
      ) {
        userMapScopes[level] = "provider";
      } else if (
        Object.prototype.hasOwnProperty.call(
          layers.base?.thinkingLevelMap ?? {},
          level,
        )
      ) {
        userMapScopes[level] = "default";
      }
    }
    return { userMeta: layers.effective, userMapScopes };
  }

  /** Exact user profile only; globs/provider/default scopes are never authoritative. */
  reasoningProfileFor(
    provider: Pick<CcProvider, "id" | "piName" | "displayName"> & {
      appType?: string;
    },
    modelId: string,
  ): UserReasoningProfileOverride | undefined {
    const entry = resolveProviderOverride(
      this.getConfig().providerOverrides,
      provider,
    );
    return matchExactModelOverrideEntry(entry?.modelOverrides, modelId)?.entry
      .reasoningProfile;
  }

  /**
   * Provider-scoped wire compat (issue #62/#65/#66). Uses providerOverrides.compat
   * only — never models.dev, model id tags, or CC Switch meta.
   */
  providerWireCompatFor(
    provider: Pick<
      CcProvider,
      "id" | "piName" | "displayName" | "api" | "baseUrl"
    > & { appType?: string },
  ): ResolvedProviderWireCompat | undefined {
    const entry = resolveProviderOverride(
      this.getConfig().providerOverrides,
      provider,
    );
    return resolveProviderWireCompat({
      provider,
      override: entry?.compat,
    });
  }

  /**
   * Exact-model tuple wire dialect (issue #64/#67).
   * Returns tuple + legacy flat fields for deprecation path.
   */
  tupleCompatFor(
    provider: Pick<
      CcProvider,
      "id" | "piName" | "displayName" | "api" | "baseUrl"
    > & { appType?: string },
    modelId: string,
  ): TupleCompatSelection | undefined {
    const entry = resolveProviderOverride(
      this.getConfig().providerOverrides,
      provider,
    );
    const modelOverride = entry?.modelOverrides?.[modelId];
    if (!modelOverride) return undefined;
    const tuple = modelOverride.compat;
    const legacyFlat = {
      thinkingFormat: modelOverride.thinkingFormat,
      requiresReasoningContentOnAssistantMessages:
        modelOverride.requiresReasoningContentOnAssistantMessages,
      supportsDeveloperRole: modelOverride.supportsDeveloperRole,
    };
    return { tuple, legacyFlat };
  }

  /** Full layer breakdown (base / provider / model) for dialog + doctor. */
  modelMetaLayers(
    provider: Pick<CcProvider, "id" | "piName" | "displayName">,
    modelId?: string,
  ) {
    return resolveModelMetaLayers(this.getConfig(), provider, modelId);
  }

  /**
   * Does an *explicit* override exist for this provider (modelId omitted:
   * provider layer or any per-model entry) or for this exact model?
   * Drives the ⚙ badge in the picker.
   */
  hasModelMetaOverride(
    provider: Pick<CcProvider, "id" | "piName" | "displayName">,
    modelId?: string,
  ): boolean {
    if (modelId) return Boolean(this.modelMetaLayers(provider, modelId).model);
    const entry = resolveProviderOverride(
      this.getConfig().providerOverrides,
      provider,
    );
    if (cleanModelMeta(entry?.modelMeta)) return true;
    return Object.keys(entry?.modelOverrides ?? {}).length > 0;
  }
}

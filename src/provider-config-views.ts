/**
 * Config-derived provider views used by Runtime, registration, and doctor.
 *
 * Pure over PiSwitchConfig — no IO. Runtime holds one instance bound to
 * `() => this.config` so reloads are visible without reconstruction.
 */

import type { CcProvider, PiSwitchConfig } from "./types.ts";
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
} from "./model-meta.ts";
import { withBuiltInCompatUnderUser } from "./compat/built-in-compat-profile.ts";

export class ProviderConfigViews {
  constructor(private readonly getConfig: () => PiSwitchConfig) {}

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
   * Registration/display effective modelMeta:
   *   built-in compat < defaultModelMeta < provider.modelMeta < modelOverrides
   * (user wins per field).
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
  ) {
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

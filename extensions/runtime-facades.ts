/**
 * Runtime facades: narrow interfaces + pure functions extracted from Runtime.
 *
 * Each facade interface captures only the dependencies a specific operation needs,
 * enabling tests to mock just what they use instead of the full Runtime.
 *
 * The pure functions here are the testable core; Runtime methods delegate to them.
 */

import type {
  CcProvider,
  PiSwitchConfig,
  PiSwitchSelection,
} from "../src/types.ts";
import type { ModelsDevCapabilities } from "../src/capabilities/models-dev.ts";
import { ccMetaFrom, assembleCapabilityLayers } from "../src/capabilities/layers.ts";
import {
  resolveModelCapabilities,
  type ResolvedCapabilities,
} from "../src/capabilities/resolve.ts";
import { resolveEffectiveModelMeta } from "../src/model-meta.ts";
import type { EffectiveProviderCompatibility } from "../src/provider-config-views.ts";

/**
 * Narrow interface for capability resolution.
 * Tests can mock just these 2 members instead of the full Runtime.
 */
export interface CapabilitiesDeps {
  config: PiSwitchConfig;
  modelsDevFor(modelId: string): ModelsDevCapabilities | undefined;
}

/**
 * Match a saved selection against the provider list.
 *
 * Shared by session-target resolution (switch-lifecycle) and session
 * compatibility target resolution (Runtime). Kept here so both sites share
 * one source of truth for the dbId+appType → piName fallback shape.
 *
 * `dbId` wins when present; `piName` is the fallback. `appType` narrows the
 * dbId match but is ignored for the piName match (a piName uniquely identifies
 * a provider across app types).
 */
export function matchProvider(
  providers: CcProvider[],
  opts: { dbId?: string; appType?: string; piName?: string },
): CcProvider | undefined {
  if (opts.dbId) {
    const byId = providers.find(
      (item) => item.id === opts.dbId && (!opts.appType || item.appType === opts.appType),
    );
    if (byId) return byId;
  }
  if (opts.piName) {
    return providers.find((item) => item.piName === opts.piName);
  }
  return undefined;
}

/**
 * Pick the model id to activate for a saved selection.
 *
 * Distinct from switch-lifecycle's `resolveModelId`: that one normalizes a
 * preferred id against the provider's *listed* models (returning the
 * preferred id itself when not listed). This one fills a *missing* selection
 * model with the provider's first configModel — used by the compatibility
 * surface where there is no preferred id to validate, only a possibly-empty
 * selection slot. Empty string is preserved (not treated as missing).
 */
export function resolveSelectionModelId(
  provider: CcProvider | undefined,
  preferred: string | undefined,
): string | undefined {
  return preferred ?? provider?.configModels[0];
}

/**
 * Narrow interface for session compatibility target resolution.
 * Tests can mock just these 3 members instead of the full Runtime.
 */
export interface SessionCompatibilityDeps {
  lastGoodProviders: CcProvider[];
  readSelectionCached(ttlMs?: number): PiSwitchSelection | undefined;
  effectiveCompatibilityFor(provider: CcProvider): EffectiveProviderCompatibility;
}

/**
 * Pure function: resolve capability facts for a provider/model.
 *
 * Follows the full #36/#63 priority chain (user config layers only —
 * built-in compat is not a capability source). Extracted from Runtime.capabilitiesFor().
 *
 * Internal implementation detail of Runtime.capabilitiesFor — registration callers
 * consume RegistrationOperations instead: ADR-0002 makes its decision the shared
 * currency, not these lower facts.
 */
export function resolveCapabilitiesFor(
  provider: CcProvider,
  modelId: string,
  deps: CapabilitiesDeps,
): ResolvedCapabilities {
  const user = resolveEffectiveModelMeta(deps.config, provider, modelId);
  return resolveModelCapabilities(
    assembleCapabilityLayers({
      modelId,
      api: provider.api,
      baseUrl: provider.baseUrl,
      user,
      modelsDev: deps.modelsDevFor(modelId),
      ccMeta: ccMetaFrom(provider.meta),
    }),
  );
}

/**
 * Pure function: resolve session compatibility target.
 *
 * Matches the saved selection against the provider list and returns the matched
 * provider + model + compatibility ({} when no provider matches — same effective
 * compatibility shape for every consumer, per ADR-0003).
 * Extracted from Runtime.sessionCompatibilityTarget().
 */
export function resolveSessionCompatibilityTarget(
  deps: SessionCompatibilityDeps,
): {
  provider: CcProvider | undefined;
  dbId: string | undefined;
  providerName: string | undefined;
  modelId: string | undefined;
  compatibility: EffectiveProviderCompatibility;
} {
  const selection = deps.readSelectionCached();
  const provider = matchProvider(deps.lastGoodProviders, {
    dbId: selection?.dbId,
    appType: selection?.appType,
    piName: selection?.provider,
  });

  return {
    provider,
    dbId: selection?.dbId,
    providerName: selection?.provider,
    modelId: resolveSelectionModelId(provider, selection?.model),
    compatibility: provider ? deps.effectiveCompatibilityFor(provider) : {},
  };
}

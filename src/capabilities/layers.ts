/**
 * Shared capability layer assembly for registration and diagnostics.
 *
 * Single source of truth for the user > id-tag > host > models.dev > cc-meta >
 * protocol LayerInputs passed to resolveModelCapabilities (ADR-0001 layer
 * order). Callers own IO / cache; this module only builds pure layer facts.
 *
 * Issue #63: protocol floors may supply contextWindow and vision from the
 * protocol tier, but never invent maxTokens or reasoning.
 */

import { applyAnyrouterModelMeta } from "../headers/anyrouter.ts";
import { bracketContextWindow } from "../parse/common.ts";
import type { ModelMetaOverride, PiApi } from "../types.ts";
import { API_MODEL_META, DEFAULT_MODEL_META } from "../types.ts";
import type { ModelsDevCapabilities } from "./models-dev.ts";
import type { CapabilityMeta } from "./resolve.ts";

export type CapabilityLayerFacts = {
  modelId: string;
  api: PiApi | null;
  baseUrl: string;
  user?: ModelMetaOverride;
  modelsDev?: ModelsDevCapabilities;
  ccMeta?: CapabilityMeta;
};

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
 * Protocol structural floors shared by registration and diagnostics.
 * maxTokens and reasoning stay exclusive to the trusted authority chain (#63).
 */
export function protocolCapabilityDefaults(
  api: PiApi | null | undefined,
): CapabilityMeta {
  const tier = api ? API_MODEL_META[api] : undefined;
  if (tier) {
    return {
      contextWindow: tier.contextWindow,
      vision: tier.input.includes("image"),
    };
  }
  return {
    contextWindow: DEFAULT_MODEL_META.contextWindow,
  };
}

/** Build the complete capability precedence chain from caller-owned facts. */
export function assembleCapabilityLayers(input: CapabilityLayerFacts) {
  const contextWindow = bracketContextWindow(input.modelId);
  return {
    user: input.user,
    idTag: contextWindow !== undefined ? { contextWindow } : undefined,
    hostAdaptation: applyAnyrouterModelMeta(input.api, input.baseUrl),
    modelsDev: input.modelsDev,
    ccMeta: input.ccMeta,
    defaults: protocolCapabilityDefaults(input.api),
  };
}

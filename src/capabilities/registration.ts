/**
 * Registration-time capability assembly (issue #36).
 * Pure functions only — no IO, no await. Callers supply cache/network facts.
 */

import type { ModelMetaOverride, PiApi } from "../types.ts";
import { API_MODEL_META, DEFAULT_MODEL_META } from "../types.ts";
import { applyAnyrouterModelMeta } from "../headers/anyrouter.ts";
import { bracketContextWindow } from "../parse/common.ts";
import type { ModelsDevCapabilities } from "./models-dev.ts";
import {
  resolveModelCapabilities,
  type CapabilityMeta,
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
 * Resolve registration-facing model meta through the full capability chain.
 * Returns contextWindow / maxTokens / reasoning (and passthrough thinkingFormat).
 * vision has no registration surface (#15 D4) and is discarded.
 */
export function resolveRegistrationMeta(input: {
  modelId: string;
  api: PiApi | null;
  baseUrl: string;
  userMeta?: ModelMetaOverride;
  modelsDev?: ModelsDevCapabilities;
  ccMeta?: CapabilityMeta;
}): ModelMetaOverride {
  const tier = input.api ? API_MODEL_META[input.api] : undefined;
  const defaults: CapabilityMeta = tier
    ? {
        contextWindow: tier.contextWindow,
        maxTokens: tier.maxTokens,
        reasoning: tier.reasoning,
      }
    : {
        contextWindow: DEFAULT_MODEL_META.contextWindow,
        maxTokens: DEFAULT_MODEL_META.maxTokens,
        // DEFAULT_MODEL_META has no reasoning; protocol floor when api is null
        reasoning: true,
      };

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

  const out: ModelMetaOverride = {
    contextWindow: resolved.contextWindow.value,
    maxTokens: resolved.maxTokens.value,
    reasoning: resolved.reasoning.value,
  };
  if (input.userMeta?.thinkingFormat) {
    out.thinkingFormat = input.userMeta.thinkingFormat;
  }
  return out;
}

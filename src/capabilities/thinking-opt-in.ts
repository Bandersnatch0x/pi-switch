import type { ModelMetaOverride, ThinkingLevel } from "../types.ts";
import type {
  ThinkingProjectionDecision,
} from "./thinking-projection.ts";
import { nativeReasoningEffort } from "./thinking-projection.ts";

export type ThinkingOptInScope =
  | { kind: "provider" }
  | { kind: "model"; modelId: string };

export interface ExactModelThinkingOptInRequest {
  piLevel: ThinkingLevel;
  nativeValue: string;
}

export type ExactModelThinkingOptInValidation =
  | { ok: true }
  | { ok: false; error: string };

export const ULTRA_THINKING_OPT_IN = {
  piLevel: "max",
  nativeValue: "ultra",
} as const satisfies ExactModelThinkingOptInRequest;

export function validateExactModelThinkingOptIn(
  scope: ThinkingOptInScope,
  decision: ThinkingProjectionDecision | undefined,
  request: ExactModelThinkingOptInRequest,
): ExactModelThinkingOptInValidation {
  if (request.nativeValue.toLowerCase() === "ultracode") {
    return { ok: false, error: "ultracode is not an alias for ultra" };
  }
  if (request.piLevel !== "max" || request.nativeValue !== "ultra") {
    return { ok: false, error: "only max -> ultra opt-in is supported" };
  }
  if (scope.kind !== "model") {
    return { ok: false, error: "thinking opt-in requires exact-model scope" };
  }
  const modelId = scope.modelId.trim();
  if (!modelId || modelId.includes("*")) {
    return { ok: false, error: "thinking opt-in requires an exact model id" };
  }
  if (!decision) {
    return { ok: false, error: "thinking opt-in requires a profile-backed decision" };
  }
  if (decision.tuple.modelId !== modelId) {
    return { ok: false, error: "thinking decision does not match the exact model" };
  }
  if (!decision.source) {
    return { ok: false, error: "thinking decision has no profile authority" };
  }
  const advertised = decision.advertised.some(
    (value) => nativeReasoningEffort(value) === request.nativeValue,
  );
  if (!advertised) {
    return {
      ok: false,
      error: `provider profile does not advertise ${request.nativeValue}`,
    };
  }
  return { ok: true };
}

/** Return the one UI-supported opt-in only when the shared decision authorizes it. */
export function exactModelThinkingOptInFor(
  scope: ThinkingOptInScope,
  decision: ThinkingProjectionDecision | undefined,
): typeof ULTRA_THINKING_OPT_IN | undefined {
  const valid = validateExactModelThinkingOptIn(
    scope,
    decision,
    ULTRA_THINKING_OPT_IN,
  );
  return valid.ok ? ULTRA_THINKING_OPT_IN : undefined;
}

export function applyExactModelThinkingOptIn(
  modelMeta: ModelMetaOverride,
  scope: ThinkingOptInScope,
  decision: ThinkingProjectionDecision | undefined,
  request: ExactModelThinkingOptInRequest,
): { ok: true; modelMeta: ModelMetaOverride } | { ok: false; error: string } {
  const valid = validateExactModelThinkingOptIn(scope, decision, request);
  if (!valid.ok) return valid;
  return {
    ok: true,
    modelMeta: {
      ...modelMeta,
      thinkingLevelMap: {
        ...(modelMeta.thinkingLevelMap ?? {}),
        [request.piLevel]: request.nativeValue,
      },
    },
  };
}

export function activeExactModelThinkingOptIn(
  modelMeta: ModelMetaOverride,
  requested: ExactModelThinkingOptInRequest | undefined,
): ExactModelThinkingOptInRequest | undefined {
  return requested &&
    modelMeta.thinkingLevelMap?.[requested.piLevel] === requested.nativeValue
    ? requested
    : undefined;
}

/** Toggle one validated opt-in without mutating the caller's draft. */
export function toggleExactModelThinkingOptIn(
  modelMeta: ModelMetaOverride,
  scope: ThinkingOptInScope,
  decision: ThinkingProjectionDecision | undefined,
  request: ExactModelThinkingOptInRequest,
):
  | {
      ok: true;
      modelMeta: ModelMetaOverride;
      requested?: ExactModelThinkingOptInRequest;
    }
  | { ok: false; error: string } {
  if (modelMeta.thinkingLevelMap?.[request.piLevel] === request.nativeValue) {
    const nextMap = { ...modelMeta.thinkingLevelMap };
    delete nextMap[request.piLevel];
    const { thinkingLevelMap: _thinkingLevelMap, ...rest } = modelMeta;
    return {
      ok: true,
      modelMeta: Object.keys(nextMap).length
        ? { ...rest, thinkingLevelMap: nextMap }
        : rest,
    };
  }

  const applied = applyExactModelThinkingOptIn(
    modelMeta,
    scope,
    decision,
    request,
  );
  return applied.ok ? { ...applied, requested: request } : applied;
}

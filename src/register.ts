import type { CcProvider, ModelMetaOverride, PiApi } from "./types.ts";
import { API_MODEL_META, DEFAULT_MODEL_META } from "./types.ts";
import { applyAnyrouterHeaders } from "./headers/anyrouter.ts";
import { applyCodexWindowId } from "./headers/codex.ts";
import { mergeHeaders } from "./headers/merge.ts";
import type { HeaderRule } from "./types.ts";
import { isSwitchable } from "./parse/index.ts";
import type { ModelsDevCapabilities } from "./capabilities/models-dev.ts";
import {
  ccMetaFrom,
  resolveRegistrationCapability,
} from "./capabilities/registration.ts";
import {
  isOfficialOpenAiChatEndpoint,
  resolveChatTupleCompat,
  tupleCompatForRegistration,
  type ChatTupleCompat,
  type ResolvedChatTupleCompat,
} from "./model-tuple-compat.ts";
import {
  providerWireCompatForRegistration,
  resolveProviderWireCompat,
  type ProviderWireCompat,
  type ResolvedProviderWireCompat,
} from "./provider-wire-compat.ts";

/** Minimal ExtensionAPI surface used by register helpers. */
export interface PiRegisterApi {
  registerProvider: (name: string, config: Record<string, unknown>) => void;
  // optional in some pi versions
  unregisterProvider?: (name: string) => void;
  setModel: (model: unknown) => boolean | Promise<boolean>;
}

/**
 * Model config with per-api tiered meta (SPEC review #4).
 * Flat pi-switch modelMeta is reshaped to Pi's modern layout:
 *   - top-level thinkingLevelMap
 *   - nested compat.thinkingFormat / compat.requiresReasoningContentOnAssistantMessages
 * Legacy top-level thinkingFormat is never emitted.
 */
export function toModelConfig(
  modelId: string,
  api?: PiApi | null,
  /** Per-provider overrides from pi-switch.json providerOverrides[dbId].modelMeta. */
  meta?: ModelMetaOverride,
  /** Exact-model Chat tuple wire dialect (issue #64). */
  tupleCompat?: ResolvedChatTupleCompat,
) {
  const tier = api ? API_MODEL_META[api] : undefined;
  const compat: Record<string, unknown> = {};
  // Tuple registration wins; legacy flat thinkingFormat still flows via
  // resolveChatTupleCompat → tupleCompatForRegistration when no tuple set.
  const registrationTuple = tupleCompatForRegistration(tupleCompat);
  if (registrationTuple) {
    Object.assign(compat, registrationTuple);
  } else {
    if (meta?.thinkingFormat) compat.thinkingFormat = meta.thinkingFormat;
    if (typeof meta?.requiresReasoningContentOnAssistantMessages === "boolean") {
      compat.requiresReasoningContentOnAssistantMessages =
        meta.requiresReasoningContentOnAssistantMessages;
    }
    if (typeof meta?.supportsDeveloperRole === "boolean") {
      compat.supportsDeveloperRole = meta.supportsDeveloperRole;
    }
  }
  // Issue #63: never invent protocol maxTokens; require an explicit resolved value.
  // reasoning defaults to conservative false (not protocol true) when absent.
  if (typeof meta?.maxTokens !== "number" || meta.maxTokens <= 0) {
    throw new Error(
      `toModelConfig: maxTokens unresolved for ${modelId} (issue #63 — refuse protocol floor)`,
    );
  }
  return {
    id: modelId,
    name: modelId,
    reasoning: meta?.reasoning ?? false,
    input: (tier?.input ?? ["text"]) as ("text" | "image")[],
    cost: DEFAULT_MODEL_META.cost,
    contextWindow: meta?.contextWindow ?? tier?.contextWindow ?? DEFAULT_MODEL_META.contextWindow,
    maxTokens: meta.maxTokens,
    ...(meta?.thinkingLevelMap ? { thinkingLevelMap: meta.thinkingLevelMap } : {}),
    ...(Object.keys(compat).length ? { compat } : {}),
  };
}

export type BuiltModelConfig = ReturnType<typeof toModelConfig>;

export type BuiltProviderConfig = {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: PiApi;
  authHeader: boolean;
  headers?: Record<string, string>;
  models: BuiltModelConfig[];
};

export function buildProviderConfig(
  provider: CcProvider,
  modelIds: string[],
  opts: {
    rules: HeaderRule[];
    overrideHeaders?: Record<string, string>;
    /** fingerprint:"none" — skip defaults/provider-headers rules */
    skipRules?: boolean;
    vars?: Record<string, string>;
    debug?: boolean;
    onReject?: (name: string, reason: string) => void;
    /** Per-provider model meta overrides (reasoning/thinkingFormat/...). */
    modelMeta?: ModelMetaOverride;
    /**
     * Per-model resolver; wins over `modelMeta` when it returns a value.
     * Lets one provider register models with different reasoning/ctx settings.
     */
    modelMetaFor?: (modelId: string) => ModelMetaOverride | undefined;
    /**
     * Read-only models.dev cache lookup by exact model id (no network).
     * Stale last-good entries are still used; missing key = layer absent.
     */
    modelsDevFor?: (modelId: string) => ModelsDevCapabilities | undefined;
    /**
     * Pre-resolved Provider Chat wire fact (preferred).
     */
    providerWireCompat?: ResolvedProviderWireCompat;
    /** Raw Provider-scoped wire override when providerWireCompat omitted. */
    providerWireOverride?: ProviderWireCompat;
    /**
     * Exact-model Chat tuple compat resolver (issue #64).
     * Independent of model capability and Provider wire compat.
     */
    tupleCompatFor?: (modelId: string) =>
      | { tuple?: ChatTupleCompat; legacyFlat?: ModelMetaOverride }
      | undefined;
  },
): BuiltProviderConfig | undefined {
  if (!isSwitchable(provider) || !provider.api) return undefined;
  const ids = modelIds.length ? modelIds : provider.configModels;
  const resolvedWire =
    opts.providerWireCompat ??
    resolveProviderWireCompat({
      provider: { api: provider.api, baseUrl: provider.baseUrl },
      override: opts.providerWireOverride,
    });
  const registrationWire = providerWireCompatForRegistration(resolvedWire);
  const models = ids
    .filter(Boolean)
    .map((raw) => raw.trim())
    .flatMap((id) => {
      const userMeta = opts.modelMetaFor?.(id) ?? opts.modelMeta;
      const decision = resolveRegistrationCapability({
        modelId: id,
        api: provider.api,
        baseUrl: provider.baseUrl,
        userMeta,
        modelsDev: opts.modelsDevFor?.(id),
        ccMeta: ccMetaFrom(provider.meta),
      });
      // Issue #63: skip models with no trusted maxTokens authority.
      if (decision.maxTokensUnresolved || !decision.meta) return [];
      const tupleInput = opts.tupleCompatFor?.(id);
      const tupleResolved = resolveChatTupleCompat({
        modelId: id,
        providerApi: provider.api,
        tuple: tupleInput?.tuple,
        legacyFlat: tupleInput?.legacyFlat ?? userMeta,
        officialOpenAi:
          provider.api === "openai-completions" &&
          isOfficialOpenAiChatEndpoint(provider.baseUrl),
      });
      // Strip wire-dialect fields from capability meta so they only flow via tuple.
      const {
        thinkingFormat: _tf,
        requiresReasoningContentOnAssistantMessages: _rr,
        supportsDeveloperRole: _sd,
        ...capabilityMeta
      } = decision.meta;
      const model = toModelConfig(id, provider.api, capabilityMeta, tupleResolved);
      if (!registrationWire) return [model];
      return [
        {
          ...model,
          compat: {
            ...(model.compat ?? {}),
            ...registrationWire,
          },
        },
      ];
    });
  if (!models.length) return undefined;

  let headers = mergeHeaders({
    api: provider.api,
    rules: opts.rules,
    overrideHeaders: opts.overrideHeaders,
    skipRules: opts.skipRules,
    vars: opts.vars,
    debug: opts.debug,
    onReject: opts.onReject,
  });
  // anyrouter.top anthropic: merge official context-1m beta (Claude Code parity).
  // fingerprint:"none" is an explicit request to keep only user headers.
  if (!opts.skipRules) {
    headers = applyCodexWindowId(headers, opts.vars?.codexWindowId);
    headers = applyAnyrouterHeaders(provider.api, provider.baseUrl, headers);
  }

  return {
    name: provider.displayName,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    api: provider.api,
    authHeader: provider.authHeader,
    headers: Object.keys(headers).length ? headers : undefined,
    models,
  };
}

export function registerProvider(
  pi: PiRegisterApi,
  provider: CcProvider,
  modelIds: string[],
  opts: {
    rules: HeaderRule[];
    overrideHeaders?: Record<string, string>;
    skipRules?: boolean;
    vars?: Record<string, string>;
    debug?: boolean;
    onReject?: (name: string, reason: string) => void;
    modelMeta?: ModelMetaOverride;
    modelMetaFor?: (modelId: string) => ModelMetaOverride | undefined;
    modelsDevFor?: (modelId: string) => ModelsDevCapabilities | undefined;
    providerWireCompat?: ResolvedProviderWireCompat;
    providerWireOverride?: ProviderWireCompat;
    tupleCompatFor?: (modelId: string) =>
      | { tuple?: ChatTupleCompat; legacyFlat?: ModelMetaOverride }
      | undefined;
  },
): boolean {
  const config = buildProviderConfig(provider, modelIds, opts);
  if (!config) return false;
  pi.registerProvider(provider.piName, config);
  return true;
}

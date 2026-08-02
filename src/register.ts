import type { CcProvider, ModelMetaOverride, PiApi } from "./types.ts";
import { API_MODEL_META, DEFAULT_MODEL_META } from "./types.ts";
import { applyAnyrouterHeaders } from "./headers/anyrouter.ts";
import { applyCodexWindowId } from "./headers/codex.ts";
import { mergeHeaders } from "./headers/merge.ts";
import type { HeaderRule } from "./types.ts";
import { isSwitchable } from "./parse/index.ts";
import type { ModelsDevCapabilities } from "./capabilities/models-dev.ts";
import { resolveRegistrationMeta } from "./capabilities/registration.ts";

/** Minimal ExtensionAPI surface used by register helpers. */
export interface PiRegisterApi {
  registerProvider: (name: string, config: Record<string, unknown>) => void;
  // optional in some pi versions
  unregisterProvider?: (name: string) => void;
  setModel: (model: unknown) => boolean | Promise<boolean>;
}

/** Model config with per-api tiered meta (SPEC review #4). */
export function toModelConfig(
  modelId: string,
  api?: PiApi | null,
  /** Per-provider overrides from pi-switch.json providerOverrides[dbId].modelMeta. */
  meta?: ModelMetaOverride,
) {
  const tier = api ? API_MODEL_META[api] : undefined;
  return {
    id: modelId,
    name: modelId,
    reasoning: meta?.reasoning ?? tier?.reasoning ?? true,
    input: (tier?.input ?? ["text"]) as ("text" | "image")[],
    cost: DEFAULT_MODEL_META.cost,
    contextWindow: meta?.contextWindow ?? tier?.contextWindow ?? DEFAULT_MODEL_META.contextWindow,
    maxTokens: meta?.maxTokens ?? tier?.maxTokens ?? DEFAULT_MODEL_META.maxTokens,
    ...(meta?.thinkingFormat ? { thinkingFormat: meta.thinkingFormat } : {}),
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
  },
): BuiltProviderConfig | undefined {
  if (!isSwitchable(provider) || !provider.api) return undefined;
  const ids = modelIds.length ? modelIds : provider.configModels;
  const models = ids.filter(Boolean).map((raw) => {
    const id = raw.trim();
    const userMeta = opts.modelMetaFor?.(id) ?? opts.modelMeta;
    const meta = resolveRegistrationMeta({
      modelId: id,
      api: provider.api,
      baseUrl: provider.baseUrl,
      userMeta,
      modelsDev: opts.modelsDevFor?.(id),
    });
    return toModelConfig(id, provider.api, meta);
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
  },
): boolean {
  const config = buildProviderConfig(provider, modelIds, opts);
  if (!config) return false;
  pi.registerProvider(provider.piName, config);
  return true;
}

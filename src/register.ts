import type { CcProvider } from "./types.ts";
import { DEFAULT_MODEL_META } from "./types.ts";
import { mergeHeaders } from "./headers/merge.ts";
import type { HeaderRule } from "./types.ts";
import { isSwitchable } from "./parse/index.ts";

/** Minimal ExtensionAPI surface used by register helpers. */
export interface PiRegisterApi {
  registerProvider: (name: string, config: Record<string, unknown>) => void;
  // optional in some pi versions
  unregisterProvider?: (name: string) => void;
  setModel: (model: unknown) => boolean | Promise<boolean>;
}

export function toModelConfig(modelId: string) {
  return {
    id: modelId,
    name: modelId,
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    ...DEFAULT_MODEL_META,
  };
}

export function buildProviderConfig(
  provider: CcProvider,
  modelIds: string[],
  opts: {
    rules: HeaderRule[];
    overrideHeaders?: Record<string, string>;
    vars?: Record<string, string>;
    debug?: boolean;
  },
): Record<string, unknown> | undefined {
  if (!isSwitchable(provider) || !provider.api) return undefined;
  const ids = modelIds.length ? modelIds : provider.configModels;
  const models = ids.filter(Boolean).map((id) => toModelConfig(id.trim()));
  if (!models.length) return undefined;

  const headers = mergeHeaders({
    api: provider.api,
    rules: opts.rules,
    overrideHeaders: opts.overrideHeaders,
    vars: opts.vars,
    debug: opts.debug,
  });

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
    vars?: Record<string, string>;
    debug?: boolean;
  },
): boolean {
  const config = buildProviderConfig(provider, modelIds, opts);
  if (!config) return false;
  pi.registerProvider(provider.piName, config);
  return true;
}

/**
 * Commit order (SPEC §8.6):
 * 1. register candidate
 * 2. setModel
 * 3. on success unregister other ps-* (best-effort)
 * 4. caller persists selection
 */
export async function switchToProvider(opts: {
  pi: PiRegisterApi;
  provider: CcProvider;
  modelId: string;
  findModel: (providerName: string, modelId: string) => unknown;
  previousPsNames?: string[];
  rules: HeaderRule[];
  overrideHeaders?: Record<string, string>;
  vars?: Record<string, string>;
  debug?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const { pi, provider, modelId } = opts;
  const registered = registerProvider(pi, provider, [modelId], opts);
  if (!registered) {
    return { ok: false, error: provider.parseError ?? "cannot register provider" };
  }

  const model = opts.findModel(provider.piName, modelId);
  if (!model) {
    return { ok: false, error: `model not found after register: ${provider.piName} / ${modelId}` };
  }

  const ok = await pi.setModel(model);
  if (!ok) {
    return { ok: false, error: `setModel failed: ${provider.piName} / ${modelId}` };
  }

  // Cleanup other ps-* registrations
  if (pi.unregisterProvider && opts.previousPsNames) {
    for (const name of opts.previousPsNames) {
      if (name !== provider.piName && name.startsWith("ps-")) {
        try {
          pi.unregisterProvider(name);
        } catch {
          // ignore
        }
      }
    }
  }

  return { ok: true };
}

import { asRecord, asString, normalizeBaseUrlForPi, stripTrailingSlash, uniqueModels } from "./common.ts";
import { resolveApi } from "./api-format.ts";
import type { ParsedCore } from "./claude.ts";

export function parseHermes(config: unknown, apiFormat?: string): ParsedCore {
  const root = asRecord(config) ?? {};
  const baseUrl = stripTrailingSlash(
    asString(root.base_url) ?? asString(root.baseUrl) ?? "",
  );
  const apiKey = asString(root.api_key) ?? asString(root.apiKey) ?? "";
  const models = uniqueModels(extractHermesModels(root));
  const apiMode = asString(root.api_mode) ?? asString(root.apiMode);

  if (!baseUrl) {
    return err("missing base_url", models);
  }
  if (!apiKey) {
    return err("missing api_key", models);
  }

  const resolved = resolveApi({
    apiFormat,
    typeHint: apiMode,
    appTypeDefault: "openai-completions",
  });
  const normBaseUrl = normalizeBaseUrlForPi(resolved.ok ? resolved.api : null, baseUrl);
  if (!resolved.ok) {
    return {
      api: null,
      baseUrl: normBaseUrl,
      apiKey,
      authHeader: true,
      configModels: models,
      parseError: resolved.reason,
    };
  }

  return {
    api: resolved.api,
    baseUrl: normBaseUrl,
    apiKey,
    authHeader: true,
    configModels: models,
  };
}

function extractHermesModels(root: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof root.model === "string") out.push(root.model);
  if (Array.isArray(root.models)) {
    for (const m of root.models) {
      if (typeof m === "string") out.push(m);
      else {
        const rec = asRecord(m);
        if (typeof rec?.id === "string") out.push(rec.id);
        else if (typeof rec?.model === "string") out.push(rec.model);
      }
    }
  }
  return out;
}

function err(reason: string, models: string[]): ParsedCore {
  return {
    api: null,
    baseUrl: "",
    apiKey: "",
    authHeader: true,
    configModels: models,
    parseError: reason,
  };
}

import type { PiApi } from "../types.ts";
import {
  asRecord,
  asString,
  extractTomlValue,
  stripTrailingSlash,
  uniqueModels,
  escapeRegExp,
} from "./common.ts";
import { resolveApi } from "./api-format.ts";
import type { ParsedCore } from "./claude.ts";

export function parseCodex(config: unknown, apiFormat?: string): ParsedCore {
  const root = asRecord(config) ?? {};
  const auth = asRecord(root.auth) ?? {};
  const apiKey = asString(auth.OPENAI_API_KEY) ?? "";
  const toml = typeof root.config === "string" ? root.config : "";

  const models = uniqueModels(extractCodexModels(root, toml));
  const baseUrl = stripTrailingSlash(extractCodexBaseUrl(toml));

  if (!apiKey) {
    return err("missing auth.OPENAI_API_KEY", baseUrl, models);
  }
  if (!toml) {
    return err("missing config TOML", baseUrl, models);
  }
  if (!baseUrl) {
    return err("missing base_url in TOML", "", models);
  }

  const rawWire = extractTomlValue(toml, "wire_api") ?? "responses";
  const resolved = resolveApi({
    apiFormat,
    typeHint: rawWire,
    appTypeDefault: "openai-responses",
  });
  if (!resolved.ok) {
    return {
      api: null,
      baseUrl,
      apiKey,
      authHeader: true,
      configModels: models,
      parseError: resolved.reason,
    };
  }

  return {
    api: resolved.api,
    baseUrl,
    apiKey,
    authHeader: true,
    configModels: models,
  };
}

export function extractCodexBaseUrl(toml: string): string {
  const activeProvider = extractTomlValue(toml, "model_provider");
  if (activeProvider) {
    const blockRe = new RegExp(
      `\\[model_providers\\.${escapeRegExp(activeProvider)}\\]([\\s\\S]*?)(?:\\n\\[|$)`,
    );
    const block = toml.match(blockRe)?.[1];
    const url = block ? extractTomlValue(block, "base_url") : undefined;
    if (url) return url;
  }
  return extractTomlValue(toml, "base_url") ?? "";
}

function extractCodexModels(config: Record<string, unknown>, toml: string): string[] {
  const out: string[] = [];
  const top = extractTomlValue(toml, "model");
  if (top) out.push(top);
  const catalog = asRecord(config.modelCatalog);
  const models = catalog?.models;
  if (Array.isArray(models)) {
    for (const m of models) {
      const rec = asRecord(m);
      if (typeof rec?.model === "string") out.push(rec.model);
    }
  }
  return out;
}

function err(reason: string, baseUrl: string, models: string[]): ParsedCore {
  return {
    api: null,
    baseUrl,
    apiKey: "",
    authHeader: true,
    configModels: models,
    parseError: reason,
  };
}

// re-export for tests
export type { PiApi };

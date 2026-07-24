import {
  asRecord,
  asString,
  extractTomlValue,
  stripTrailingSlash,
  uniqueModels,
} from "./common.ts";
import { resolveApi } from "./api-format.ts";
import type { ParsedCore } from "./claude.ts";

/**
 * Best-effort parser for unknown app_type values.
 * Order: env.*BASE_URL + keys → options → base_url/api_key → TOML.
 */
export function parseGeneric(config: unknown, apiFormat?: string): ParsedCore {
  const root = asRecord(config) ?? {};

  // 1. env
  const env = asRecord(root.env);
  if (env) {
    const baseUrl = stripTrailingSlash(findEnv(env, /BASE_URL$/i) ?? "");
    const apiKey =
      findEnv(env, /AUTH_TOKEN$/i) ??
      findEnv(env, /API_KEY$/i) ??
      "";
    if (baseUrl && apiKey) {
      return finish(baseUrl, apiKey, !!findEnv(env, /AUTH_TOKEN$/i), collectModels(root, env), apiFormat);
    }
  }

  // 2. options
  const options = asRecord(root.options);
  if (options) {
    const baseUrl = stripTrailingSlash(
      asString(options.baseURL) ?? asString(options.baseUrl) ?? "",
    );
    const apiKey = asString(options.apiKey) ?? asString(options.api_key) ?? "";
    if (baseUrl && apiKey) {
      return finish(baseUrl, apiKey, true, collectModels(root, {}), apiFormat);
    }
  }

  // 3. top-level base_url / api_key
  {
    const baseUrl = stripTrailingSlash(
      asString(root.base_url) ?? asString(root.baseUrl) ?? "",
    );
    const apiKey = asString(root.api_key) ?? asString(root.apiKey) ?? "";
    if (baseUrl && apiKey) {
      return finish(baseUrl, apiKey, true, collectModels(root, {}), apiFormat);
    }
  }

  // 4. TOML in config string
  if (typeof root.config === "string") {
    const toml = root.config;
    const baseUrl = stripTrailingSlash(extractTomlValue(toml, "base_url") ?? "");
    const apiKey =
      extractTomlValue(toml, "api_key") ??
      extractTomlValue(toml, "OPENAI_API_KEY") ??
      "";
    if (baseUrl && apiKey) {
      return finish(baseUrl, apiKey, true, collectModels(root, {}), apiFormat);
    }
  }

  // 5. auth.OPENAI_API_KEY + TOML base
  const auth = asRecord(root.auth);
  if (auth && typeof root.config === "string") {
    const apiKey = asString(auth.OPENAI_API_KEY) ?? "";
    const baseUrl = stripTrailingSlash(extractTomlValue(root.config, "base_url") ?? "");
    if (baseUrl && apiKey) {
      return finish(baseUrl, apiKey, true, collectModels(root, {}), apiFormat);
    }
  }

  return {
    api: null,
    baseUrl: "",
    apiKey: "",
    authHeader: false,
    configModels: collectModels(root, env ?? {}),
    parseError: "unrecognized settings shape",
  };
}

function findEnv(env: Record<string, unknown>, re: RegExp): string | undefined {
  for (const [k, v] of Object.entries(env)) {
    if (re.test(k) && typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

function collectModels(
  root: Record<string, unknown>,
  env: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  if (typeof root.model === "string") out.push(root.model);
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && /MODEL$/i.test(k) && !/NAME$/i.test(k)) out.push(v);
  }
  const models = root.models;
  if (models && typeof models === "object" && !Array.isArray(models)) {
    out.push(...Object.keys(models as object));
  }
  if (Array.isArray(models)) {
    for (const m of models) {
      if (typeof m === "string") out.push(m);
      else {
        const rec = asRecord(m);
        if (typeof rec?.id === "string") out.push(rec.id);
      }
    }
  }
  return uniqueModels(out);
}

function finish(
  baseUrl: string,
  apiKey: string,
  authHeader: boolean,
  models: string[],
  apiFormat?: string,
): ParsedCore {
  const resolved = resolveApi({
    apiFormat,
    appTypeDefault: "openai-completions",
  });
  if (!resolved.ok) {
    return {
      api: null,
      baseUrl,
      apiKey,
      authHeader,
      configModels: models,
      parseError: resolved.reason,
    };
  }
  return {
    api: resolved.api,
    baseUrl,
    apiKey,
    authHeader,
    configModels: models,
  };
}

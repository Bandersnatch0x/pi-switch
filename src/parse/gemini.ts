import { asRecord, asString, stripTrailingSlash, uniqueModels } from "./common.ts";
import { resolveApi } from "./api-format.ts";
import type { ParsedCore } from "./claude.ts";

export function parseGemini(config: unknown, apiFormat?: string): ParsedCore {
  const root = asRecord(config) ?? {};
  const env = asRecord(root.env) ?? {};

  const baseUrl = stripTrailingSlash(
    asString(env.GOOGLE_GEMINI_BASE_URL) ??
      asString(env.GEMINI_BASE_URL) ??
      "",
  );
  const apiKey =
    asString(env.GEMINI_API_KEY) ??
    asString(env.GOOGLE_API_KEY) ??
    asString(env.GOOGLE_GEMINI_API_KEY) ??
    "";

  const models = uniqueModels([
    asString(env.GEMINI_MODEL) ?? "",
    asString(env.GOOGLE_GEMINI_MODEL) ?? "",
    typeof root.model === "string" ? root.model : "",
  ]);

  if (!baseUrl) return err("missing GOOGLE_GEMINI_BASE_URL", models);
  if (!apiKey) return err("missing GEMINI_API_KEY / GOOGLE_API_KEY", models);

  const resolved = resolveApi({
    apiFormat,
    appTypeDefault: "google-generative-ai",
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

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
  if (!apiKey) return err("missing GEMINI_API_KEY / GOOGLE_API_KEY", models, baseUrl);

  const resolved = resolveApi({
    apiFormat,
    appTypeDefault: "google-generative-ai",
  });
  if (!resolved.ok) {
    return {
      api: null,
      baseUrl,
      apiKey,
      authHeader: authHeaderForGemini(baseUrl),
      configModels: models,
      parseError: resolved.reason,
    };
  }

  return {
    api: resolved.api,
    baseUrl,
    apiKey,
    authHeader: authHeaderForGemini(baseUrl),
    configModels: models,
  };
}

/**
 * Native Google endpoints expect `x-goog-api-key` (the Pi google-generative-ai
 * protocol's default when authHeader is false). Third-party OpenAI-style gateways
 * that expose a gemini-compatible surface typically only accept `Authorization: Bearer`.
 * Default to Bearer (true) unless the host is unambiguously Google.
 */
function authHeaderForGemini(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return !host.endsWith("googleapis.com") && !host.endsWith("google.com");
  } catch {
    return true;
  }
}

function err(reason: string, models: string[], baseUrl = ""): ParsedCore {
  return {
    api: null,
    baseUrl,
    apiKey: "",
    authHeader: authHeaderForGemini(baseUrl),
    configModels: models,
    parseError: reason,
  };
}

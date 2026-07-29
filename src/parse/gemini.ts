import { asRecord, asString, stripTrailingSlash, uniqueModels } from "./common.ts";
import { resolveApi } from "./api-format.ts";
import type { ParsedCore } from "./claude.ts";

/**
 * Pi's `google-generative-ai` client sets `httpOptions.apiVersion = ""` whenever
 * a custom baseUrl is present (it assumes the version is already on the URL).
 * Gemini CLI / cc-switch usually store host-only URLs like
 * `https://generativelanguage.googleapis.com` or a third-party origin without
 * `/v1beta`. Without the version segment, @google/genai requests
 * `{base}/models/...:streamGenerateContent`, which many gateways answer with
 * HTML — and the SDK then throws "Incomplete JSON segment at the end".
 */
export function normalizeGeminiBaseUrlForPi(baseUrl: string): string {
  const base = stripTrailingSlash(baseUrl);
  if (!base) return base;
  if (/\/v\d+(?:alpha|beta)?$/i.test(base)) return base;
  return `${base}/v1beta`;
}

export function parseGemini(config: unknown, apiFormat?: string): ParsedCore {
  const root = asRecord(config) ?? {};
  const env = asRecord(root.env) ?? {};

  const rawBaseUrl = stripTrailingSlash(
    asString(env.GOOGLE_GEMINI_BASE_URL) ??
      asString(env.GEMINI_BASE_URL) ??
      "",
  );
  const baseUrl = normalizeGeminiBaseUrlForPi(rawBaseUrl);
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

  if (!rawBaseUrl) return err("missing GOOGLE_GEMINI_BASE_URL", models);
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

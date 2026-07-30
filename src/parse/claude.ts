import type { PiApi } from "../types.ts";
import { asRecord, asString, normalizeBaseUrlForPi, stripTrailingSlash, uniqueModels } from "./common.ts";
import { resolveApi } from "./api-format.ts";

export interface ParsedCore {
  api: PiApi | null;
  baseUrl: string;
  apiKey: string;
  authHeader: boolean;
  configModels: string[];
  parseError?: string;
  typeHint?: string;
}

export function parseClaude(
  config: unknown,
  apiFormat?: string,
): ParsedCore {
  const root = asRecord(config) ?? {};
  const env = asRecord(root.env) ?? {};

  const baseUrl = stripTrailingSlash(asString(env.ANTHROPIC_BASE_URL) ?? "");
  const authToken = asString(env.ANTHROPIC_AUTH_TOKEN) ?? "";
  const apiKeyOnly = asString(env.ANTHROPIC_API_KEY) ?? "";
  const apiKey = authToken || apiKeyOnly;

  const models = uniqueModels(extractClaudeModels(root, env));

  if (!baseUrl) {
    return emptyError("missing ANTHROPIC_BASE_URL", models);
  }
  if (!apiKey) {
    return emptyError("missing ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY", models);
  }

  const resolved = resolveApi({
    apiFormat,
    appTypeDefault: "anthropic-messages",
  });
  // Normalize per-protocol (OpenAI-family gets /v1 appended when host-only);
  // anthropic-messages is left as-is (Anthropic SDK builds /v1/messages itself).
  const normBaseUrl = normalizeBaseUrlForPi(resolved.ok ? resolved.api : null, baseUrl);
  if (!resolved.ok) {
    return {
      api: null,
      baseUrl: normBaseUrl,
      apiKey,
      authHeader: !!authToken && !apiKeyOnly,
      configModels: models,
      parseError: resolved.reason,
    };
  }

  return {
    api: resolved.api,
    baseUrl: normBaseUrl,
    apiKey,
    authHeader: !!authToken && !apiKeyOnly,
    configModels: models,
  };
}

function extractClaudeModels(
  config: Record<string, unknown>,
  env: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  if (typeof config.model === "string") out.push(config.model);
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    if (/MODEL$/.test(k) && !/NAME$/.test(k)) out.push(v);
  }
  return out;
}

function emptyError(reason: string, models: string[]): ParsedCore {
  return {
    api: null,
    baseUrl: "",
    apiKey: "",
    authHeader: false,
    configModels: models,
    parseError: reason,
  };
}

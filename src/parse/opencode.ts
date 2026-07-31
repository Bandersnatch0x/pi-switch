import { asRecord, asString, normalizeBaseUrlForPi, stripTrailingSlash, uniqueModels } from "./common.ts";
import { apiFromOpencodeNpm, resolveApi } from "./api-format.ts";
import type { ParsedCore } from "./claude.ts";

export function parseOpencode(config: unknown, apiFormat?: string): ParsedCore {
  const root = asRecord(config) ?? {};

  // Provider-style: { npm, options: { baseURL, apiKey }, models: { id: {...} } }
  // Sometimes nested under a single provider key.
  const candidates = [root, ...Object.values(root).map((v) => asRecord(v)).filter(Boolean)] as Record<
    string,
    unknown
  >[];

  for (const node of candidates) {
    const options = asRecord(node.options);
    const baseUrl = stripTrailingSlash(
      asString(options?.baseURL) ??
        asString(options?.baseUrl) ??
        asString(node.baseURL) ??
        asString(node.baseUrl) ??
        "",
    );
    const apiKey =
      asString(options?.apiKey) ??
      asString(options?.api_key) ??
      asString(node.apiKey) ??
      asString(node.api_key) ??
      "";
    const npm = asString(node.npm);
    const models = uniqueModels(extractOpencodeModels(node));

    if (baseUrl && apiKey) {
      const hint = apiFromOpencodeNpm(npm);
      const resolved = resolveApi({
        apiFormat,
        typeHint: hint,
        appTypeDefault: hint ?? "openai-completions",
      });
      if (!resolved.ok) {
        return {
          api: null,
          baseUrl: normalizeBaseUrlForPi(null, baseUrl),
          apiKey,
          authHeader: true,
          configModels: models,
          parseError: resolved.reason,
        };
      }
      return {
        api: resolved.api,
        baseUrl: normalizeBaseUrlForPi(resolved.api, baseUrl),
        apiKey,
        authHeader: true,
        configModels: models,
      };
    }
  }

  // agents-only shell (oh-my-opencode import without endpoint)
  return {
    api: null,
    baseUrl: "",
    apiKey: "",
    authHeader: true,
    configModels: [],
    parseError: "missing endpoint",
  };
}

function extractOpencodeModels(node: Record<string, unknown>): string[] {
  const out: string[] = [];
  const models = node.models;
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
  return out;
}

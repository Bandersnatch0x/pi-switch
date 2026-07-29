import {
  asRecord,
  extractAllTomlValues,
  extractTomlLoose,
  extractTomlValue,
  stripTrailingSlash,
  uniqueModels,
} from "./common.ts";
import { resolveApi } from "./api-format.ts";
import type { ParsedCore } from "./claude.ts";

export function parseGrokbuild(config: unknown, apiFormat?: string): ParsedCore {
  const root = asRecord(config) ?? {};
  const toml = typeof root.config === "string" ? root.config : "";
  if (!toml) {
    return err("missing config TOML", []);
  }

  const models = uniqueModels(extractGrokModels(toml));

  // extractTomlValue is section-blind and would silently pick the first block's
  // value. Refuse ambiguous multi-endpoint configs instead of connecting wrong.
  for (const key of ["base_url", "api_key"] as const) {
    const distinct = new Set(
      extractAllTomlValues(toml, key).map((v) => (key === "base_url" ? stripTrailingSlash(v) : v)),
    );
    if (distinct.size > 1) {
      return err(`ambiguous config: ${distinct.size} distinct ${key} values across blocks`, models);
    }
  }

  const baseUrl = stripTrailingSlash(
    extractTomlValue(toml, "base_url") ?? findFirstModelField(toml, "base_url") ?? "",
  );
  const apiKey =
    extractTomlValue(toml, "api_key") ?? findFirstModelField(toml, "api_key") ?? "";

  const backend =
    extractTomlLoose(toml, "api_backend") ??
    findFirstModelField(toml, "api_backend") ??
    undefined;

  if (!baseUrl) return err("missing base_url", models);
  if (!apiKey) return err("missing api_key", models);

  const resolved = resolveApi({
    apiFormat,
    typeHint: backend,
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

function extractGrokModels(toml: string): string[] {
  const out: string[] = [];
  const def = extractTomlValue(toml, "default");
  if (def) out.push(def);

  // [model."id"] or [model.id]
  const re = /\[model\.(?:"([^"]+)"|([^\]]+))\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(toml))) {
    out.push((m[1] || m[2]).trim());
  }
  return out;
}

function findFirstModelField(toml: string, key: string): string | undefined {
  const blocks = toml.split(/\[model\./).slice(1);
  for (const block of blocks) {
    const body = block.includes("]") ? block.slice(block.indexOf("]") + 1) : block;
    const v = extractTomlValue(body, key);
    if (v) return v;
  }
  return undefined;
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

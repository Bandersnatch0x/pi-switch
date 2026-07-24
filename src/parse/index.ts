import type { CcProvider, ProviderRow } from "../types.ts";
import { makePiName, parseMeta, safeJsonParse, asString } from "./common.ts";
import { parseClaude } from "./claude.ts";
import { parseCodex } from "./codex.ts";
import { parseGemini } from "./gemini.ts";
import { parseGrokbuild } from "./grokbuild.ts";
import { parseOpencode } from "./opencode.ts";
import { parseHermes } from "./hermes.ts";
import { parseGeneric } from "./generic.ts";
import type { ParsedCore } from "./claude.ts";

export * from "./common.ts";
export * from "./api-format.ts";
export { parseClaude } from "./claude.ts";
export { parseCodex } from "./codex.ts";
export { parseGemini } from "./gemini.ts";
export { parseGrokbuild } from "./grokbuild.ts";
export { parseOpencode } from "./opencode.ts";
export { parseHermes } from "./hermes.ts";
export { parseGeneric } from "./generic.ts";

/** Convert one DB row into a CcProvider (never returns null 鈥?failures become parseError). */
export function parseProviderRow(row: ProviderRow): CcProvider {
  const meta = parseMeta(row.meta ?? undefined);
  const apiFormat = asString(meta.apiFormat) ?? asString(meta.api_format);
  const modelsUrl = asString(meta.modelsUrl) ?? asString(meta.models_url);
  const isFullUrl = Boolean(meta.isFullUrl ?? meta.is_full_url);

  const configRaw = safeJsonParse(row.settings_config);
  let core: ParsedCore;

  if (configRaw === undefined) {
    core = {
      api: null,
      baseUrl: "",
      apiKey: "",
      authHeader: false,
      configModels: [],
      parseError: "invalid settings_config JSON",
    };
  } else {
    const app = (row.app_type || "").toLowerCase();
    switch (app) {
      case "claude":
        core = parseClaude(configRaw, apiFormat);
        break;
      case "codex":
        core = parseCodex(configRaw, apiFormat);
        break;
      case "gemini":
        core = parseGemini(configRaw, apiFormat);
        break;
      case "grokbuild":
      case "gork":
        core = parseGrokbuild(configRaw, apiFormat);
        break;
      case "opencode":
        core = parseOpencode(configRaw, apiFormat);
        break;
      case "hermes":
        core = parseHermes(configRaw, apiFormat);
        break;
      default:
        core = parseGeneric(configRaw, apiFormat);
        break;
    }
  }

  // Not switchable if no api or missing credentials/endpoint after parse
  let parseError = core.parseError;
  if (!parseError && (!core.api || !core.baseUrl || !core.apiKey)) {
    parseError = !core.api
      ? "unsupported or unresolved api"
      : !core.baseUrl
        ? "missing baseUrl"
        : "missing apiKey";
  }

  return {
    id: row.id,
    piName: makePiName(row.name, row.app_type, row.id),
    displayName: row.name,
    appType: row.app_type,
    api: parseError ? null : core.api,
    baseUrl: core.baseUrl,
    apiKey: core.apiKey,
    authHeader: core.authHeader,
    configModels: core.configModels,
    apiFormat,
    meta,
    isCurrentInCc: Boolean(row.is_current),
    parseError,
    websiteUrl: row.website_url ?? undefined,
    notes: row.notes ?? undefined,
    modelsUrl,
    isFullUrl,
  };
}

export function isSwitchable(p: CcProvider): boolean {
  return !p.parseError && !!p.api && !!p.baseUrl && !!p.apiKey;
}

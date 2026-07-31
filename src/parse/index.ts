import type { CcProvider, ProviderRow } from "../types.ts";
import { makePiName, parseMeta, safeJsonParse, asString, asRecord, hasLeafValue } from "./common.ts";
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

/** Human-readable reason for cc-switch official-login entries (credentials live in cc-switch, not the DB). */
export const MANAGED_AUTH_PARSE_ERROR =
  "官方/OAuth 登录条目:凭据由 cc-switch 托管,pi 无法直连";

/**
 * Official/OAuth entries carry no direct credentials in settings_config:
 * - claude/gemini Official: empty (possibly nested-empty) config object
 * - codex Official: auth.tokens OAuth block
 * - grokbuild Official: config-only TOML without base_url/api_key
 * Only consulted for rows that already failed to parse as switchable.
 */
function isManagedAuthEntry(configRaw: unknown): boolean {
  const root = asRecord(configRaw);
  if (!root) return false;
  if (!hasLeafValue(root)) {
    // Only trust bare config-container shells ({}, {env:{},config:{}}) — an
    // opencode agents-only shell is also leafless but is NOT an official entry.
    return Object.keys(root).every((k) => k === "env" || k === "config" || k === "auth");
  }
  // OAuth tokens only signal managed auth when no direct API key coexists —
  // a key + stale tokens + broken TOML must keep its real, fixable error.
  const auth = asRecord(root.auth);
  const tokens = asRecord(auth?.tokens);
  if (
    tokens &&
    !asString(auth?.OPENAI_API_KEY) &&
    ("access_token" in tokens || "refresh_token" in tokens)
  ) {
    return true;
  }
  const keys = Object.keys(root);
  return (
    keys.length === 1 &&
    typeof root.config === "string" &&
    !root.config.includes("base_url") &&
    !root.config.includes("api_key")
  );
}

/** Direct reusable credentials present in the config (any app-type convention). */
function hasDirectCredentials(configRaw: unknown): boolean {
  const root = asRecord(configRaw);
  if (!root) return false;
  if (asString(root.api_key) || asString(root.apiKey)) return true;
  const auth = asRecord(root.auth);
  if (auth && asString(auth.OPENAI_API_KEY)) return true;
  const env = asRecord(root.env);
  if (env) {
    return Boolean(
      asString(env.ANTHROPIC_API_KEY) ||
        asString(env.ANTHROPIC_AUTH_TOKEN) ||
        asString(env.GEMINI_API_KEY) ||
        asString(env.GOOGLE_API_KEY),
    );
  }
  return false;
}

/**
 * CC Switch `category == "official"` marks built-in managed-login entries:
 * credentials live in cc-switch (OAuth/token store), not as reusable keys.
 * Consulted only when the row already failed to parse and carries no direct
 * key, so a broken-but-keyed official entry keeps its real, fixable error.
 */
function isOfficialManagedAuth(row: ProviderRow, configRaw: unknown): boolean {
  return row.category === "official" && !hasDirectCredentials(configRaw);
}

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
  if (parseError && (isManagedAuthEntry(configRaw) || isOfficialManagedAuth(row, configRaw))) {
    parseError = MANAGED_AUTH_PARSE_ERROR;
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
    category: row.category ?? undefined,
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

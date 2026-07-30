/**
 * Gemini tool-calling compatibility for third-party proxies that don't
 * enforce parameter schemas without explicit toolConfig.
 *
 * Root cause: pi-ai's `resolveGoogleFunctionCallingMode` returns `undefined`
 * when no tool has `constrainedSampling` and no `toolChoice` is set, so
 * `toolConfig` is never sent. Official Google API defaults to AUTO (no-op),
 * but third-party proxies (e.g. elysia.h-e.top) need explicit `toolConfig`
 * to enforce schema validation — without it, the model returns `read({})`.
 *
 * Two-layer defence:
 * 1. Request layer: inject `toolConfig` + convert `parametersJsonSchema` → `parameters`
 * 2. Tool layer: block empty-args tool calls so the model regenerates
 */

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * Gemini tool-calling compat for third-party proxies that need explicit
 * `toolConfig` to enforce parameter schemas. Default mode is `auto`
 * (all Gemini API providers when `hosts` is empty).
 *
 * Mode semantics (aligned with Claude Code compat):
 * - `auto` — apply to Gemini API; if `hosts` is non-empty, require a host match
 * - `always` — apply to every Gemini API provider (ignore `hosts`)
 * - `never` — off (unless per-provider force)
 */
export interface GeminiToolCompatConfig {
  /** auto (default) | always | never */
  mode?: "auto" | "always" | "never";
  /** Restrict *auto* mode to these host substrings (empty = all Gemini providers). */
  hosts?: string[];
  /** Force a specific toolConfig mode. Default: AUTO for non-Gemini-3, VALIDATED for Gemini 3+. */
  forceToolConfigMode?: "AUTO" | "VALIDATED";
  /** Block tool calls with empty args so the model regenerates (default true). */
  blockEmptyToolCalls?: boolean;
  /** Convert parametersJsonSchema → parameters for proxy compatibility (default true). */
  convertSchema?: boolean;
}

export interface GeminiCompatOptions {
  forceToolConfigMode?: "AUTO" | "VALIDATED";
  convertSchema?: boolean;
  modelId?: string;
}

// ─── JSON Schema → OpenAPI 3.0 sanitization ──────────────────────────────

/** JSON Schema meta-declarations not supported by OpenAPI 3.0. */
const JSON_SCHEMA_META_KEYS = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$vocabulary",
  "$comment",
  "$defs",
  "definitions",
]);

/**
 * Strip JSON Schema meta-declarations from a schema object.
 * Mirrors pi-ai's `sanitizeForOpenApi` in google-shared.js.
 */
export function sanitizeForOpenApi(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return schema;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (JSON_SCHEMA_META_KEYS.has(key)) continue;
    result[key] = sanitizeForOpenApi(value);
  }
  return result;
}

// ─── Gemini version detection ────────────────────────────────────────────

/** Extract the Gemini major version from a model ID (e.g. "gemini-3.5-flash" → 3). */
export function getGeminiMajorVersion(modelId: string): number | undefined {
  const match = modelId.match(/gemini-(\d+)/i);
  return match ? parseInt(match[1], 10) : undefined;
}

/** Check if a model supports VALIDATED function calling mode (Gemini 3+). */
export function supportsValidatedMode(modelId: string): boolean {
  const v = getGeminiMajorVersion(modelId);
  return v !== undefined && v >= 3;
}

// ─── Payload detection & transformation ──────────────────────────────────

/** Check if a payload looks like a Gemini Generative AI request. */
export function isGeminiPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return "contents" in p && "config" in p && "model" in p;
}

/**
 * Transform a Gemini payload to fix tool-calling compatibility:
 *
 * 1. Inject `toolConfig.functionCallingConfig.mode` when tools exist but
 *    `toolConfig` is missing (root cause fix — proxies need this to enforce schemas).
 * 2. Convert `parametersJsonSchema` → `parameters` (OpenAPI 3.0.3 format)
 *    so proxies that don't understand the JSON Schema extension field can
 *    still read the required-parameter list.
 *
 * Returns the original payload unchanged if it's not a Gemini request or
 * has no tools.
 */
export function applyGeminiToolCompatToPayload(
  payload: unknown,
  opts: GeminiCompatOptions = {},
): unknown {
  if (!isGeminiPayload(payload)) return payload;

  const p0 = payload as Record<string, unknown>;
  const config0 = p0.config as Record<string, unknown> | undefined;
  if (!config0) return payload;
  const tools0 = config0.tools;
  if (!Array.isArray(tools0) || tools0.length === 0) return payload;

  // Selective clone: shallow-clone payload + config, deep-clone only tools.
  // This preserves AbortSignal and other non-serializable objects.
  const tools = JSON.parse(JSON.stringify(tools0));
  const config: Record<string, unknown> = { ...config0, tools };
  const p: Record<string, unknown> = { ...p0, config };


  // 1. Inject toolConfig if missing
  if (!config.toolConfig) {
    const modelId =
      opts.modelId ?? (typeof p.model === "string" ? p.model : "");
    const useValidated =
      opts.forceToolConfigMode === "VALIDATED" ||
      (opts.forceToolConfigMode === undefined && supportsValidatedMode(modelId));
    config.toolConfig = {
      functionCallingConfig: { mode: useValidated ? "VALIDATED" : "AUTO" },
    };
  }

  // 2. Convert parametersJsonSchema → parameters (OpenAPI 3.0.3)
  if (opts.convertSchema !== false) {
    for (const toolSet of tools) {
      if (!toolSet || typeof toolSet !== "object") continue;
      const fd = (toolSet as Record<string, unknown>).functionDeclarations;
      if (!Array.isArray(fd)) continue;
      for (const decl of fd) {
        if (!decl || typeof decl !== "object") continue;
        const d = decl as Record<string, unknown>;
        if ("parametersJsonSchema" in d) {
          if (!("parameters" in d)) {
            d.parameters = sanitizeForOpenApi(d.parametersJsonSchema);
          }
          delete d.parametersJsonSchema;
        }
      }
    }
  }

  return p;
}

// ─── Empty tool call detection ───────────────────────────────────────────

/** Built-in tool names that always require at least one parameter. */
const TOOLS_WITH_REQUIRED_PARAMS = new Set([
  "read",
  "edit",
  "write",
  "bash",
  "grep",
  "find",
]);

/**
 * Check if a tool call has empty or missing arguments for a tool that
 * requires parameters. Returns false for tools not in the known set.
 */
export function hasEmptyToolCallArgs(
  input: unknown,
  toolName: string,
): boolean {
  if (!TOOLS_WITH_REQUIRED_PARAMS.has(toolName)) return false;
  if (input === null || input === undefined) return true;
  if (typeof input !== "object") return false;
  const obj = input as Record<string, unknown>;
  return (
    Object.keys(obj).length === 0 ||
    Object.values(obj).every((v) => v === undefined || v === null || v === "")
  );
}

/** Generate a block reason string for an empty-args tool call. */
export function emptyToolCallReason(toolName: string): string {
  return (
    `Tool "${toolName}" was called with empty or missing arguments. ` +
    `This usually means the model did not see the required parameters. ` +
    `Please regenerate the tool call with all required parameters.`
  );
}

// ─── Apply decision ──────────────────────────────────────────────────────

/**
 * Decide whether to apply Gemini tool compat based on config and the
 * current provider. Mode semantics mirror `shouldApplyClaudeCodeCompat`:
 * `always` skips the host filter; `auto` honors `hosts`.
 */
export function shouldApplyGeminiToolCompat(opts: {
  mode?: "auto" | "always" | "never";
  hosts?: string[];
  api: string | null;
  baseUrl: string | null;
  providerForce?: boolean | null;
}): boolean {
  // Provider-level force takes precedence over mode
  if (opts.providerForce === true) return true;
  if (opts.providerForce === false) return false;

  const mode = opts.mode ?? "auto";
  if (mode === "never") return false;

  // Only applies to Gemini API providers
  if (opts.api !== "google-generative-ai") return false;

  // always: every Gemini provider, ignore hosts (same as Claude Code compat)
  if (mode === "always") return true;

  // auto: optional host allowlist (empty = all Gemini providers)
  const hosts = opts.hosts ?? [];
  if (hosts.length === 0) return true;
  if (!opts.baseUrl) return false;
  return hosts.some((h) =>
    opts.baseUrl!.toLowerCase().includes(h.toLowerCase()),
  );
}

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
 * 1. Request layer: inject `toolConfig` + rename `parametersJsonSchema` → `parameters`
 * 2. Tool layer: block empty-args tool calls so the model regenerates
 */

import { hostMatches } from "./claude-code.ts";

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * Gemini tool-calling compat for third-party proxies that need explicit
 * `toolConfig` to enforce parameter schemas.
 *
 * Mode semantics (same philosophy as Claude Code compat — `auto` targets
 * only the known-problem scope):
 * - `auto` (default) — non-official Gemini endpoints (proxies). Official
 *   `*.googleapis.com` and the default endpoint are left untouched.
 *   If `hosts` is non-empty, only those hosts (exact or parent domain).
 * - `always` — every Gemini API provider (ignore `hosts`)
 * - `never` — off (unless per-provider force)
 */
export interface GeminiToolCompatConfig {
  /** auto (default) | always | never */
  mode?: "auto" | "always" | "never";
  /** Restrict *auto* mode to these hostnames (exact or parent domain). */
  hosts?: string[];
  /**
   * toolConfig mode to inject. Default AUTO — VALIDATED proved unreliable
   * through proxies (docs/gemini-tool-call-compat-research.md repro #4).
   */
  forceToolConfigMode?: "AUTO" | "VALIDATED";
  /** Block tool calls with empty args so the model regenerates (default true). */
  blockEmptyToolCalls?: boolean;
  /** Rename parametersJsonSchema → parameters for proxy compatibility (default true). */
  convertSchema?: boolean;
}

export interface GeminiCompatOptions {
  forceToolConfigMode?: "AUTO" | "VALIDATED";
  convertSchema?: boolean;
}

// ─── JSON Schema meta-key stripping ──────────────────────────────────────

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
 * Strip JSON Schema meta-declarations from a schema object. This is a
 * meta-key strip only — `$ref` is NOT resolved, so a `$ref` into a stripped
 * `$defs` would dangle. Mirrors pi-ai's `sanitizeForOpenApi` in
 * google-shared.js byte-for-byte; pi's built-in tool schemas are flat, so
 * the dangling-`$ref` case never triggers for them.
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
 *    `toolConfig` is missing (root cause fix — proxies need this to enforce
 *    schemas). Injects AUTO unless `forceToolConfigMode: "VALIDATED"` is
 *    configured: VALIDATED proved unreliable through proxies
 *    (docs/gemini-tool-call-compat-research.md repro #4).
 * 2. Rename `parametersJsonSchema` → `parameters`, stripping JSON Schema
 *    meta keys, so proxies that don't understand the extension field can
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
    config.toolConfig = {
      functionCallingConfig: {
        mode: opts.forceToolConfigMode === "VALIDATED" ? "VALIDATED" : "AUTO",
      },
    };
  }

  // 2. Rename parametersJsonSchema → parameters (meta keys stripped)
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

/**
 * Built-in tool names guarded against all-empty argument objects.
 * Scope: this guard only catches fully-empty calls (`read({})`,
 * `read({file_path:""})`). Partially-missing required params (e.g.
 * `read({limit:100})` without `file_path`) are left to pi-ai's own
 * `validateToolArguments`, which errors back to the model.
 */
const EMPTY_ARGS_GUARDED_TOOLS = new Set([
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
  if (!EMPTY_ARGS_GUARDED_TOOLS.has(toolName)) return false;
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
 * Official Google endpoints don't need the compat fix — missing toolConfig
 * already means AUTO there. Empty baseUrl means pi falls back to the
 * official default endpoint. Unparseable URLs are treated as proxies
 * (fail-open is harmless: injecting AUTO matches official semantics).
 */
export function isOfficialGoogleBaseUrl(
  baseUrl: string | null | undefined,
): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return true;
  try {
    const hostname = new URL(trimmed).hostname.toLowerCase();
    return hostname === "googleapis.com" || hostname.endsWith(".googleapis.com");
  } catch {
    return false;
  }
}

/**
 * Decide whether to apply Gemini tool compat based on config and the
 * current provider. Same philosophy as `shouldApplyClaudeCodeCompat`:
 * `auto` targets only the known-problem scope (here: non-official
 * endpoints), `always` skips the host filter, per-provider force wins.
 */
export function shouldApplyGeminiToolCompat(opts: {
  mode?: "auto" | "always" | "never";
  hosts?: string[];
  api: string | null;
  baseUrl: string | null;
  providerForce?: boolean | null;
}): boolean {
  // Provider-level force takes precedence over mode, but still only for Gemini.
  // Mirrors Claude Code compat: force=true on a non-target api is a no-op.
  if (opts.providerForce === false) return false;
  if (opts.providerForce === true) {
    return opts.api === "google-generative-ai";
  }

  const mode = opts.mode ?? "auto";
  if (mode === "never") return false;

  // Only applies to Gemini API providers
  if (opts.api !== "google-generative-ai") return false;

  // always: every Gemini provider, ignore hosts (same as Claude Code compat)
  if (mode === "always") return true;

  // auto: explicit host allowlist wins; otherwise only non-official
  // endpoints — the official API treats missing toolConfig as AUTO already.
  const hosts = opts.hosts ?? [];
  if (hosts.length > 0) return hostMatches(opts.baseUrl, hosts);
  return !isOfficialGoogleBaseUrl(opts.baseUrl);
}

/** Parse `geminiToolCompat` from pi-switch.json (unknown → undefined). */
export function parseGeminiToolCompatConfig(
  raw: unknown,
): GeminiToolCompatConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const mode =
    r.mode === "auto" || r.mode === "always" || r.mode === "never"
      ? r.mode
      : undefined;
  const hosts = Array.isArray(r.hosts)
    ? r.hosts.filter((h): h is string => typeof h === "string" && h.trim().length > 0)
    : undefined;
  const forceToolConfigMode =
    r.forceToolConfigMode === "AUTO" || r.forceToolConfigMode === "VALIDATED"
      ? r.forceToolConfigMode
      : undefined;
  return {
    mode,
    hosts: hosts?.length ? hosts : undefined,
    forceToolConfigMode,
    blockEmptyToolCalls:
      typeof r.blockEmptyToolCalls === "boolean" ? r.blockEmptyToolCalls : undefined,
    convertSchema: typeof r.convertSchema === "boolean" ? r.convertSchema : undefined,
  };
}

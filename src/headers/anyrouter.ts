/**
 * anyrouter.top adaptation for Anthropic Messages relays.
 *
 * anyrouter enforces a 1M-context gate: without the official Anthropic beta
 * flag `context-1m-2025-08-07`, requests return
 *   "1m 上下文已经全量可用，请启用 1m 上下文后重试"
 * even for model ids without a [1M] suffix (account/channel policy).
 *
 * Claude Code injects this flag automatically; Pi does not. pi-switch fills
 * that gap only for known anyrouter hosts — not a global protocol default.
 *
 * Official beta id (Anthropic / Bedrock docs): context-1m-2025-08-07
 * — the date is the beta version suffix, not "today's date".
 */

import type { ModelMetaOverride, PiApi } from "../types.ts";

/** Anthropic official 1M-context beta flag (do not invent alternate dates). */
export const ANYROUTER_CONTEXT_1M_BETA = "context-1m-2025-08-07";

/** Local model meta default when registering anyrouter anthropic providers. */
export const ANYROUTER_DEFAULT_CONTEXT_WINDOW = 1_000_000;

/**
 * True when baseUrl points at anyrouter.top (or a subdomain).
 * Conservative: only this host family, not a free-form "relay" heuristic.
 */
export function isAnyrouterBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl?.trim()) return false;
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    return host === "anyrouter.top" || host.endsWith(".anyrouter.top");
  } catch {
    // Unparseable absolute URL — last-resort substring (no scheme, etc.)
    return /(?:^|[/.])anyrouter\.top(?:[:/]|$)/i.test(baseUrl.trim());
  }
}

/** Merge a beta flag into a comma-separated anthropic-beta value (deduped, stable). */
export function mergeAnthropicBetaFlag(
  existing: string | undefined,
  flag: string,
): string {
  const want = flag.trim();
  if (!want) return existing?.trim() ?? "";
  const parts = (existing ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.some((p) => p.toLowerCase() === want.toLowerCase())) {
    return parts.join(",");
  }
  parts.push(want);
  return parts.join(",");
}

/**
 * Apply anyrouter header adaptation onto already-merged allowlisted headers.
 * Only for anthropic-messages + anyrouter host. Idempotent.
 */
export function applyAnyrouterHeaders(
  api: PiApi | null | undefined,
  baseUrl: string,
  headers: Record<string, string>,
): Record<string, string> {
  if (api !== "anthropic-messages") return headers;
  if (!isAnyrouterBaseUrl(baseUrl)) return headers;

  const out = { ...headers };
  // Canonical casing used by HEADER_CANONICAL
  const key = "anthropic-beta";
  // Case-insensitive lookup of existing beta
  let current: string | undefined;
  let foundKey: string | undefined;
  for (const [k, v] of Object.entries(out)) {
    if (k.toLowerCase() === "anthropic-beta") {
      current = v;
      foundKey = k;
      break;
    }
  }
  const merged = mergeAnthropicBetaFlag(current, ANYROUTER_CONTEXT_1M_BETA);
  if (foundKey && foundKey !== key) delete out[foundKey];
  out[key] = merged;
  return out;
}

/**
 * Layer anyrouter modelMeta defaults under user overrides (user wins per field).
 * Only contextWindow for now — anyrouter gate is header-driven; 1M local meta
 * keeps status bar / compact aligned with the enabled window.
 */
export function applyAnyrouterModelMeta(
  api: PiApi | null | undefined,
  baseUrl: string,
  userMeta?: ModelMetaOverride,
): ModelMetaOverride | undefined {
  if (api !== "anthropic-messages" || !isAnyrouterBaseUrl(baseUrl)) {
    return userMeta;
  }
  return {
    contextWindow: ANYROUTER_DEFAULT_CONTEXT_WINDOW,
    ...userMeta,
  };
}

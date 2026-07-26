import type { PiApi } from "./types.ts";

/**
 * Model list URL candidates — port of cc-switch model_fetch.rs
 * (commit a377d793…, see research/cc-switch-model-discovery.md).
 */

/**
 * Known Anthropic-compatible subpath suffixes — ported verbatim from
 * cc-switch `model_fetch.rs` KNOWN_COMPAT_SUFFIXES.
 *
 * Ordered by length DESCENDING so the longest matching suffix wins when a
 * shorter one is a tail of a longer one (e.g. `/api/anthropic` must strip
 * the whole thing, not just `/anthropic`, otherwise the derived root is a
 * broken `…/api`). MUST stay sorted; `stripCompatSuffix` relies on this.
 */
const COMPAT_SUFFIXES = [
  "/api/claudecode",
  "/api/anthropic",
  "/apps/anthropic",
  "/api/coding",
  "/claudecode",
  "/anthropic",
  "/step_plan",
  "/coding",
  "/claude",
];

export interface ModelFetchInput {
  api?: PiApi | null;
  authHeader?: boolean;
  baseUrl: string;
  apiKey: string;
  modelsUrl?: string;
  isFullUrl?: boolean;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Build ordered candidate URLs (deduped, first-seen wins). */
export function buildModelUrlCandidates(input: {
  api?: PiApi | null;
  authHeader?: boolean;
  baseUrl: string;
  modelsUrl?: string;
  isFullUrl?: boolean;
}): string[] {
  const override = input.modelsUrl?.trim();
  if (override) return [override];

  const base = trimBase(input.baseUrl);
  if (!base) return [];

  if (input.api === "google-generative-ai" && input.authHeader === false) {
    const derived = buildNativeGeminiModelsUrl(base, input.isFullUrl);
    return derived ? [derived] : [];
  }

  if (input.isFullUrl) {
    const derived = deriveFromFullUrl(base);
    return derived ? [derived] : [];
  }

  const candidates: string[] = [];
  const push = (u: string) => {
    if (u && !candidates.includes(u)) candidates.push(u);
  };

  const versionMatch = base.match(/\/v(\d+)$/i);
  if (versionMatch) {
    push(`${base}/models`);
    if (versionMatch[1] !== "1") {
      push(`${base}/v1/models`);
    }
  } else {
    push(`${base}/v1/models`);
  }

  // ponytail: first (longest) matching suffix wins — array is length-desc sorted.
  const suffix = stripCompatSuffix(base);
  if (suffix) {
    const root = base.slice(0, -suffix.length).replace(/\/+$/, "");
    if (root) {
      push(`${root}/v1/models`);
      push(`${root}/models`);
    }
  }

  return candidates;
}

function buildNativeGeminiModelsUrl(base: string, isFullUrl?: boolean): string | undefined {
  if (/\/v1(?:beta)?\/models$/i.test(base)) return base;
  if (isFullUrl) {
    const match = base.match(/^(.*\/v1(?:beta)?\/models)(?:\/.*)?$/i);
    if (match?.[1]) return match[1];
  }
  if (/\/v1(?:beta)?$/i.test(base)) return `${base}/models`;
  return `${base}/v1beta/models`;
}

function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Longest matching compat suffix (case-insensitive) or undefined. Array order gives longest-first. */
function stripCompatSuffix(base: string): string | undefined {
  const lower = base.toLowerCase();
  return COMPAT_SUFFIXES.find((s) => lower.endsWith(s));
}

/** Strip any `?...`/`#...` and basic auth from a URL for safe error reporting. */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = "";
    u.hash = "";
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    // not a parseable URL — return truncated tail only
    return raw.length > 64 ? `${raw.slice(0, 64)}…` : raw;
  }
}

/** From a full request URL, derive a /v1/models endpoint. */
export function deriveFromFullUrl(full: string): string | undefined {
  const idx = full.toLowerCase().indexOf("/v1/");
  if (idx >= 0) {
    return `${full.slice(0, idx)}/v1/models`;
  }
  try {
    const u = new URL(full);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return undefined;
    parts.pop();
    u.pathname = "/" + parts.join("/") + (parts.length ? "/" : "");
    const root = u.toString().replace(/\/+$/, "");
    return `${root}/v1/models`;
  } catch {
    return undefined;
  }
}

/**
 * Fetch models trying candidates; only HTTP 404/405 advance to next.
 * Returns sorted unique ids or throws / returns error info.
 */
export async function fetchRemoteModels(
  input: ModelFetchInput,
): Promise<{ models: string[]; error?: string; urlUsed?: string }> {
  const candidates = buildModelUrlCandidates(input);
  if (!candidates.length) {
    return { models: [], error: "no model list candidates" };
  }
  if (!input.apiKey?.trim()) {
    return { models: [], error: "missing api key" };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 15_000;
  let lastError = "unknown error";

  for (const url of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = buildModelRequestHeaders(input);
      if (input.userAgent) headers["User-Agent"] = input.userAgent;

      const res = await fetchImpl(url, { headers, signal: controller.signal });
      if (res.status === 404 || res.status === 405) {
        lastError = `HTTP ${res.status} at ${redactUrl(url)}`;
        continue;
      }
      if (!res.ok) {
        return { models: [], error: `HTTP ${res.status} at ${redactUrl(url)}`, urlUsed: url };
      }
      const json: unknown = await res.json();
      const ids = extractModelIds(json).sort((a, b) => a.localeCompare(b));
      return { models: ids, urlUsed: url };
    } catch (err) {
      // err.message may embed the URL (with query/auth) on network failure; redact before surfacing.
      const raw = err instanceof Error ? err.message : String(err);
      const msg = raw.includes(url) ? raw.replaceAll(url, redactUrl(url)) : raw;
      return { models: [], error: msg, urlUsed: url };
    } finally {
      clearTimeout(timer);
    }
  }

  return { models: [], error: lastError };
}

function buildModelRequestHeaders(input: ModelFetchInput): Record<string, string> {
  if (input.authHeader === false && input.api === "anthropic-messages") {
    return {
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }
  if (input.authHeader === false && input.api === "google-generative-ai") {
    return { "x-goog-api-key": input.apiKey };
  }
  return { Authorization: `Bearer ${input.apiKey}` };
}

export function extractModelIds(json: unknown): string[] {
  const root = json as { data?: unknown; models?: unknown };
  const list = Array.isArray(root?.data)
    ? root.data
    : Array.isArray(root?.models)
      ? root.models
      : [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const m of list) {
    let id: string | undefined;
    if (typeof m === "string") id = m.trim();
    else if (m && typeof m === "object") {
      const rec = m as { id?: unknown; model?: unknown; name?: unknown };
      if (typeof rec.id === "string") id = rec.id.trim();
      else if (typeof rec.model === "string") id = rec.model.trim();
      else if (typeof rec.name === "string" && rec.name.startsWith("models/")) {
        id = rec.name.slice("models/".length).trim();
      }
    }
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** Merge config models (priority) with remote; exact-string dedupe. */
export function mergeModelLists(configModels: string[], remote: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...configModels, ...remote]) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

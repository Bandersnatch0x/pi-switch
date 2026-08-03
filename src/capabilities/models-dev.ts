/**
 * models.dev capability catalog (issue #15, W4).
 *
 * models.dev serves a full catalog at /api.json (v2 schema). Only the
 * registration-facing capability fields are extracted; the catalog is cached
 * with fetchedAt provenance and a TTL aligned to the compat window (#11).
 * Rollback = drop the cache and re-fetch (never runtime scraping).
 */

/** Full-catalog endpoint (single fetch covers every model id). */
export const MODELS_DEV_API_URL = "https://models.dev/api.json";

/** Capability cache staleness window (compat-window policy, #11 suggestion). */
export const CAPABILITIES_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Session-only failure cooldown after a network error (issue #39).
 * Not persisted; network failures must never be written as negative cache.
 */
export const CAPABILITIES_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

/** Provenance-bearing capability fact from models.dev. */
export interface ModelsDevCapabilities {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  vision?: boolean;
  /** models.dev `last_updated` (yyyy-mm-dd) if present, else fetch time. */
  observedAt: string;
  source: "models-dev";
}

/** Negative cache entry: confirmed absent from models.dev (issue #39). */
export interface ModelsDevMiss {
  missing: true;
  observedAt: string;
}

/** Positive hit or confirmed miss; both live in the capabilities map. */
export type ModelsDevCacheEntry = ModelsDevCapabilities | ModelsDevMiss;

/** Discriminant for negative cache entries. */
export function isModelsDevMiss(e: ModelsDevCacheEntry | undefined): e is ModelsDevMiss {
  return e !== undefined && (e as ModelsDevMiss).missing === true;
}

/** Build a negative cache entry for a model id confirmed absent. */
export function makeMiss(observedAt: string): ModelsDevMiss {
  return { missing: true, observedAt };
}

/**
 * Gate for background models.dev refresh (issue #39).
 * - Cooldown after session failure → false
 * - No entry (cold) → true
 * - Bad observedAt → false (treat as last-good, do not re-pull)
 * - observedAt older than ttl → true (positive and negative share TTL)
 */
export function shouldRefreshModelsDev(opts: {
  entry: ModelsDevCacheEntry | undefined;
  now: number;
  ttlMs: number;
  failedAt?: number;
  cooldownMs: number;
}): boolean {
  const { entry, now, ttlMs, failedAt, cooldownMs } = opts;
  if (failedAt !== undefined && now - failedAt < cooldownMs) return false;
  if (!entry) return true;
  const t = Date.parse(entry.observedAt);
  if (Number.isNaN(t)) return false;
  return now - t > ttlMs;
}

interface RawModel {
  limit?: { context?: unknown; output?: unknown };
  reasoning?: unknown;
  modalities?: { input?: unknown[] };
  last_updated?: unknown;
}

/** First provider entry matching the model id; undefined when absent. */
export function findModelsDevEntry(
  catalog: unknown,
  modelId: string,
): { model: RawModel; provider: string } | undefined {
  if (!catalog || typeof catalog !== "object") return undefined;
  for (const [provider, providerEntry] of Object.entries(
    catalog as Record<string, { models?: Record<string, unknown> }>,
  )) {
    const models = providerEntry?.models;
    if (!models || typeof models !== "object") continue;
    const hit = (models as Record<string, unknown>)[modelId];
    if (hit && typeof hit === "object") {
      return { model: hit as RawModel, provider };
    }
  }
  return undefined;
}

/** Extract the four registration-facing fields from a models.dev entry. */
export function extractModelsDevCapabilities(
  entry: RawModel,
  observedAt: string,
): ModelsDevCapabilities {
  const context =
    typeof entry.limit?.context === "number" ? entry.limit.context : undefined;
  const maxTokens =
    typeof entry.limit?.output === "number" ? entry.limit.output : undefined;
  const reasoning =
    typeof entry.reasoning === "boolean" ? entry.reasoning : undefined;
  const vision = Array.isArray(entry.modalities?.input)
    ? entry.modalities!.input.includes("image")
    : undefined;
  const updated = typeof entry.last_updated === "string" ? entry.last_updated : undefined;
  return {
    contextWindow: context,
    maxTokens,
    reasoning,
    vision,
    observedAt: updated ?? observedAt,
    source: "models-dev",
  };
}

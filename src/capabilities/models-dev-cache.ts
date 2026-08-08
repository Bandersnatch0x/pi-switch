/**
 * models.dev capability cache session (issue #39).
 *
 * Owns disk cache load/persist, background refresh, inflight dedupe, and
 * session-only failure cooldown. Pure extract/TTL helpers stay in models-dev.ts.
 * Runtime holds one instance and exposes thin facades for existing callers.
 */

import { piSwitchCachePath } from "../settings.ts";
import {
  CAPABILITIES_FAILURE_COOLDOWN_MS,
  CAPABILITIES_TTL_MS,
  extractModelsDevCapabilities,
  findModelsDevEntry,
  isModelsDevMiss,
  makeMiss,
  MODELS_DEV_API_URL,
  shouldRefreshModelsDev,
  type ModelsDevCacheEntry,
  type ModelsDevCapabilities,
} from "./models-dev.ts";

/** On-disk / in-memory cache file shape (~/.pi/agent/pi-switch-cache.json). */
export interface CapabilitiesCache {
  version: number;
  updatedAt?: string;
  /** Positive hits and confirmed misses share the map (issue #39). */
  capabilities: Record<string, ModelsDevCacheEntry>;
}

export type ModelsDevCacheIo = {
  home: string;
  readFileSync: (path: string, encoding: "utf8") => string;
  writeFileSync: (path: string, data: string, encoding: "utf8") => void;
  fetchJson: (url: string) => Promise<unknown>;
};

export type ModelsDevCacheOptions = {
  /** capabilitiesRefresh: "off" disables network refresh (default on). */
  isRefreshEnabled: () => boolean;
};

export class ModelsDevCache {
  private cached: CapabilitiesCache | undefined;
  private inflight: Promise<void> | undefined;
  /** Session-only network failure timestamp (never persisted). */
  private failedAt: number | undefined;
  private lastError: { at: number; message: string } | undefined;

  constructor(
    private readonly io: ModelsDevCacheIo,
    private readonly options: ModelsDevCacheOptions,
  ) {}

  private cachePath(): string {
    return piSwitchCachePath(this.io.home);
  }

  /** Load cache once; subsequent calls reuse memory. */
  read(): CapabilitiesCache {
    if (this.cached) return this.cached;
    try {
      const raw = JSON.parse(
        this.io.readFileSync(this.cachePath(), "utf8"),
      ) as CapabilitiesCache;
      this.cached =
        raw && typeof raw === "object" && raw.capabilities
          ? raw
          : { version: 1, capabilities: {} };
    } catch {
      this.cached = { version: 1, capabilities: {} };
    }
    return this.cached;
  }

  isStale(cap: { observedAt: string }): boolean {
    const t = Date.parse(cap.observedAt);
    if (Number.isNaN(t)) return false;
    return Date.now() - t > CAPABILITIES_TTL_MS;
  }

  /** Fetch the models.dev catalog once, extract model ids, persist cache. */
  refresh(modelIds: string[]): Promise<void> {
    if (this.inflight) return this.inflight;
    if (!this.options.isRefreshEnabled()) return Promise.resolve();
    this.inflight = (async () => {
      try {
        const catalog = await this.io.fetchJson(MODELS_DEV_API_URL);
        const now = new Date().toISOString();
        const cache = this.read();
        for (const id of modelIds) {
          const hit = findModelsDevEntry(catalog, id);
          // Hit → positive; confirmed absence → negative miss (#39).
          // Network errors never reach here — they must not write a miss.
          cache.capabilities[id] = hit
            ? extractModelsDevCapabilities(hit.model, now)
            : makeMiss(now);
        }
        cache.updatedAt = now;
        this.io.writeFileSync(
          this.cachePath(),
          JSON.stringify(cache, null, 2),
          "utf8",
        );
        this.failedAt = undefined;
        this.lastError = undefined;
      } catch (err) {
        const at = Date.now();
        this.failedAt = at;
        this.lastError = {
          at,
          message: err instanceof Error ? err.message : String(err),
        };
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  /**
   * Fire-and-forget background refresh after successful registration.
   * Synchronous path only — no await on the register hot path.
   */
  scheduleRefresh(modelId: string): void {
    if (!this.options.isRefreshEnabled()) return;
    if (
      !shouldRefreshModelsDev({
        entry: this.rawEntry(modelId),
        now: Date.now(),
        ttlMs: CAPABILITIES_TTL_MS,
        failedAt: this.failedAt,
        cooldownMs: CAPABILITIES_FAILURE_COOLDOWN_MS,
      })
    ) {
      return;
    }
    void this.refresh([modelId]);
  }

  lastRefreshFailure(): { at: number; message: string } | undefined {
    return this.lastError;
  }

  /**
   * Read-only models.dev lookup (no network). Misses filter to undefined so
   * resolve treats the layer as absent. Stale positives return last-good.
   */
  modelsDevFor(modelId: string): ModelsDevCapabilities | undefined {
    const e = this.read().capabilities[modelId];
    if (!e || isModelsDevMiss(e)) return undefined;
    return e;
  }

  /** Unfiltered entry (doctor / refresh gate); may be a miss. */
  rawEntry(modelId: string): ModelsDevCacheEntry | undefined {
    return this.read().capabilities[modelId];
  }
}

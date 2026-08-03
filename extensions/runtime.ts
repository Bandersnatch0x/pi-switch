/**
 * Mutable extension runtime: IO, config, header rules, provider snapshot, vars.
 * Populated after dynamic node:* imports in the extension factory.
 */

import type { CcProvider, HeaderRule, PiSwitchConfig, PiSwitchSelection } from "../src/types.ts";
import { API_MODEL_META } from "../src/types.ts";
import { defaultDbPath, readProviders } from "../src/db.ts";
import { parseHeaderRulesFile, combineRules } from "../src/headers/rules.ts";
import { providerHeadersPath, type FsLike } from "../src/settings.ts";
import { resolveProviderOverride } from "../src/provider-override.ts";
import { createLocalState, type LocalState } from "../src/local-state.ts";
import { buildHeaderVars, type ProbeDeps } from "../src/headers/vars.ts";
import { resolveOverrideHeaders, isFingerprintPreset } from "../src/headers/fingerprints.ts";
import { resolveEffectiveModelMeta, resolveModelMetaLayers, cleanModelMeta } from "../src/model-meta.ts";
import { resolveRoutingProbeUrl, ROUTING_PROBE_TIMEOUT_MS } from "../src/routing.ts";
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
} from "../src/capabilities/models-dev.ts";
import { resolveModelCapabilities } from "../src/capabilities/resolve.ts";
import { ccMetaFrom } from "../src/capabilities/registration.ts";
import { bracketContextWindow } from "../src/parse/common.ts";
import { applyAnyrouterModelMeta } from "../src/headers/anyrouter.ts";
import { piSettingsPath, piSwitchConfigPath, piSwitchCachePath } from "../src/settings.ts";
import { migrateIdentityState, type IdentityMigrationSummary } from "../src/migration.ts";

export type NodeIo = {
  /** Real node execFileSync; narrowed at call sites for ProbeDeps/DbReaderDeps. */
  execFileSync: typeof import("node:child_process").execFileSync;
  existsSync: typeof import("node:fs").existsSync;
  readFileSync: typeof import("node:fs").readFileSync;
  writeFileSync: typeof import("node:fs").writeFileSync;
  renameSync: typeof import("node:fs").renameSync;
  unlinkSync: typeof import("node:fs").unlinkSync;
  randomUUID: typeof import("node:crypto").randomUUID;
  /** Resolve a package's version from its installed package.json (W6 SDK check). */
  resolvePackageVersion: (name: string) => string | undefined;
  /** Absolute path to defaults/fingerprint-snapshot.json (W5 snapshot baselines). */
  snapshotPath: string;
  /** Probe an HTTP endpoint for reachability (W3 routing). Resolves true on any HTTP response. */
  probeHttp: (url: string, timeoutMs: number) => Promise<boolean>;
  /** Fetch a URL and parse as JSON (W4 models.dev catalog). */
  fetchJson: (url: string) => Promise<unknown>;
  release: string;
  home: string;
};

/** W5 fingerprint snapshot facts (subset of defaults/fingerprint-snapshot.json). */
export interface FingerprintSnapshot {
  snapshotVersion: number;
  baselines: { codex?: string; claudeCode?: string; gemini?: string };
}

/** W4 capability-facts cache file shape (~/.pi/agent/pi-switch-cache.json). */
interface CapabilitiesCache {
  version: number;
  updatedAt?: string;
  /** Positive hits and confirmed misses share the map (issue #39). */
  capabilities: Record<string, ModelsDevCacheEntry>;
}

export type VarsSummary = {
  codexVersion: string;
  codexVersionSource: string;
  claudeCodeVersion: string;
  claudeCodeVersionSource: string;
  geminiVersion: string;
  geminiVersionSource: string;
  anthropicBeta: string;
  codexOriginator: string;
};

export class Runtime {
  readonly io: NodeIo;
  readonly state: LocalState;
  lastGoodProviders: CcProvider[] = [];
  registeredPsNames: string[] = [];
  warnedMissingDbId = false;
  headerRules: HeaderRule[] = [];
  config: PiSwitchConfig = {};
  sqlite3Path = "sqlite3";
  sqlite3Tried: string[] = [];

  private cachedVars: Record<string, string> | undefined;
  private cachedVarsSummary: VarsSummary | undefined;
  private selectionCache: { at: number; value: PiSwitchSelection | undefined } | undefined;
  private readonly codexWindowId: string;
  private cachedPiVersion: string | undefined;
  private piVersionProbed = false;
  private cachedSnapshot: FingerprintSnapshot | undefined;
  private snapshotProbed = false;
  private cachedCapabilities: CapabilitiesCache | undefined;
  private capabilitiesInflight: Promise<void> | undefined;
  /** Session-only network failure timestamp (issue #39 cooldown; never persisted). */
  private capabilitiesFailedAt: number | undefined;
  private lastRefreshError: { at: number; message: string } | undefined;
  private identityMigration: IdentityMigrationSummary | undefined;
  private lastSchemaCapabilities: import("../src/db.ts").DbCapabilities | undefined;

  constructor(io: NodeIo) {
    this.io = io;
    this.codexWindowId = io.randomUUID();
    this.state = createLocalState({ fs: this.fsLike(), home: io.home });
  }

  get home(): string {
    return this.io.home;
  }

  fsLike(): FsLike {
    return {
      existsSync: this.io.existsSync,
      readFileSync: this.io.readFileSync as FsLike["readFileSync"],
      writeFileSync: this.io.writeFileSync as FsLike["writeFileSync"],
      renameSync: this.io.renameSync,
      unlinkSync: this.io.unlinkSync,
    };
  }

  /**
   * `readSelection` with a short TTL cache. Compat hooks fire on every
   * provider request AND every tool call; without this each firing hits the
   * settings.json file. Selection writes happen out-of-process (CLI), so a
   * 1s window is the staleness bound after an external switch.
   */
  readSelectionCached(ttlMs = 1000): PiSwitchSelection | undefined {
    const now = Date.now();
    if (this.selectionCache && now - this.selectionCache.at < ttlMs) {
      return this.selectionCache.value;
    }
    const value = this.state.readSelection();
    this.selectionCache = { at: now, value };
    return value;
  }

  loadConfig(): PiSwitchConfig {
    return this.state.readConfig();
  }

  reloadConfig(): PiSwitchConfig {
    this.config = this.loadConfig();
    return this.config;
  }

  loadHeaderRules(): HeaderRule[] {
    const defaultsPath = new URL("../defaults/headers.json", import.meta.url);
    let defaults: HeaderRule[] = [];
    try {
      // fileURL path for bun/node
      const p =
        defaultsPath.pathname.startsWith("/") && process.platform === "win32"
          ? decodeURIComponent(defaultsPath.pathname.slice(1))
          : decodeURIComponent(defaultsPath.pathname);
      if (this.io.existsSync(p)) {
        defaults = parseHeaderRulesFile(JSON.parse(this.io.readFileSync(p, "utf8")));
      }
    } catch {
      // package defaults optional at runtime
    }

    let shared: HeaderRule[] = [];
    try {
      const sp = providerHeadersPath(this.home);
      if (this.io.existsSync(sp)) {
        shared = parseHeaderRulesFile(JSON.parse(this.io.readFileSync(sp, "utf8")));
      }
    } catch {
      // ignore
    }
    return combineRules(defaults, shared);
  }

  reloadHeaderRules(): HeaderRule[] {
    this.headerRules = this.loadHeaderRules();
    return this.headerRules;
  }

  refreshSnapshot(): {
    providers: CcProvider[];
    error?: string;
    capabilities?: import("../src/db.ts").DbCapabilities;
  } {
    const result = readProviders({      execFileSync: this.io.execFileSync as import("../src/db.ts").DbReaderDeps["execFileSync"],
      existsSync: this.io.existsSync,
      sqlite3Path: this.sqlite3Path,
      dbPath: defaultDbPath(this.home),
    });
    this.lastSchemaCapabilities = result.capabilities;
    if (result.ok) {
      this.lastGoodProviders = result.providers;
      return { providers: result.providers, capabilities: result.capabilities };
    }
    if (this.lastGoodProviders.length) {
      return {
        providers: this.lastGoodProviders,
        error: result.error ?? "read failed; using last good snapshot",
        capabilities: result.capabilities,
      };
    }
    return {
      providers: [],
      error: result.error ?? "failed to read database",
      capabilities: result.capabilities,
    };
  }

  /**
   * One-shot identity migration (issue #16) + backup. Runs once; the
   * piSwitchMigration marker makes later calls a no-op. Never migrates
   * without a usable provider snapshot. Result surfaces in doctor.
   */
  migrateIdentity(providers: CcProvider[]): IdentityMigrationSummary | undefined {
    if (this.identityMigration) return this.identityMigration;
    this.identityMigration = migrateIdentityState({
      fs: this.fsLike(),
      settingsPath: piSettingsPath(this.io.home),
      configPath: piSwitchConfigPath(this.io.home),
      providers,
      pid: process.pid,
    });
    return this.identityMigration;
  }

  get migrationSummary(): IdentityMigrationSummary | undefined {
    return this.identityMigration;
  }

  /** Drop cached fingerprint probe (used by doctor). */
  invalidateVarsCache(): void {
    this.cachedVars = undefined;
    this.cachedVarsSummary = undefined;
  }

  /**
   * Running Pi version (W6 SDK window check). Probed once; undefined when the
   * hosting pi-coding-agent package cannot be resolved (e.g. odd bundling).
   */
  piVersion(): string | undefined {
    if (this.piVersionProbed) return this.cachedPiVersion;
    this.piVersionProbed = true;
    this.cachedPiVersion = this.io.resolvePackageVersion(
      "@earendil-works/pi-coding-agent",
    );
    return this.cachedPiVersion;
  }

  /**
   * Fingerprint snapshot baselines (W5). Probed once; undefined when the
   * packaged snapshot is missing or malformed.
   */
  fingerprintSnapshot(): FingerprintSnapshot | undefined {
    if (this.snapshotProbed) return this.cachedSnapshot;
    this.snapshotProbed = true;
    try {
      const raw = JSON.parse(this.io.readFileSync(this.io.snapshotPath, "utf8")) as {
        snapshotVersion?: unknown;
        upstream?: {
          codex?: { version?: unknown };
          claudeCode?: { version?: unknown };
          gemini?: { version?: unknown };
        };
      };
      const v = raw.snapshotVersion;
      const up = raw.upstream;
      if (typeof v !== "number" || !up) {
        this.cachedSnapshot = undefined;
        return undefined;
      }
      this.cachedSnapshot = {
        snapshotVersion: v,
        baselines: {
          codex: typeof up.codex?.version === "string" ? up.codex.version : undefined,
          claudeCode:
            typeof up.claudeCode?.version === "string" ? up.claudeCode.version : undefined,
          gemini: typeof up.gemini?.version === "string" ? up.gemini.version : undefined,
        },
      };
    } catch {
      this.cachedSnapshot = undefined;
    }
    return this.cachedSnapshot;
  }

  /**
   * W3 routing probe (fresh per call; doctor is on-demand).
   * Undefined when probing is explicitly disabled via routingProbeUrl: "".
   */
  async routingProbe(): Promise<{ url: string; reachable: boolean } | undefined> {
    // routingProbeUrl lives outside PiSwitchConfig to keep this work off the
    // in-flight capability-probe edits to src/types.ts; read it structurally.
    const url = resolveRoutingProbeUrl(
      this.config as { routingProbeUrl?: string } | undefined,
    );
    if (!url) return undefined;
    const reachable = await this.io.probeHttp(url, ROUTING_PROBE_TIMEOUT_MS);
    return { url, reachable };
  }

  // -----------------------------------------------------------------------
  // W4 capability facts (models.dev catalog cache + resolution)
  // -----------------------------------------------------------------------

  private cachePath(): string {
    return piSwitchCachePath(this.io.home);
  }

  /** capabilitiesRefresh: "off" disables network refresh (default on). */
  private capabilitiesRefreshEnabled(): boolean {
    const v = (this.config as { capabilitiesRefresh?: string } | undefined)?.capabilitiesRefresh;
    return v !== "off";
  }

  capabilitiesCache(): CapabilitiesCache {
    if (this.cachedCapabilities) return this.cachedCapabilities;
    try {
      const raw = JSON.parse(this.io.readFileSync(this.cachePath(), "utf8")) as CapabilitiesCache;
      this.cachedCapabilities =
        raw && typeof raw === "object" && raw.capabilities
          ? raw
          : { version: 1, capabilities: {} };
    } catch {
      this.cachedCapabilities = { version: 1, capabilities: {} };
    }
    return this.cachedCapabilities;
  }

  isCapabilitiesStale(cap: { observedAt: string }): boolean {
    const t = Date.parse(cap.observedAt);
    if (Number.isNaN(t)) return false;
    return Date.now() - t > CAPABILITIES_TTL_MS;
  }

  /** Fetch the models.dev catalog once, extract model ids, persist cache. */
  refreshCapabilities(modelIds: string[]): Promise<void> {
    if (this.capabilitiesInflight) return this.capabilitiesInflight;
    if (!this.capabilitiesRefreshEnabled()) return Promise.resolve();
    this.capabilitiesInflight = (async () => {
      try {
        const catalog = await this.io.fetchJson(MODELS_DEV_API_URL);
        const now = new Date().toISOString();
        const cache = this.capabilitiesCache();
        for (const id of modelIds) {
          const hit = findModelsDevEntry(catalog, id);
          // Hit → positive entry; confirmed absence → negative miss (issue #39).
          // Network errors never reach here — they must not write a miss.
          cache.capabilities[id] = hit
            ? extractModelsDevCapabilities(hit.model, now)
            : makeMiss(now);
        }
        cache.updatedAt = now;
        this.io.writeFileSync(this.cachePath(), JSON.stringify(cache, null, 2), "utf8");
        this.capabilitiesFailedAt = undefined;
        this.lastRefreshError = undefined;
      } catch (err) {
        // network failure: keep last-good cache; session cooldown only (never write miss)
        const at = Date.now();
        this.capabilitiesFailedAt = at;
        this.lastRefreshError = {
          at,
          message: err instanceof Error ? err.message : String(err),
        };
      } finally {
        this.capabilitiesInflight = undefined;
      }
    })();
    return this.capabilitiesInflight;
  }

  /**
   * Fire-and-forget background refresh after successful registration (issue #39).
   * Gates on config + TTL/cooldown via shouldRefreshModelsDev; reuses capabilitiesInflight.
   * Synchronous path only — no await, no network on the register hot path.
   */
  scheduleModelsDevRefresh(modelId: string): void {
    if (!this.capabilitiesRefreshEnabled()) return;
    if (
      !shouldRefreshModelsDev({
        entry: this.rawCacheEntry(modelId),
        now: Date.now(),
        ttlMs: CAPABILITIES_TTL_MS,
        failedAt: this.capabilitiesFailedAt,
        cooldownMs: CAPABILITIES_FAILURE_COOLDOWN_MS,
      })
    ) {
      return;
    }
    void this.refreshCapabilities([modelId]);
  }

  /** Session-only last background refresh failure (for doctor surface). */
  lastRefreshFailure(): { at: number; message: string } | undefined {
    return this.lastRefreshError;
  }

  /**
   * Read-only models.dev cache lookup by exact model id (no network, no await).
   * Negative entries are filtered to undefined so resolve treats the layer as absent.
   * Stale last-good positive entries are returned as-is; missing key = undefined.
   */
  modelsDevFor(modelId: string): ModelsDevCapabilities | undefined {
    const e = this.capabilitiesCache().capabilities[modelId];
    if (!e || isModelsDevMiss(e)) return undefined;
    return e;
  }

  /** Unfiltered cache entry (doctor / refresh gate); may be a miss. */
  rawCacheEntry(modelId: string): ModelsDevCacheEntry | undefined {
    return this.capabilitiesCache().capabilities[modelId];
  }

  /** Resolve capability facts for a provider/model (full #36 priority chain). */
  capabilitiesFor(provider: CcProvider, modelId: string) {
    const cache = this.modelsDevFor(modelId);
    const user = this.modelMetaFor(provider, modelId);
    const api = provider.api;
    const tier = api ? API_MODEL_META[api] : undefined;
    const defaults = tier
      ? {
          contextWindow: tier.contextWindow,
          maxTokens: tier.maxTokens,
          reasoning: tier.reasoning,
          vision: tier.input?.includes("image"),
        }
      : undefined;
    const ccMeta = ccMetaFrom(provider.meta);
    const cw = bracketContextWindow(modelId);
    const idTag = cw !== undefined ? { contextWindow: cw } : undefined;
    const hostAdaptation = applyAnyrouterModelMeta(api, provider.baseUrl);
    return resolveModelCapabilities({
      user,
      idTag,
      hostAdaptation,
      modelsDev: cache,
      ccMeta,
      defaults,
    });
  }

  get varsSummary(): VarsSummary | undefined {
    return this.cachedVarsSummary;
  }

  private probeHeaderVars() {
    return buildHeaderVars(
      {
        execFileSync: this.io.execFileSync as ProbeDeps["execFileSync"],
        existsSync: this.io.existsSync,
        readFileSync: this.io.readFileSync,
        platform: process.platform,
        arch: process.arch,
        release: this.io.release,
        homedir: this.home,
      },
      this.config.vars,
    );
  }

  headerVars(): Record<string, string> {
    if (this.cachedVars) return this.cachedVars;
    const vars = this.probeHeaderVars();
    if (this.config.debug) {
      console.log(
        `[pi-switch] codexVersion=${vars.codexVersion} (source=${vars.codexVersionSource})`,
      );
      console.log(
        `[pi-switch] claudeCodeVersion=${vars.claudeCodeVersion} (source=${vars.claudeCodeVersionSource})`,
      );
      console.log(
        `[pi-switch] geminiVersion=${vars.geminiVersion} (source=${vars.geminiVersionSource})`,
      );
      console.log(`[pi-switch] osInfo=${vars.osInfo}`);
      console.log(
        `[pi-switch] originator=${vars.codexOriginator} anthropic-beta=${vars.anthropicBeta}`,
      );
    }
    this.cachedVarsSummary = {
      codexVersion: vars.codexVersion,
      codexVersionSource: vars.codexVersionSource,
      claudeCodeVersion: vars.claudeCodeVersion,
      claudeCodeVersionSource: vars.claudeCodeVersionSource,
      geminiVersion: vars.geminiVersion,
      geminiVersionSource: vars.geminiVersionSource,
      anthropicBeta: vars.anthropicBeta,
      codexOriginator: vars.codexOriginator,
    };
    this.cachedVars = {
      codexVersion: vars.codexVersion,
      claudeCodeVersion: vars.claudeCodeVersion,
      geminiVersion: vars.geminiVersion,
      osInfo: vars.osInfo,
      anthropicVersion: vars.anthropicVersion,
      anthropicBeta: vars.anthropicBeta,
      codexOriginator: vars.codexOriginator,
      codexWindowId: this.codexWindowId,
    };
    return this.cachedVars;
  }

  /** Reject log sink for mergeHeaders allowlist — only active under config.debug. */
  rejectSink(): ((name: string, reason: string) => void) | undefined {
    if (!this.config.debug) return undefined;
    return (name, reason) => console.warn(`[pi-switch] header rejected: ${name} (${reason})`);
  }

  overridesFor(provider: Pick<CcProvider, "id" | "piName" | "displayName">) {
    const ov = resolveProviderOverride(this.config.providerOverrides, provider);
    if (!ov) return undefined;
    const fingerprint =
      typeof ov.fingerprint === "string" && isFingerprintPreset(ov.fingerprint)
        ? ov.fingerprint
        : undefined;
    // May set skipRules when fingerprint is "none" (clear default CLI disguise).
    const resolved = resolveOverrideHeaders({ fingerprint, headers: ov.headers });
    if (!resolved.headers && !resolved.skipRules) return undefined;
    return resolved;
  }

  /** Spread into lifecycle provider registration options. */
  headerOverrideOpts(provider: Pick<CcProvider, "id" | "piName" | "displayName">) {
    const resolved = this.overridesFor(provider);
    if (!resolved) return {};
    return {
      overrideHeaders: resolved.headers,
      skipRules: resolved.skipRules,
    };
  }

  /** Effective modelMeta: model override > provider override > defaultModelMeta. */
  modelMetaFor(
    provider: Pick<CcProvider, "id" | "piName" | "displayName">,
    modelId?: string,
  ) {
    return resolveEffectiveModelMeta(this.config, provider, modelId);
  }

  /** Full layer breakdown (base / provider / model) for dialog + doctor. */
  modelMetaLayers(
    provider: Pick<CcProvider, "id" | "piName" | "displayName">,
    modelId?: string,
  ) {
    return resolveModelMetaLayers(this.config, provider, modelId);
  }

  /**
   * Does an *explicit* override exist for this provider (modelId omitted:
   * provider layer or any per-model entry) or for this exact model?
   * Drives the ⚙ badge in the picker.
   */
  hasModelMetaOverride(
    provider: Pick<CcProvider, "id" | "piName" | "displayName">,
    modelId?: string,
  ): boolean {
    if (modelId) return Boolean(this.modelMetaLayers(provider, modelId).model);
    const entry = resolveProviderOverride(this.config.providerOverrides, provider);
    if (cleanModelMeta(entry?.modelMeta)) return true;
    return Object.keys(entry?.modelOverrides ?? {}).length > 0;
  }
}

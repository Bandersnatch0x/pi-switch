/**
 * Mutable extension runtime: IO, config, header rules, provider snapshot, vars.
 * Populated after dynamic node:* imports in the extension factory.
 *
 * Heavy seams live in dedicated modules; Runtime wires IO + config and
 * exposes stable facades for commands / lifecycle / doctor.
 */

import type { CcProvider, HeaderRule, PiSwitchConfig, PiSwitchSelection } from "../src/types.ts";
import type { DbReaderDeps } from "../src/db.ts";
import { defaultDbPath } from "../src/db.ts";
import { isSwitchable } from "../src/parse/index.ts";
import type { DoctorInput } from "../src/doctor.ts";
import { type FsLike } from "../src/json-file.ts";
import { PI_MIN_VERSION } from "../src/settings.ts";
import { createLocalState, type LocalState } from "../src/local-state.ts";
import type { ProbeDeps } from "../src/headers/vars.ts";
import {
  loadFingerprintSnapshot,
  type FingerprintSnapshot,
} from "../src/headers/fingerprint-snapshot.ts";
import {
  HeaderVarsSession,
  type VarsSummary,
} from "../src/headers/header-vars-session.ts";
import {
  fileUrlPath,
  loadHeaderRules,
} from "../src/headers/header-rules-load.ts";
import { probeRouting } from "../src/routing.ts";
import {
  ModelsDevCache,
  type CapabilitiesCache,
  type ModelsDevCacheIo,
} from "../src/capabilities/models-dev-cache.ts";
import { isModelsDevMiss } from "../src/capabilities/models-dev.ts";
import type {
  ModelsDevCacheEntry,
  ModelsDevCapabilities,
} from "../src/capabilities/models-dev.ts";
import type { ResolvedCapabilities } from "../src/capabilities/resolve.ts";
import type { ModelMetaLayers } from "../src/model-meta.ts";
import type { ModelMetaOverride } from "../src/types.ts";
import type { ResolvedOverrideHeaders } from "../src/headers/fingerprints.ts";
import type { ResolvedProviderWireCompat } from "../src/provider-wire-compat.ts";
import {
  ProviderConfigViews,
  type EffectiveProviderCompatibility,
  type TupleCompatSelection,
} from "../src/provider-config-views.ts";
import {
  ProviderSnapshot,
  type ProviderSnapshotResult,
} from "../src/provider-snapshot.ts";
import { SelectionCache } from "../src/selection-cache.ts";
import { piSettingsPath, piSwitchConfigPath } from "../src/paths.ts";
import { migrateIdentityState, type IdentityMigrationSummary } from "../src/migration.ts";
import {
  resolveCapabilitiesFor,
  resolveSessionCompatibilityTarget,
} from "./runtime-facades.ts";
import {
  createRegistrationOperations,
  type RegistrationOperations,
} from "./registration-operations.ts";

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

export type { FingerprintSnapshot, CapabilitiesCache, VarsSummary };

export type SessionCompatibilityTarget = {
  provider?: CcProvider;
  dbId?: string;
  providerName?: string;
  modelId?: string;
  compatibility: EffectiveProviderCompatibility;
};

export class Runtime {
  readonly io: NodeIo;
  readonly state: LocalState;
  readonly registration: RegistrationOperations;
  registeredPsNames: string[] = [];
  warnedMissingDbId = false;
  headerRules: HeaderRule[] = [];
  config: PiSwitchConfig = {};

  private readonly selectionCache = new SelectionCache<PiSwitchSelection | undefined>();
  private readonly codexWindowId: string;
  private cachedPiVersion: string | undefined;
  private piVersionProbed = false;
  private cachedSnapshot: FingerprintSnapshot | undefined;
  private snapshotProbed = false;
  private readonly modelsDevCache: ModelsDevCache;
  private readonly headerVarsSession: HeaderVarsSession;
  private readonly providerViews: ProviderConfigViews;
  private readonly providerSnapshot: ProviderSnapshot;
  private identityMigration: IdentityMigrationSummary | undefined;

  constructor(io: NodeIo) {
    this.io = io;
    this.codexWindowId = io.randomUUID();
    this.state = createLocalState({ fs: this.fsLike(), home: io.home });
    const cacheIo: ModelsDevCacheIo = {
      home: io.home,
      readFileSync: io.readFileSync as ModelsDevCacheIo["readFileSync"],
      writeFileSync: io.writeFileSync as ModelsDevCacheIo["writeFileSync"],
      fetchJson: io.fetchJson,
    };
    this.modelsDevCache = new ModelsDevCache(cacheIo, {
      isRefreshEnabled: () => this.capabilitiesRefreshEnabled(),
    });
    this.headerVarsSession = new HeaderVarsSession({
      probeDeps: () => this.probeHeaderVarsDeps(),
      configVars: () => this.config.vars,
      debug: () => Boolean(this.config.debug),
      codexWindowId: this.codexWindowId,
    });
    this.providerViews = new ProviderConfigViews(() => this.config);
    this.providerSnapshot = new ProviderSnapshot({
      home: io.home,
      execFileSync: io.execFileSync as DbReaderDeps["execFileSync"],
      existsSync: io.existsSync,
    });
    this.registration = createRegistrationOperations({
      headerRules: () => this.headerRules,
      headerOverrideOpts: (provider) => this.headerOverrideOpts(provider),
      headerVars: () => this.headerVars(),
      debug: () => this.config.debug,
      rejectSink: () => this.rejectSink(),
      modelMetaFor: (provider, modelId) => this.modelMetaFor(provider, modelId),
      modelsDevFor: (modelId) => this.modelsDevFor(modelId),
      providerWireCompatFor: (provider) => this.providerWireCompatFor(provider),
      tupleCompatFor: (provider, modelId) => this.tupleCompatFor(provider, modelId),
    });
  }

  /** Last-good providers list (public for lifecycle / compat hooks). */
  get lastGoodProviders(): CcProvider[] {
    return this.providerSnapshot.lastGoodProviders;
  }
  set lastGoodProviders(value: CcProvider[]) {
    this.providerSnapshot.lastGoodProviders = value;
  }

  get sqlite3Path(): string {
    return this.providerSnapshot.sqlite3Path;
  }
  set sqlite3Path(value: string) {
    this.providerSnapshot.sqlite3Path = value;
  }

  get sqlite3Tried(): string[] {
    return this.providerSnapshot.sqlite3Tried;
  }
  set sqlite3Tried(value: string[]) {
    this.providerSnapshot.sqlite3Tried = value;
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
    return this.selectionCache.get(ttlMs, () => this.state.readSelection());
  }

  sessionCompatibilityTarget(): SessionCompatibilityTarget {
    if (!this.lastGoodProviders.length) this.refreshSnapshot();

    return resolveSessionCompatibilityTarget({
      lastGoodProviders: this.lastGoodProviders,
      readSelectionCached: (ttl) => this.readSelectionCached(ttl),
      effectiveCompatibilityFor: (p) => this.providerViews.effectiveCompatibilityFor(p),
    });
  }

  loadConfig(): PiSwitchConfig {
    return this.state.readConfig();
  }

  reloadConfig(): PiSwitchConfig {
    this.config = this.loadConfig();
    return this.config;
  }

  loadHeaderRules(): HeaderRule[] {
    const defaultsPath = fileUrlPath(
      new URL("../defaults/headers.json", import.meta.url),
    );
    return loadHeaderRules({
      home: this.home,
      existsSync: this.io.existsSync,
      readFileSync: this.io.readFileSync as (p: string, e: "utf8") => string,
      defaultsPath,
    });
  }

  reloadHeaderRules(): HeaderRule[] {
    this.headerRules = this.loadHeaderRules();
    return this.headerRules;
  }

  refreshSnapshot(): ProviderSnapshotResult {
    return this.providerSnapshot.refresh();
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
    this.headerVarsSession.invalidate();
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
    this.cachedSnapshot = loadFingerprintSnapshot(
      { readFileSync: this.io.readFileSync as (p: string, e: "utf8") => string },
      this.io.snapshotPath,
    );
    return this.cachedSnapshot;
  }

  /**
   * W3 routing probe (fresh per call; doctor is on-demand).
   * Undefined when probing is explicitly disabled via routingProbeUrl: "".
   */
  async routingProbe(): Promise<{ url: string; reachable: boolean } | undefined> {
    // routingProbeUrl lives outside PiSwitchConfig to keep this work off the
    // in-flight capability-probe edits to src/types.ts; read it structurally.
    return probeRouting(
      this.config as { routingProbeUrl?: string } | undefined,
      this.io.probeHttp,
    );
  }

  // -----------------------------------------------------------------------
  // W4 capability facts (models.dev catalog cache + resolution)
  // -----------------------------------------------------------------------

  /** capabilitiesRefresh: "off" disables network refresh (default on). */
  private capabilitiesRefreshEnabled(): boolean {
    const v = (this.config as { capabilitiesRefresh?: string } | undefined)
      ?.capabilitiesRefresh;
    return v !== "off";
  }

  capabilitiesCache(): CapabilitiesCache {
    return this.modelsDevCache.read();
  }

  isCapabilitiesStale(cap: { observedAt: string }): boolean {
    return this.modelsDevCache.isStale(cap);
  }

  /** Fetch the models.dev catalog once, extract model ids, persist cache. */
  refreshCapabilities(modelIds: string[]): Promise<void> {
    return this.modelsDevCache.refresh(modelIds);
  }

  /**
   * Fire-and-forget background refresh after successful registration (issue #39).
   * Synchronous path only — no await, no network on the register hot path.
   */
  scheduleModelsDevRefresh(modelId: string): void {
    this.modelsDevCache.scheduleRefresh(modelId);
  }

  /** Session-only last background refresh failure (for doctor surface). */
  lastRefreshFailure(): { at: number; message: string } | undefined {
    return this.modelsDevCache.lastRefreshFailure();
  }

  /**
   * Read-only models.dev cache lookup by exact model id (no network, no await).
   * Negative entries are filtered to undefined so resolve treats the layer as absent.
   */
  modelsDevFor(modelId: string): ModelsDevCapabilities | undefined {
    return this.modelsDevCache.modelsDevFor(modelId);
  }

  /** Unfiltered cache entry (doctor / refresh gate); may be a miss. */
  rawCacheEntry(modelId: string): ModelsDevCacheEntry | undefined {
    return this.modelsDevCache.rawEntry(modelId);
  }

  /** Resolve capability facts for a provider/model (full #36/#63 priority chain). */
  capabilitiesFor(provider: CcProvider, modelId: string): ResolvedCapabilities {
    return resolveCapabilitiesFor(provider, modelId, {
      config: this.config,
      modelsDevFor: (m) => this.modelsDevFor(m),
    });
  }

  /**
   * Collect the full DoctorInput fact set: reload config/rules, force a
   * fingerprint re-probe, refresh the selected model's capability fact when
   * missing/stale (W4), and read routing/cache/migration state. runDoctor
   * stays a pure formatter; /ps-doctor stops hand-copying 24 fields.
   */
  async doctorFacts(): Promise<DoctorInput> {
    this.reloadConfig();
    this.reloadHeaderRules();
    // Force re-probe so doctor shows current fingerprint sources.
    this.invalidateVarsCache();
    this.headerVars();

    const { providers, error, capabilities: schemaCapabilities } = this.refreshSnapshot();
    const sel = this.state.readSelection();
    const dbPath = defaultDbPath(this.home);
    const routingProbe = await this.routingProbe();

    let capabilities: DoctorInput["capabilities"];
    let modelsDevCache: DoctorInput["modelsDevCache"];
    const selMatch = sel
      ? providers.find(
          (p) => p.id === sel.dbId && (!sel.appType || p.appType === sel.appType),
        )
      : undefined;
    if (sel && selMatch && isSwitchable(selMatch)) {
      const cached = this.rawCacheEntry(sel.model);
      if (!cached || this.isCapabilitiesStale(cached)) {
        await this.refreshCapabilities([sel.model]);
      }
      capabilities = {
        modelId: sel.model,
        decision: this.registration.decisionFor(selMatch, sel.model),
      };
      // Issue #39: surface cache state after on-demand refresh.
      const entry = this.rawCacheEntry(sel.model);
      if (!entry) {
        modelsDevCache = { state: "cold" };
      } else if (isModelsDevMiss(entry)) {
        modelsDevCache = { state: "miss", observedAt: entry.observedAt };
      } else {
        modelsDevCache = { state: "hit", observedAt: entry.observedAt };
      }
    }

    return {
      home: this.home,
      dbPath,
      dbExists: this.io.existsSync(dbPath),
      sqlite3Path: this.sqlite3Path || null,
      sqlite3Tried: this.sqlite3Tried,
      providers,
      providersError: error,
      selection: sel,
      config: this.config,
      headerRuleCount: this.headerRules.length,
      varsSummary: this.varsSummary,
      pins: this.config.pins,
      recent: this.config.recent,
      piVersion: this.piVersion(),
      piMinVersion: PI_MIN_VERSION,
      fingerprintSnapshot: this.fingerprintSnapshot(),
      routingProbe,
      capabilities,
      modelsDevCache,
      refreshFailure: this.lastRefreshFailure(),
      migrationSummary: this.migrationSummary,
      schemaCapabilities,
      providerWireCompat: selMatch
        ? this.providerWireCompatFor(selMatch)
        : undefined,
      cacheRetentionEnv: process.env.PI_CACHE_RETENTION,
    };
  }

  get varsSummary(): VarsSummary | undefined {
    return this.headerVarsSession.summary;
  }

  private probeHeaderVarsDeps(): ProbeDeps {
    return {
      execFileSync: this.io.execFileSync as ProbeDeps["execFileSync"],
      existsSync: this.io.existsSync,
      readFileSync: this.io.readFileSync as ProbeDeps["readFileSync"],
      platform: process.platform,
      arch: process.arch,
      release: this.io.release,
      homedir: this.home,
    };
  }

  headerVars(): Record<string, string> {
    return this.headerVarsSession.vars();
  }

  /** Reject log sink for mergeHeaders allowlist — only active under config.debug. */
  rejectSink(): ((name: string, reason: string) => void) | undefined {
    if (!this.config.debug) return undefined;
    return (name, reason) =>
      console.warn(`[pi-switch] header rejected: ${name} (${reason})`);
  }

  overridesFor(
    provider: Pick<CcProvider, "id" | "piName" | "displayName">,
  ): ResolvedOverrideHeaders | undefined {
    return this.providerViews.overridesFor(provider);
  }

  /** Spread into lifecycle provider registration options. */
  headerOverrideOpts(
    provider: Pick<CcProvider, "id" | "piName" | "displayName">,
  ): { overrideHeaders?: Record<string, string>; skipRules?: boolean } {
    return this.providerViews.headerOverrideOpts(provider);
  }

  /**
   * Registration/display effective modelMeta:
   *   built-in compat < defaultModelMeta < provider.modelMeta < modelOverrides
   * (user wins per field). Same compat resolveRegistrationMeta applies.
   * For user-config layers only, use modelMetaLayers(...).effective.
   */
  modelMetaFor(
    provider: Pick<CcProvider, "id" | "piName" | "displayName">,
    modelId?: string,
  ): ModelMetaOverride | undefined {
    return this.providerViews.modelMetaFor(provider, modelId);
  }

  /**
   * Provider-scoped Chat wire compat (issue #62). Uses providerOverrides.compat
   * only — never models.dev, model id tags, or CC Switch meta.
   */
  providerWireCompatFor(
    provider: Pick<CcProvider, "id" | "piName" | "displayName" | "api" | "baseUrl"> & {
      appType?: string;
    },
  ): ResolvedProviderWireCompat | undefined {
    return this.providerViews.providerWireCompatFor(provider);
  }

  /**
   * Exact-model Chat tuple wire dialect (issue #64).
   * Returns tuple + legacy flat fields for deprecation path.
   */
  tupleCompatFor(
    provider: Pick<CcProvider, "id" | "piName" | "displayName" | "api" | "baseUrl"> & {
      appType?: string;
    },
    modelId: string,
  ): TupleCompatSelection | undefined {
    return this.providerViews.tupleCompatFor(provider, modelId);
  }

  /** Full layer breakdown (base / provider / model) for dialog + doctor. */
  modelMetaLayers(
    provider: Pick<CcProvider, "id" | "piName" | "displayName">,
    modelId?: string,
  ): ModelMetaLayers {
    return this.providerViews.modelMetaLayers(provider, modelId);
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
    return this.providerViews.hasModelMetaOverride(provider, modelId);
  }
}

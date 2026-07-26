/**
 * Mutable extension runtime: IO, config, header rules, provider snapshot, vars.
 * Populated after dynamic node:* imports in the extension factory.
 */

import type { CcProvider, HeaderRule, PiSwitchConfig } from "../src/types.ts";
import { defaultDbPath, readProviders } from "../src/db.ts";
import { parseHeaderRulesFile, combineRules } from "../src/headers/rules.ts";
import { providerHeadersPath, type FsLike } from "../src/settings.ts";
import { resolveProviderOverride } from "../src/provider-override.ts";
import { createLocalState, type LocalState } from "../src/local-state.ts";
import { buildHeaderVars, type ProbeDeps } from "../src/headers/vars.ts";
import { resolveOverrideHeaders, isFingerprintPreset } from "../src/headers/fingerprints.ts";
import { resolveEffectiveModelMeta } from "../src/model-meta.ts";

export type NodeIo = {
  /** Real node execFileSync; narrowed at call sites for ProbeDeps/DbReaderDeps. */
  execFileSync: typeof import("node:child_process").execFileSync;
  existsSync: typeof import("node:fs").existsSync;
  readFileSync: typeof import("node:fs").readFileSync;
  writeFileSync: typeof import("node:fs").writeFileSync;
  renameSync: typeof import("node:fs").renameSync;
  release: string;
  home: string;
};

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

  constructor(io: NodeIo) {
    this.io = io;
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
    };
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

  refreshSnapshot(): { providers: CcProvider[]; error?: string } {
    const result = readProviders({
      execFileSync: this.io.execFileSync as import("../src/db.ts").DbReaderDeps["execFileSync"],
      existsSync: this.io.existsSync,
      sqlite3Path: this.sqlite3Path,
      dbPath: defaultDbPath(this.home),
    });
    if (result.ok) {
      this.lastGoodProviders = result.providers;
      return { providers: result.providers };
    }
    if (this.lastGoodProviders.length) {
      return {
        providers: this.lastGoodProviders,
        error: result.error ?? "read failed; using last good snapshot",
      };
    }
    return { providers: [], error: result.error ?? "failed to read database" };
  }

  /** Drop cached fingerprint probe (used by doctor). */
  invalidateVarsCache(): void {
    this.cachedVars = undefined;
    this.cachedVarsSummary = undefined;
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

  /** Effective modelMeta: per-provider override > defaultModelMeta. */
  modelMetaFor(provider: Pick<CcProvider, "id" | "piName" | "displayName">) {
    return resolveEffectiveModelMeta(this.config, provider);
  }
}

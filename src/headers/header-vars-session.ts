/**
 * Session cache for fingerprint header variables (UA / originator / beta).
 * Probes once per invalidate; debug logging optional via config.debug.
 */

import { buildHeaderVars, type ProbeDeps } from "./vars.ts";

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

export type HeaderVarsSessionDeps = {
  probeDeps: () => ProbeDeps;
  /** Configured vars overrides (may be undefined). */
  configVars: () => Parameters<typeof buildHeaderVars>[1];
  debug: () => boolean;
  codexWindowId: string;
};

export class HeaderVarsSession {
  private cachedVars: Record<string, string> | undefined;
  private cachedSummary: VarsSummary | undefined;

  constructor(private readonly deps: HeaderVarsSessionDeps) {}

  invalidate(): void {
    this.cachedVars = undefined;
    this.cachedSummary = undefined;
  }

  get summary(): VarsSummary | undefined {
    return this.cachedSummary;
  }

  vars(): Record<string, string> {
    if (this.cachedVars) return this.cachedVars;
    const probed = buildHeaderVars(this.deps.probeDeps(), this.deps.configVars());
    if (this.deps.debug()) {
      console.log(
        `[pi-switch] codexVersion=${probed.codexVersion} (source=${probed.codexVersionSource})`,
      );
      console.log(
        `[pi-switch] claudeCodeVersion=${probed.claudeCodeVersion} (source=${probed.claudeCodeVersionSource})`,
      );
      console.log(
        `[pi-switch] geminiVersion=${probed.geminiVersion} (source=${probed.geminiVersionSource})`,
      );
      console.log(`[pi-switch] osInfo=${probed.osInfo}`);
      console.log(
        `[pi-switch] originator=${probed.codexOriginator} anthropic-beta=${probed.anthropicBeta}`,
      );
    }
    this.cachedSummary = {
      codexVersion: probed.codexVersion,
      codexVersionSource: probed.codexVersionSource,
      claudeCodeVersion: probed.claudeCodeVersion,
      claudeCodeVersionSource: probed.claudeCodeVersionSource,
      geminiVersion: probed.geminiVersion,
      geminiVersionSource: probed.geminiVersionSource,
      anthropicBeta: probed.anthropicBeta,
      codexOriginator: probed.codexOriginator,
    };
    this.cachedVars = {
      codexVersion: probed.codexVersion,
      claudeCodeVersion: probed.claudeCodeVersion,
      geminiVersion: probed.geminiVersion,
      osInfo: probed.osInfo,
      anthropicVersion: probed.anthropicVersion,
      anthropicBeta: probed.anthropicBeta,
      codexOriginator: probed.codexOriginator,
      codexWindowId: this.deps.codexWindowId,
    };
    return this.cachedVars;
  }
}

/**
 * /ps-doctor — structured health checks (inspired by CallmeLins doctor UX).
 * Pure functions: no node imports; caller injects IO results.
 */

import type { CcProvider, PinEntry, PiSwitchConfig, PiSwitchSelection, RecentEntry } from "./types.ts";
import { compareSemver, PI_MIN_VERSION } from "./settings.ts";
import { isSwitchable } from "./parse/index.ts";
import {
  bold,
  dim,
  GLYPH,
  paint,
  STATUS_COLOR,
  statusBadge,
  type StatusKey,
} from "./ui/tui-theme.ts";
import { t, tf } from "./ui/tui-locale.ts";
import {
  CC_SWITCH_SCHEMA_LATEST,
  CC_SWITCH_SCHEMA_MIN,
  KNOWN_PROVIDERS_COLUMNS,
  type DbCapabilities,
} from "./db.ts";
import type { ResolvedCapabilities, CapabilitySource } from "./capabilities/resolve.ts";
import type { IdentityMigrationSummary } from "./migration.ts";
import { summarizeTiers } from "./tier.ts";
import {
  countModelOverrides,
  resolveModelMetaLayers,
  summarizeModelMeta,
} from "./model-meta.ts";
import {
  isBuiltInCompatDisabled,
  matchBuiltInCompatProfile,
  withBuiltInCompatUnderUser,
} from "./compat/built-in-compat-profile.ts";
import { resolveProviderOverride } from "./provider-override.ts";
import type { ResolvedProviderWireCompat } from "./provider-wire-compat.ts";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

export interface DoctorInput {
  home: string;
  dbPath: string;
  dbExists: boolean;
  sqlite3Path: string | null;
  sqlite3Tried?: string[];
  providers: CcProvider[];
  providersError?: string;
  selection?: PiSwitchSelection;
  config: PiSwitchConfig;
  headerRuleCount: number;
  varsSummary?: {
    codexVersion: string;
    codexVersionSource: string;
    claudeCodeVersion: string;
    claudeCodeVersionSource: string;
    geminiVersion: string;
    geminiVersionSource: string;
    anthropicBeta: string;
    codexOriginator: string;
  };
  pins?: PinEntry[];
  recent?: RecentEntry[];
  /** Detected Pi runtime version (W6 SDK). Undefined when not detectable. */
  piVersion?: string;
  /** Minimum supported Pi version (W6). Defaults to PI_MIN_VERSION. */
  piMinVersion?: string;
  /** Fingerprint snapshot baselines (W5). Undefined when not packaged. */
  fingerprintSnapshot?: {
    snapshotVersion: number;
    baselines: { codex?: string; claudeCode?: string; gemini?: string };
  };
  /** Routing probe result (W3). Undefined when probing disabled. */
  routingProbe?: { url: string; reachable: boolean };
  /** Resolved capability facts for the current model (W4). */
  capabilities?: { modelId: string; resolved: ResolvedCapabilities };
  /**
   * models.dev cache state for the selected model (issue #39).
   * miss/cold are informational only and never upgrade the check to warn.
   */
  modelsDevCache?: { state: "hit" | "miss" | "cold"; observedAt?: string };
  /** Last session-only background refresh failure (issue #39). */
  refreshFailure?: { at: number; message: string };
  /** Identity migration outcome (issue #16); present only on this run. */
  migrationSummary?: IdentityMigrationSummary;
  /** Probed CC Switch schema capabilities (W1). Undefined when not available. */
  schemaCapabilities?: DbCapabilities;
  /** Resolved Provider Chat wire fact for the current selection (issue #62). */
  providerWireCompat?: ResolvedProviderWireCompat;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  summary: { pass: number; warn: number; fail: number };
  lines: string[];
}

function countBy(checks: DoctorCheck[]): DoctorReport["summary"] {
  return {
    pass: checks.filter((c) => c.status === "pass").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length,
  };
}

function doctorSummaryText(summary: DoctorReport["summary"]): string {
  return `${t("pass")}=${summary.pass} ${t("warn")}=${summary.warn} ${t("fail")}=${summary.fail}`;
}

function formatDoctorCheckLines(
  checks: DoctorCheck[],
  format: {
    heading: (check: DoctorCheck) => string;
    detail: (detail: string) => string;
    fix: (fix: string) => string;
  },
): string[] {
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(format.heading(check));
    lines.push(format.detail(check.detail));
    if (!check.fix) continue;
    for (const fix of check.fix.split("；")) lines.push(format.fix(fix));
  }
  return lines;
}

export function runDoctor(input: DoctorInput): DoctorReport {
  const checks: DoctorCheck[] = [];

  // 1. sqlite3
  if (input.sqlite3Path) {
    checks.push({
      id: "sqlite3",
      title: t("docTitleSqlite3"),
      status: "pass",
      detail: input.sqlite3Path,
    });
  } else {
    checks.push({
      id: "sqlite3",
      title: t("docTitleSqlite3"),
      status: "fail",
      detail: `${t("docSqlite3NotFound")}${(input.sqlite3Tried ?? []).join(", ") || "(none)"}`,
      fix: t("docFixSqlite3"),
    });
  }

  // 1.5 identity migration outcome (issue #16)
  if (input.migrationSummary) {
    const m = input.migrationSummary;
    checks.push({
      id: "identity-migration",
      title: t("docTitleIdentity"),
      status: m.ambiguous || m.stale ? "warn" : "pass",
      detail: m.skipped
        ? `${t("docSkipped")} (${m.skipped})`
        : `migrated=${m.migrated} stale=${m.stale} ambiguous=${m.ambiguous}`,
      fix: m.ambiguous || m.stale ? t("docIdentityFix") : undefined,
    });
  }

  // 1.6 app-type support tiers (W2): direct / visible-only / routed summary
  if (input.providers.length) {
    for (const row of summarizeTiers(input.providers)) {
      const reasons = Object.entries(row.reasonDistribution)
        .map(([k, n]) => `${k}=${n}`)
        .join(", ");
      const nothingSwitchable = row.total > 0 && row.direct === 0;
      checks.push({
        id: `tier-${row.appType}`,
        title: `app type ${row.appType}`,
        status: nothingSwitchable ? "warn" : "pass",
        detail:
          `direct=${row.direct} visible=${row.visible} routed=${row.routed}` +
          (reasons ? ` (${reasons})` : "") +
          (row.routed ? t("docTierRoutedNote") : ""),
        fix: nothingSwitchable ? t("docTierNothingSwitchableFix") : undefined,
      });
    }
  }

  // 2. DB file
  if (input.dbExists) {
    checks.push({
      id: "db-file",
      title: t("docTitleCcDb"),
      status: "pass",
      detail: input.dbPath,
    });
  } else {
    checks.push({
      id: "db-file",
      title: t("docTitleCcDb"),
      status: "fail",
      detail: `${t("docDbMissing")}${input.dbPath}`,
      fix: t("docFixDb"),
    });
  }

  // 2.5 schema capabilities (W1): probed column set / composite key / version
  if (input.schemaCapabilities) {
    const cap = input.schemaCapabilities;
    const unknown = cap.columns.filter((c) => !KNOWN_PROVIDERS_COLUMNS.has(c));
    const facts =
      `columns=${cap.columns.length} category=${cap.hasCategory} ` +
      `provider_type=${cap.hasProviderType} compositeId=${cap.compositeId}` +
      (cap.userVersion !== undefined ? ` userVersion=${cap.userVersion}` : " userVersion=?");
    let status: DoctorStatus = "pass";
    let fix: string | undefined;
    if (cap.userVersion !== undefined && cap.userVersion > CC_SWITCH_SCHEMA_LATEST) {
      status = "warn";
      fix = t("docFixSchemaNew");
    } else if (cap.userVersion !== undefined && cap.userVersion < CC_SWITCH_SCHEMA_MIN) {
      status = "warn";
      fix = t("docFixSchemaOld");
    } else if (unknown.length) {
      status = "warn";
      fix = tf("docFixSchemaUnknown", { cols: unknown.join(", ") });
    }
    checks.push({
      id: "schema",
      title: t("docTitleSchema"),
      status,
      detail: `${input.providers.length} providers · ${facts}`,
      fix,
    });
  } else if (input.dbExists) {
    checks.push({
      id: "schema",
      title: t("docTitleSchema"),
      status: "warn",
      detail: t("docSchemaProbeFail"),
      fix: t("docFixSchemaFail"),
    });
  }

  // 3. providers snapshot
  if (input.providersError && !input.providers.length) {
    checks.push({
      id: "providers",
      title: t("docTitleReadProviders"),
      status: "fail",
      detail: input.providersError,
      fix: t("docFixProviders"),
    });
  } else {
    const switchable = input.providers.filter(isSwitchable).length;
    const blocked = input.providers.length - switchable;
    checks.push({
      id: "providers",
      title: t("docTitleProvidersSnap"),
      status: input.providers.length ? "pass" : "warn",
      detail: input.providers.length
        ? tf("docProvidersSnapOk", { n: input.providers.length, s: switchable, b: blocked })
        : t("docDbEmpty"),
      fix: input.providers.length ? undefined : t("docFixProvidersEmpty"),
    });
    if (input.providersError) {
      checks.push({
        id: "providers-stale",
        title: t("docTitleProvidersStale"),
        status: "warn",
        detail: input.providersError,
      });
    }
  }

  // 4. selection
  const sel = input.selection;
  if (!sel) {
    checks.push({
      id: "selection",
      title: t("docTitleSelection"),
      status: "warn",
      detail: t("docNoSelection"),
      fix: t("docFixSelectionNone"),
    });
  } else {
    const match = input.providers.find(
      (p) => p.id === sel.dbId && (!sel.appType || p.appType === sel.appType),
    );
    if (!match) {
      checks.push({
        id: "selection",
        title: t("docTitleSelection"),
        status: "fail",
        detail: `dbId=${sel.dbId}${sel.appType ? ` appType=${sel.appType}` : ""} model=${sel.model}${t("docSelNotInDb")}`,
        fix: t("docFixSelectionMissing"),
      });
    } else if (!isSwitchable(match)) {
      checks.push({
        id: "selection",
        title: t("docTitleSelection"),
        status: "fail",
        detail: `${match.appType}/${match.displayName}${t("docSelNotSwitchable")}${match.parseError ?? "unknown"}`,
        fix: t("docFixSelectionNotSwitchable"),
      });
    } else {
      checks.push({
        id: "selection",
        title: t("docTitleSelection"),
        status: "pass",
        detail: `${match.appType}/${match.displayName} · ${sel.model}`,
      });
    }
  }

  // 5. headers
  checks.push({
    id: "headers",
    title: t("docTitleHeaders"),
    status: input.headerRuleCount > 0 ? "pass" : "warn",
    detail: `${input.headerRuleCount}${t("docHeadersLoaded")}`,
    fix: input.headerRuleCount ? undefined : t("docFixHeaders"),
  });

  // 6. fingerprint vars (W5: fallback + out-of-snapshot detection)
  if (input.varsSummary) {
    const v = input.varsSummary;
    const snap = input.fingerprintSnapshot;
    const fallbacks = [
      v.codexVersionSource === "fallback" ? "codex" : null,
      v.claudeCodeVersionSource === "fallback" ? "claude" : null,
      v.geminiVersionSource === "fallback" ? "gemini" : null,
    ].filter(Boolean);
    // Locally probed CLI versions that drift from the fixture-verified
    // snapshot baseline are outside the fingerprint contract (W5).
    // config-pinned versions are the documented resolution, so they do not warn.
    const outOfSnapshot: string[] = [];
    const baseline = (cli: "codex" | "claudeCode" | "gemini", ver: string) => {
      const base = snap?.baselines[cli];
      if (base && ver !== base) outOfSnapshot.push(`${cli}:${ver}(local)≠${base}`);
    };
    if (snap) {
      if (v.codexVersionSource === "local") baseline("codex", v.codexVersion);
      if (v.claudeCodeVersionSource === "local") baseline("claudeCode", v.claudeCodeVersion);
      if (v.geminiVersionSource === "local") baseline("gemini", v.geminiVersion);
    }
    const status: DoctorStatus = fallbacks.length || outOfSnapshot.length ? "warn" : "pass";
    const fixes: string[] = [];
    if (fallbacks.length) {
      fixes.push(tf("docFixFingerprintFallback", { list: fallbacks.join(", ") }));
    }
    if (outOfSnapshot.length) {
      fixes.push(tf("docFixFingerprintSnapshot", { list: outOfSnapshot.join("; ") }));
    }
    checks.push({
      id: "fingerprint",
      title: t("docTitleFingerprint"),
      status,
      detail:
        `codex=${v.codexVersion}(${v.codexVersionSource}) · ` +
        `claude=${v.claudeCodeVersion}(${v.claudeCodeVersionSource}) · ` +
        `gemini=${v.geminiVersion}(${v.geminiVersionSource}) · ` +
        `originator=${v.codexOriginator} · beta=${v.anthropicBeta}` +
        (snap ? ` · snapshot=v${snap.snapshotVersion}` : ""),
      fix: fixes.length ? fixes.join("; ") : undefined,
    });
  }

  // 7. effective modelMeta for current selection (layer-aware)
  if (sel) {
    const match = input.providers.find(
      (p) => p.id === sel.dbId && (!sel.appType || p.appType === sel.appType),
    );
    if (match) {
      const layers = resolveModelMetaLayers(input.config, match, sel.model);
      // Same merge as runtime.modelMetaFor / registration compat (user wins).
      const effective = withBuiltInCompatUnderUser(sel.model, layers.effective);
      const builtIn =
        isBuiltInCompatDisabled(layers.effective)
          ? undefined
          : matchBuiltInCompatProfile(sel.model);
      const userSources: string[] = [];
      if (layers.base) userSources.push("defaultModelMeta");
      if (layers.provider) userSources.push("provider");
      if (layers.model) userSources.push(`model[${layers.modelKey}]`);
      const sourceBits: string[] = [];
      if (userSources.length) sourceBits.push(`${t("docUser")}: ${userSources.join(" → ")}`);
      if (builtIn) sourceBits.push(`${t("docBuiltIn")}: ${builtIn.key}`);
      else if (isBuiltInCompatDisabled(layers.effective) && matchBuiltInCompatProfile(sel.model)) {
        sourceBits.push(`${t("docBuiltIn")}: ${t("docBuiltInDisabled")}`);
      }
      const detail =
        summarizeModelMeta(effective) +
        (sourceBits.length ? ` (${sourceBits.join("; ")})` : "");
      checks.push({
        id: "model-meta",
        title: t("docTitleModelMeta"),
        status: "pass",
        detail,
        fix:
          effective?.reasoning === false
            ? undefined
            : t("docFixModelMeta"),
      });
    }
  }

  // 7b. per-model overrides: count + stale keys
  const modelOverrideCount = countModelOverrides(input.config.providerOverrides);
  if (modelOverrideCount) {
    const stale: string[] = [];
    for (const provider of input.providers) {
      const entry = resolveProviderOverride(input.config.providerOverrides, provider);
      for (const key of Object.keys(entry?.modelOverrides ?? {})) {
        if (key.includes("*")) continue;
        if (!provider.configModels.includes(key)) {
          stale.push(`${provider.displayName}/${key}`);
        }
      }
    }
    checks.push({
      id: "model-overrides",
      title: t("docTitleModelOverrides"),
      status: stale.length ? "warn" : "pass",
      detail: stale.length
        ? tf("docModelOverridesStale", {
            n: modelOverrideCount,
            m: stale.length,
            list: stale.slice(0, 3).join(", "),
          })
        : tf("docModelOverridesOk", { n: modelOverrideCount }),
      fix: stale.length ? t("docFixModelOverrides") : undefined,
    });
  }

  // 8. pins
  const pins = input.pins ?? input.config.pins ?? [];
  if (pins.length) {
    const broken = pins.filter((p) => !input.providers.some((x) => x.id === p.dbId));
    checks.push({
      id: "pins",
      title: t("docTitlePins"),
      status: broken.length ? "warn" : "pass",
      detail: broken.length
        ? `${tf("docPinsOk", { n: pins.length })}${tf("docPinsBroken", { n: broken.length })}`
        : tf("docPinsOk", { n: pins.length }),
      fix: broken.length ? t("docFixPins") : undefined,
    });
  } else {
    checks.push({
      id: "pins",
      title: t("docTitlePins"),
      status: "pass",
      detail: t("docNoPins"),
    });
  }

  // 9. recent
  const recent = input.recent ?? input.config.recent ?? [];
  checks.push({
    id: "recent",
    title: t("docTitleRecent"),
    status: "pass",
    detail: recent.length ? tf("docRecentKept", { n: recent.length }) : t("docRecentNone"),
  });

  // 10. routing (W3): CC Switch Local Routing proxy reachability
  if (input.routingProbe) {
    checks.push({
      id: "routing",
      title: t("docTitleRouting"),
      status: input.routingProbe.reachable ? "pass" : "warn",
      detail: input.routingProbe.reachable
        ? tf("docRoutingReach", { url: input.routingProbe.url })
        : tf("docRoutingUnreach", { url: input.routingProbe.url }),
      fix: input.routingProbe.reachable
        ? undefined
        : t("docFixRouting"),
    });
  }

  // 11. capabilities (W4 + #63): provenance, conflicts, staleness, unresolved maxTokens
  if (input.capabilities) {
    const cap = input.capabilities.resolved;
    const fieldLine = (
      label: string,
      e: {
        value: number | boolean | undefined;
        source: CapabilitySource;
        fetchedAt?: string;
        stale?: boolean;
      },
    ) => {
      const src =
        e.source === "models-dev"
          ? `models.dev@${e.fetchedAt ?? "?"}${e.stale ? t("docStale") : ""}`
          : e.source === "model-id-tag"
            ? t("docSrcModelIdTag")
            : e.source === "host-adaptation"
              ? t("docSrcHostAdapt")
              : e.source === "conservative-default"
                ? "unknown→conservative"
                : e.source === "unresolved"
                  ? "unresolved"
                  : e.source;
      if (e.source === "unresolved") return `${label}=unresolved`;
      if (e.source === "conservative-default" && label === "reasoning") {
        return `${label}=unknown→conservative false`;
      }
      return `${label}=${e.value}(${src})`;
    };
    const failRows: string[] = [];
    const warnRows: string[] = [];
    if (
      cap.maxTokens.source === "unresolved" ||
      typeof cap.maxTokens.value !== "number"
    ) {
      failRows.push(`maxTokens=unresolved${t("docCapUnresolved")}`);
    }
    if (cap.reasoning.source === "conservative-default") {
      warnRows.push(`reasoning=unknown→conservative false${t("docCapReasoningUnknown")}`);
    }
    for (const c of cap.conflicts) {
      warnRows.push(`${c.field}=${c.effective}(${c.effectiveSource}) vs ${c.overridden}(${c.overriddenSource})`);
    }
    for (const e of [cap.contextWindow, cap.maxTokens, cap.reasoning, cap.vision]) {
      if (e.source === "models-dev" && e.stale) {
        warnRows.push(`models.dev@${e.fetchedAt ?? "?"} ${t("docStale")}${t("docCapLastGood")}`);
      }
    }
    // Issue #39: cache-state lines are informational; miss/cold never upgrade warn.
    const infoRows: string[] = [];
    if (input.modelsDevCache?.state === "miss") {
      const at = input.modelsDevCache.observedAt ?? "?";
      infoRows.push(`models.dev: ${tf("docCapMiss", { at })}`);
    } else if (input.modelsDevCache?.state === "cold") {
      infoRows.push(t("docCapCold"));
    }
    if (input.refreshFailure) {
      const iso = new Date(input.refreshFailure.at).toISOString();
      infoRows.push(tf("docCapRefreshFail", { t: iso }));
    }
    const detail =
      `${input.capabilities.modelId}: ` +
      [
        fieldLine("context", cap.contextWindow),
        fieldLine("maxOutput", cap.maxTokens),
        fieldLine("reasoning", cap.reasoning),
        fieldLine("vision", cap.vision),
      ].join(" · ") +
      (failRows.length ? `; ${failRows.join("; ")}` : "") +
      (warnRows.length ? `; ${warnRows.join("; ")}` : "") +
      (infoRows.length ? `; ${infoRows.join("; ")}` : "");
    const status: DoctorStatus = failRows.length
      ? "fail"
      : warnRows.length
        ? "warn"
        : "pass";
    checks.push({
      id: "capabilities",
      title: t("docTitleCapabilities"),
      status,
      detail,
      fix: failRows.length
        ? tf("docFixCapabilitiesFail", { id: input.capabilities.modelId })
        : warnRows.length
          ? t("docFixCapabilitiesWarn")
          : undefined,
    });
  }

  // 11.5 Provider wire compat (issue #62 Chat + #65 Anthropic)
  if (input.providerWireCompat) {
    const wire = input.providerWireCompat;
    const conflictRows = wire.conflicts.map(
      (c) =>
        `${c.field}=${c.effective}(${c.effectiveSource}, scope=${wire.scope}) vs ${c.overridden}(${c.overriddenSource})`,
    );
    const fieldParts = Object.entries(wire.fields).map(
      ([name, entry]) => `${name}=${entry.value}(${entry.source})`,
    );
    const facts = `api=${wire.api} scope=${wire.scope} · ${fieldParts.join(" · ")}`;
    const detail = conflictRows.length
      ? `${facts}; ${conflictRows.join("; ")}`
      : facts;
    checks.push({
      id: "provider-wire-compat",
      title: t("docTitleWireCompat"),
      status: conflictRows.length ? "warn" : "pass",
      detail,
      fix: conflictRows.length
        ? t("docFixWireCompat")
        : undefined,
    });
  }

  // 12. SDK (W6): Pi runtime version within compat window
  const min = input.piMinVersion ?? PI_MIN_VERSION;
  if (input.piVersion) {
    const below = compareSemver(input.piVersion, min) < 0;
    checks.push({
      id: "sdk",
      title: t("docTitleSdk"),
      status: below ? "fail" : "pass",
      detail: below
        ? tf("docSdkBelow", { ver: input.piVersion, min })
        : tf("docSdkOk", { ver: input.piVersion, min }),
      fix: below ? t("docFixSdk") : undefined,
    });
  } else {
    checks.push({
      id: "sdk",
      title: t("docTitleSdk"),
      status: "pass",
      detail: tf("docSdkUndetected", { min }),
    });
  }

  const summary = countBy(checks);
  const lines: string[] = [
    `pi-switch doctor · ${doctorSummaryText(summary)}`,
    "",
    ...formatDoctorCheckLines(checks, {
      heading: (check) => `[${t(check.status)}] ${check.title}`,
      detail: (detail) => `  ${detail}`,
      fix: (fix) => `  ${t("fix")} ${fix}`,
    }),
  ];
  return { checks, summary, lines };
}

/** Width-agnostic horizontal rule using box-drawing light horizontal. */
function hr(width: number): string {
  return "─".repeat(Math.max(1, width));
}

/** Render report as a single notify-friendly, colorized string. */
export function formatDoctorReport(report: DoctorReport): string {
  const { checks, summary } = report;
  const width = 60; // stable width for top/bottom rules; body wraps naturally

  const out: string[] = [];
  out.push(paint("cyan", hr(width)));
  out.push(bold("pi-switch doctor"));
  out.push(dim(doctorSummaryText(summary)));

  const badge = (status: DoctorStatus, count: number) =>
    `${paint(STATUS_COLOR[status], GLYPH.active)} ${statusBadge(status, t(status))} ${count}`;
  out.push([badge("pass", summary.pass), badge("warn", summary.warn), badge("fail", summary.fail)].join("  "));

  out.push(dim(`${checks.length} ${t("checks")}`));
  out.push(paint("cyan", hr(width)));

  out.push(
    ...formatDoctorCheckLines(checks, {
      heading: (check) =>
        `${statusBadge(check.status, t(check.status))} ${bold(check.title)}`,
      detail: (detail) => `  ${detail}`,
      fix: (fix) => `  ${paint("yellow", t("fix"))} ${fix}`,
    }),
  );

  out.push(paint("cyan", hr(width)));
  return out.join("\n");
}

/**
 * Target-scoped Doctor precheck subset (ticket 3 / #45).
 *
 * Probe/Repair run this before network: FAIL blocks transport, WARN is shown
 * and allows continue. Full /ps-doctor remains independent.
 *
 * Pure: all IO facts are injected (providers snapshot, routing probe, etc.).
 */

import type { DoctorStatus } from "../doctor.ts";
import { isSwitchable } from "../parse/index.ts";
import type { CcProvider } from "../types.ts";
import type { ProbeTarget } from "./types.ts";

/** Dimensions covered by the target precheck (not the full doctor suite). */
export const PROBE_TARGET_PRECHECK_DIMENSIONS = [
  "db",
  "parse",
  "credentials",
  "routing",
  "capabilities",
  "fingerprint",
] as const;

export type ProbePrecheckDimension = (typeof PROBE_TARGET_PRECHECK_DIMENSIONS)[number];

export interface ProbePrecheckCheck {
  id: string;
  dimension: ProbePrecheckDimension;
  title: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

export type ProbePrecheckStatus = DoctorStatus;

/** Outcome of the target-scoped doctor precheck. */
export interface ProbePrecheckResult {
  status: ProbePrecheckStatus;
  /** False when any check is fail — probe must not make network requests. */
  allowProbe: boolean;
  checks: ProbePrecheckCheck[];
  summary: string;
}

/**
 * Soft / optional dimension input: caller supplies already-resolved status
 * (e.g. from doctor fingerprint/capabilities helpers) so precheck stays pure.
 */
export interface ProbePrecheckSoftCheck {
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

/**
 * Injected facts for target precheck. No filesystem or network IO here —
 * production adapter loads providers/DB/routing before calling.
 */
export interface TargetDoctorPrecheckInput {
  target: ProbeTarget;
  dbExists: boolean;
  dbPath?: string;
  providers: CcProvider[];
  providersError?: string;
  /** Optional CC Switch local routing reachability. */
  routingProbe?: { url: string; reachable: boolean };
  /** Optional fingerprint status for the target path. */
  fingerprint?: ProbePrecheckSoftCheck;
  /** Optional capability metadata status for the target model. */
  capabilities?: ProbePrecheckSoftCheck;
}

function findTargetProvider(
  providers: CcProvider[],
  providerKey: string,
): CcProvider | undefined {
  const key = providerKey.trim();
  if (!key) return undefined;
  return (
    providers.find((p) => p.piName === key) ??
    providers.find((p) => p.id === key) ??
    providers.find((p) => p.displayName === key)
  );
}

function aggregateStatus(checks: ProbePrecheckCheck[]): ProbePrecheckStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "pass";
}

function formatSummary(status: ProbePrecheckStatus, checks: ProbePrecheckCheck[]): string {
  const bad = checks.filter((c) => c.status !== "pass");
  if (status === "pass") {
    return `precheck pass (${checks.length} checks)`;
  }
  const parts = bad.map((c) => `${c.dimension}=${c.status}`);
  return `precheck ${status}: ${parts.join(", ") || status}`;
}

/**
 * Run the target-scoped doctor subset for a Probe Target.
 * Covers DB / parse / credentials always; routing / capabilities / fingerprint
 * only when the caller supplies the corresponding facts.
 */
export function runTargetDoctorPrecheck(
  input: TargetDoctorPrecheckInput,
): ProbePrecheckResult {
  const checks: ProbePrecheckCheck[] = [];
  const { target } = input;

  // --- DB ---
  if (!input.dbExists) {
    checks.push({
      id: "db",
      dimension: "db",
      title: "Database",
      status: "fail",
      detail: input.dbPath ? `not found: ${input.dbPath}` : "cc-switch database not found",
      fix: "create providers in CC Switch, or set CC_SWITCH_DB to the correct path",
    });
  } else if (input.providersError && !input.providers.length) {
    checks.push({
      id: "db",
      dimension: "db",
      title: "Database",
      status: "fail",
      detail: input.providersError,
      fix: "check sqlite3 and DB path; confirm providers table is readable",
    });
  } else {
    checks.push({
      id: "db",
      dimension: "db",
      title: "Database",
      status: "pass",
      detail: input.dbPath
        ? `${input.dbPath} · ${input.providers.length} providers`
        : `${input.providers.length} providers loaded`,
    });
  }

  const match = findTargetProvider(input.providers, target.provider);

  // --- Parse ---
  if (!match) {
    checks.push({
      id: "parse",
      dimension: "parse",
      title: "Target parse",
      status: "fail",
      detail: `provider "${target.provider}" not found in providers snapshot`,
      fix: "choose a configured Probe Target, or refresh providers from CC Switch",
    });
  } else if (match.parseError) {
    checks.push({
      id: "parse",
      dimension: "parse",
      title: "Target parse",
      status: "fail",
      detail: `${match.appType}/${match.displayName}: ${match.parseError}`,
      fix: "fix settings_config in CC Switch (baseUrl/apiKey/protocol)",
    });
  } else if (!match.configModels.includes(target.modelId)) {
    checks.push({
      id: "parse",
      dimension: "parse",
      title: "Target parse",
      status: "warn",
      detail:
        `model "${target.modelId}" not in ${match.displayName} configModels` +
        ` (${match.configModels.length} listed); may still work if the relay accepts it`,
      fix: "confirm the model id with the relay, or pick a listed model",
    });
  } else {
    checks.push({
      id: "parse",
      dimension: "parse",
      title: "Target parse",
      status: "pass",
      detail: `${match.appType}/${match.displayName} · ${target.modelId}`,
    });
  }

  // --- Credentials ---
  if (!match) {
    checks.push({
      id: "credentials",
      dimension: "credentials",
      title: "Credentials",
      status: "fail",
      detail: "cannot verify credentials: provider not resolved",
      fix: "resolve a valid Probe Target first",
    });
  } else if (!isSwitchable(match)) {
    const reason =
      match.parseError ||
      (!match.apiKey ? "missing apiKey" : !match.baseUrl ? "missing baseUrl" : !match.api ? "unsupported protocol" : "not switchable");
    checks.push({
      id: "credentials",
      dimension: "credentials",
      title: "Credentials",
      status: "fail",
      detail: `${match.appType}/${match.displayName}: ${reason}`,
      fix: "fill baseUrl/apiKey in CC Switch for this provider",
    });
  } else {
    checks.push({
      id: "credentials",
      dimension: "credentials",
      title: "Credentials",
      status: "pass",
      detail: `${match.appType}/${match.displayName}: switchable (apiKey/baseUrl present)`,
    });
  }

  // --- Routing (optional) ---
  if (input.routingProbe) {
    const r = input.routingProbe;
    checks.push({
      id: "routing",
      dimension: "routing",
      title: "Routing",
      status: r.reachable ? "pass" : "warn",
      detail: r.reachable ? `reachable ${r.url}` : `unreachable ${r.url} (Direct path may still work)`,
      fix: r.reachable
        ? undefined
        : "check CC Switch proxy/routing if this target uses local routing",
    });
  }

  // --- Capabilities (optional) ---
  if (input.capabilities) {
    checks.push({
      id: "capabilities",
      dimension: "capabilities",
      title: "Capabilities",
      status: input.capabilities.status,
      detail: input.capabilities.detail,
      fix: input.capabilities.fix,
    });
  }

  // --- Fingerprint (optional) ---
  if (input.fingerprint) {
    checks.push({
      id: "fingerprint",
      dimension: "fingerprint",
      title: "Fingerprint",
      status: input.fingerprint.status,
      detail: input.fingerprint.detail,
      fix: input.fingerprint.fix,
    });
  }

  const status = aggregateStatus(checks);
  return {
    status,
    allowProbe: status !== "fail",
    checks,
    summary: formatSummary(status, checks),
  };
}

/**
 * Post-success "switch to repaired target" action (ticket 8 / #51).
 *
 * Compatibility Repair commits config but never switches Session Model.
 * After a successful commit the outcome carries an explicit switchAction;
 * this module executes that action via the existing switch lifecycle
 * (register + setModel + selection persist) when the user opts in.
 *
 * Lifecycle `activate` is injected so unit tests never touch a real pi API.
 */

import { isSwitchable } from "../parse/index.ts";
import type { CcProvider } from "../types.ts";
import type { RepairOutcome, RepairSwitchAction } from "./repair.ts";
import { findProviderForProbeTarget } from "./target-pick.ts";
import type { ProbeTarget } from "./types.ts";

/**
 * Minimal SwitchTarget shape matching extensions/switch-lifecycle.
 * Kept local so src/probe does not import the extension layer.
 */
export type LifecycleSwitchTarget = {
  provider: CcProvider;
  modelId: string;
  commit: "selection" | "runtime-only";
};

export type LifecycleActivationResult =
  | { kind: "activated"; stages?: unknown }
  | {
      kind: "failed";
      failedStage: string;
      error: string;
      stages?: unknown;
    };

export interface ExecuteRepairSwitchDeps {
  providers: CcProvider[];
  /**
   * Existing switch lifecycle activate (register + setModel + persist).
   * This is the only path that may call setModel after a repair.
   */
  activate: (
    target: LifecycleSwitchTarget,
  ) => Promise<LifecycleActivationResult> | LifecycleActivationResult;
  /** Default commit mode for post-repair switch (selection = persist). */
  commit?: "selection" | "runtime-only";
}

export type ExecuteRepairSwitchOk = {
  ok: true;
  target: ProbeTarget;
  provider: CcProvider;
  modelId: string;
  activation: Extract<LifecycleActivationResult, { kind: "activated" }>;
  summary: string;
};

export type ExecuteRepairSwitchErr = {
  ok: false;
  reason:
    | "not-offered"
    | "not-found"
    | "not-switchable"
    | "parse-error"
    | "activate-failed";
  message: string;
  provider?: CcProvider;
  activation?: Extract<LifecycleActivationResult, { kind: "failed" }>;
};

export type ExecuteRepairSwitchResult =
  | ExecuteRepairSwitchOk
  | ExecuteRepairSwitchErr;

/** True when a repair outcome carries an executable post-success switch action. */
export function hasRepairSwitchAction(
  outcome: Pick<RepairOutcome, "status"> & {
    switchAction?: RepairSwitchAction;
  },
): outcome is Extract<RepairOutcome, { status: "committed" }> {
  return (
    outcome.status === "committed" &&
    outcome.switchAction?.kind === "switch-to-repaired-target"
  );
}

/**
 * Execute the explicit post-success switch via existing lifecycle.
 * Only path that may call setModel after a Compatibility Repair.
 */
export async function executeRepairSwitchAction(
  action: RepairSwitchAction,
  deps: ExecuteRepairSwitchDeps,
): Promise<ExecuteRepairSwitchResult> {
  if (action.kind !== "switch-to-repaired-target") {
    return {
      ok: false,
      reason: "not-offered",
      message: `unsupported switch action kind: ${(action as { kind: string }).kind}`,
    };
  }

  const { target } = action;
  const provider = findProviderForProbeTarget(
    deps.providers,
    target.provider,
  );

  if (!provider) {
    return {
      ok: false,
      reason: "not-found",
      message: `cannot switch: Probe Target provider not found: ${target.provider}`,
    };
  }

  if (!isSwitchable(provider)) {
    const detail = provider.parseError?.trim();
    if (detail) {
      return {
        ok: false,
        reason: "parse-error",
        message: `cannot switch to repaired target (parseError): ${detail}`,
        provider,
      };
    }
    return {
      ok: false,
      reason: "not-switchable",
      message: `cannot switch to repaired target: ${provider.appType}/${provider.displayName} is not switchable`,
      provider,
    };
  }

  const modelId = target.modelId.trim();
  if (!modelId) {
    return {
      ok: false,
      reason: "not-found",
      message: "cannot switch: repaired target model id is empty",
      provider,
    };
  }

  const commit = deps.commit ?? "selection";
  const activation = await deps.activate({
    provider,
    modelId,
    commit,
  });

  if (activation.kind === "failed") {
    return {
      ok: false,
      reason: "activate-failed",
      message: activation.error,
      provider,
      activation,
    };
  }

  return {
    ok: true,
    target,
    provider,
    modelId,
    activation,
    summary: `switched session model to ${provider.piName}/${modelId} via lifecycle`,
  };
}

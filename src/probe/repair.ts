/**
 * Compatibility Repair pipeline (ticket 4 / #46).
 *
 * Flow: plan from fresh normalized evidence → plan-level confirm once →
 * in-memory candidate verification (two consecutive passes) → CAS commit
 * of at most one Recipe. Never calls setModel; never writes without confirm.
 *
 * Interactive only — headless is rejected (no silent persistent change).
 */

import { advance, createRepairInvestigation } from "./investigation.ts";
import type { RepairPlan } from "./repair-plan.ts";
import {
  type RepairCandidate,
  type RepairRecipeMatch,
} from "./recipes.ts";
import {
  type ProbeEngineOptions,
  type ProbeRunResult,
  type ProbeTarget,
  type ProbeVerifier,
} from "./types.ts";

export { buildRepairPlan } from "./repair-plan.ts";
export type {
  RepairPlan,
  RepairPlanPreview,
  RepairPlanPreviewExactModelPatch,
  RepairPlanPreviewPatch,
  RepairPlanPreviewProviderPatch,
} from "./repair-plan.ts";

// ── Config store (CAS) ──────────────────────────────────────────────────────

/** Opaque config snapshot for CAS. Production maps this to pi-switch.json source. */
export interface RepairConfigSnapshot {
  /** Opaque version token; commit fails when it no longer matches. */
  version: string;
}

export interface RepairConfigCommitInput {
  expectedVersion: string;
  patch: RepairCandidate;
}

export type RepairConfigCommitResult =
  | { ok: true; version: string }
  | { ok: false; reason: "conflict" | "error"; message?: string };

/**
 * Injectable config store. Unit tests use an in-memory faux; production
 * wires to writeModelMetaOverride + CAS (expected source equality).
 */
export interface RepairConfigStore {
  read: () => RepairConfigSnapshot | Promise<RepairConfigSnapshot>;
  commit: (
    input: RepairConfigCommitInput,
  ) => RepairConfigCommitResult | Promise<RepairConfigCommitResult>;
}

// ── Outcome ─────────────────────────────────────────────────────────────────

export type RepairMode = "interactive" | "headless";

export type RepairSwitchAction = {
  kind: "switch-to-repaired-target";
  target: ProbeTarget;
};

export type RepairOutcome =
  | {
      status: "headless-rejected";
      summary: string;
      persisted: false;
    }
  | {
      status: "needs-confirmation";
      plan: RepairPlan;
      summary: string;
      persisted: false;
    }
  | {
      status: "no-recipe";
      plan: RepairPlan;
      summary: string;
      persisted: false;
    }
  | {
      status: "verification-failed";
      plan: RepairPlan;
      recipe: RepairRecipeMatch;
      attempts: ProbeRunResult[];
      summary: string;
      persisted: false;
    }
  | {
      status: "cas-conflict";
      plan: RepairPlan;
      recipe: RepairRecipeMatch;
      attempts: ProbeRunResult[];
      summary: string;
      persisted: false;
    }
  | {
      status: "commit-error";
      plan: RepairPlan;
      recipe: RepairRecipeMatch;
      attempts: ProbeRunResult[];
      summary: string;
      persisted: false;
    }
  | {
      status: "committed";
      plan: RepairPlan;
      recipe: RepairRecipeMatch;
      attempts: ProbeRunResult[];
      summary: string;
      persisted: true;
      /** Session Model is never switched by repair. */
      sessionModelUnchanged: true;
      /** Explicit post-success action for UI (ticket 8 wires the lifecycle). */
      switchAction?: RepairSwitchAction;
    };

export interface RunRepairOptions {
  mode: RepairMode;
  /**
   * Plan-level confirmation. When false, returns needs-confirmation with
   * zero transport calls and zero config writes.
   */
  confirmed: boolean;
  plan: RepairPlan;
  /** Reuses the model, transport, and precheck snapshot from the fresh probe. */
  verify: ProbeVerifier;
  configStore: RepairConfigStore;
  /** Which recipe to try (default 0). At most one recipe is committed. */
  recipeIndex?: number;
  /** Whether the command adapter should receive a post-commit switch offer. */
  offerSwitch?: boolean;
  maxRequests?: number;
  timeoutMs?: number;
  maxTokens?: number;
  createSignal?: ProbeEngineOptions["createSignal"];
  now?: () => number;
}

/**
 * Public Compatibility Repair facade. The state machine owns progression and
 * this function only interprets its effects through the existing adapters.
 */
export async function runRepair(opts: RunRepairOptions): Promise<RepairOutcome> {
  const { plan } = opts;
  if (opts.mode === "headless") {
    return {
      status: "headless-rejected",
      summary: "repair requires interactive confirmation; headless mode is not allowed",
      persisted: false,
    };
  }
  if (!opts.confirmed) {
    return {
      status: "needs-confirmation",
      plan,
      summary: formatPlanPreviewSummary(plan),
      persisted: false,
    };
  }

  let transition = createRepairInvestigation(
    plan,
    {
      maxRequests: opts.maxRequests,
      timeoutMs: opts.timeoutMs,
      maxTokens: opts.maxTokens,
    },
    opts.recipeIndex ?? 0,
    opts.offerSwitch ?? true,
  );

  let switchTarget: ProbeTarget | undefined;
  while (transition.effects.length > 0) {
    const effect = transition.effects[0]!;
    switch (effect.kind) {
      case "confirm-repair":
        transition = advance(transition.state, { kind: "confirm", accepted: true });
        break;
      case "read-config-snapshot": {
        try {
          const snapshot = await opts.configStore.read();
          transition = advance(transition.state, {
            kind: "config-snapshot",
            version: snapshot.version,
          });
        } catch (error) {
          transition = advance(transition.state, {
            kind: "config-snapshot-error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }
      case "verify-candidate": {
        const result = await opts.verify({
          target: effect.target,
          contracts: effect.contracts,
          maxRequests: effect.maxRequests,
          timeoutMs: effect.timeoutMs,
          maxTokens: effect.maxTokens,
          createSignal: opts.createSignal,
          now: opts.now,
        });
        transition = advance(transition.state, {
          kind: "verification-completed",
          sequence: effect.sequence,
          result,
        });
        break;
      }
      case "commit-repair": {
        let result: RepairConfigCommitResult;
        try {
          result = await opts.configStore.commit({
            expectedVersion: effect.expectedVersion,
            patch: effect.patch,
          });
        } catch (error) {
          result = {
            ok: false,
            reason: "error",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        transition = advance(transition.state, {
          kind: "commit-completed",
          result,
        });
        break;
      }
      case "offer-switch":
        // Switch lifecycle belongs to the command/UI adapter. Consume the
        // declarative offer and map it to the outcome action below; no choice
        // or Session Model mutation happens inside this facade.
        switchTarget = { ...effect.target };
        transition = {
          state: transition.state,
          effects: transition.effects.slice(1),
        };
        break;
      case "probe":
        throw new Error(`runRepair cannot interpret ${effect.kind} from a plan-scoped investigation`);
    }
  }

  const state = transition.state;
  if (state.status === "no-recipe") {
    return {
      status: "no-recipe",
      plan,
      summary: "no whitelist Repair Recipe matched probe evidence",
      persisted: false,
    };
  }
  const attempts = ("attempts" in state ? state.attempts : undefined) ?? [];
  if (state.status === "verification-failed") {
    if (!state.recipe) {
      throw new Error("repair investigation ended in impossible state: verification-failed without recipe");
    }
    return {
      status: state.status,
      plan,
      recipe: state.recipe,
      attempts,
      summary:
        `${state.message || `candidate verification failed after ${attempts.length} verification attempt(s)`}` +
        ` (${attempts.at(-1)?.stoppedReason ?? "stage failure"}); candidate discarded, no config write`,
      persisted: false,
    };
  }
  if (state.status === "cas-conflict" || state.status === "commit-error") {
    if (!state.recipe) {
      throw new Error(`repair investigation ended in impossible state: ${state.status} without recipe`);
    }
    return {
      status: state.status,
      plan,
      recipe: state.recipe,
      attempts,
      summary: state.message?.trim() || (state.status === "cas-conflict"
        ? "config changed externally during repair; aborting to preserve external changes"
        : "failed to persist repair candidate"),
      persisted: false,
    };
  }
  if (state.status !== "committed") {
    throw new Error(`repair investigation ended in impossible state: ${state.status}`);
  }
  if (!state.recipe || !state.candidateTarget) {
    throw new Error("repair investigation ended in impossible state: committed without recipe or candidate target");
  }
  return mapCommittedOutcome(plan, state.recipe, attempts, switchTarget);
}

type CommittedRepairOutcome = Extract<RepairOutcome, { status: "committed" }>;

function mapCommittedOutcome(
  plan: RepairPlan,
  recipe: RepairRecipeMatch,
  attempts: ProbeRunResult[],
  switchTarget?: ProbeTarget,
): CommittedRepairOutcome {
  return {
    status: "committed",
    plan,
    recipe,
    attempts,
    summary: `committed ${recipe.recipeId} for ${plan.target.provider}/${plan.target.modelId} (session model unchanged)`,
    persisted: true,
    sessionModelUnchanged: true,
    ...(switchTarget
      ? {
          switchAction: {
            kind: "switch-to-repaired-target" as const,
            target: { ...switchTarget },
          },
        }
      : {}),
  };
}

function formatPlanPreviewSummary(plan: RepairPlan): string {
  if (plan.recipes.length === 0) {
    return `repair plan for ${plan.preview.target}: no matching recipes`;
  }
  const parts = plan.preview.patches.map((patch) => {
    const affected =
      patch.scope === "exact-model"
        ? patch.affectedModels.join(",")
        : `all applicable models under provider ${patch.provider}`;
    return `${patch.recipeId}[${patch.scope}] → ${affected}`;
  });
  return `repair plan for ${plan.preview.target}: ${parts.join("; ")} (awaiting confirmation)`;
}

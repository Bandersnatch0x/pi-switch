/**
 * Compatibility Repair pipeline (ticket 4 / #46).
 *
 * Flow: plan from fresh normalized evidence → plan-level confirm once →
 * in-memory candidate verification (two consecutive passes) → CAS commit
 * of at most one Recipe. Never calls setModel; never writes without confirm.
 *
 * Interactive only — headless is rejected (no silent persistent change).
 */

import type { NormalizedProbeRunEvidence } from "./evidence.ts";
import {
  applyPatchToTarget,
  matchRepairRecipes,
  type RepairPatch,
  type RepairRecipeId,
  type RepairRecipeMatch,
} from "./recipes.ts";
import { runProbe } from "./engine.ts";
import type {
  ProbeEngineOptions,
  ProbeRunResult,
  ProbeTarget,
  ProbeTransport,
  ProbePrecheckInput,
} from "./types.ts";

// ── Plan ────────────────────────────────────────────────────────────────────

interface RepairPlanPreviewPatchBase {
  recipeId: RepairRecipeId;
  description: string;
}

export interface RepairPlanPreviewExactModelPatch
  extends RepairPlanPreviewPatchBase {
  scope: "exact-model";
  affectedModels: string[];
}

export interface RepairPlanPreviewProviderPatch
  extends RepairPlanPreviewPatchBase {
  scope: "provider-wide";
  provider: string;
}

export type RepairPlanPreviewPatch =
  | RepairPlanPreviewExactModelPatch
  | RepairPlanPreviewProviderPatch;

export interface RepairPlanPreview {
  target: string;
  recipeOrder: RepairRecipeId[];
  patches: RepairPlanPreviewPatch[];
}

/** Plan-level preview for one interactive confirmation. */
export interface RepairPlan {
  target: ProbeTarget;
  recipes: RepairRecipeMatch[];
  evidence: NormalizedProbeRunEvidence;
  preview: RepairPlanPreview;
}

/**
 * Build a repair plan from durable normalized evidence (pure, zero network).
 * Empty recipes when evidence is ambiguous / unmatched.
 */
export function buildRepairPlan(evidence: NormalizedProbeRunEvidence): RepairPlan {
  const recipes = matchRepairRecipes(evidence);
  const target: ProbeTarget = { ...evidence.target };

  return {
    target,
    recipes,
    evidence,
    preview: {
      target: `${target.provider}/${target.modelId}`,
      recipeOrder: recipes.map((r) => r.recipeId),
      patches: recipes.map(buildRepairPlanPreviewPatch),
    },
  };
}

// ── Config store (CAS) ──────────────────────────────────────────────────────

/** Opaque config snapshot for CAS. Production maps this to pi-switch.json source. */
export interface RepairConfigSnapshot {
  /** Opaque version token; commit fails when it no longer matches. */
  version: string;
}

export interface RepairConfigCommitInput {
  expectedVersion: string;
  patch: RepairPatch;
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
      switchAction: RepairSwitchAction;
    };

export interface RunRepairOptions {
  mode: RepairMode;
  /**
   * Plan-level confirmation. When false, returns needs-confirmation with
   * zero transport calls and zero config writes.
   */
  confirmed: boolean;
  plan: RepairPlan;
  /** Opaque model handle passed through to verification transport. */
  model: unknown;
  transport: ProbeTransport;
  configStore: RepairConfigStore;
  /** Which recipe to try (default 0). At most one recipe is committed. */
  recipeIndex?: number;
  precheck?: ProbePrecheckInput;
  maxRequests?: number;
  timeoutMs?: number;
  maxTokens?: number;
  createSignal?: ProbeEngineOptions["createSignal"];
  now?: () => number;
}

const CONSECUTIVE_PASSES_REQUIRED = 2;

/**
 * Execute Compatibility Repair for a confirmed plan.
 *
 * Guarantees:
 * - headless → rejected (no network, no persist)
 * - unconfirmed → needs-confirmation (no network, no persist)
 * - candidate applied only in memory until two consecutive verify passes
 * - CAS commit of exactly one recipe; conflict aborts without overwrite
 * - never calls setModel; exposes switchAction only after successful commit
 */
export async function runRepair(opts: RunRepairOptions): Promise<RepairOutcome> {
  const { plan } = opts;

  if (opts.mode === "headless") {
    return {
      status: "headless-rejected",
      summary:
        "repair requires interactive confirmation; headless mode is not allowed",
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

  if (plan.recipes.length === 0) {
    return {
      status: "no-recipe",
      plan,
      summary: "no whitelist Repair Recipe matched probe evidence",
      persisted: false,
    };
  }

  const index = opts.recipeIndex ?? 0;
  const recipe = plan.recipes[index] ?? plan.recipes[0]!;
  // Isolation: only this one recipe is attempted / committed this run.

  // Snapshot config version before verification so CAS detects external edits
  // that land during the (network) verify window.
  const snapshot = await opts.configStore.read();
  const expectedVersion = snapshot.version;

  const candidateTarget = applyPatchToTarget(plan.target, recipe.patch);
  const attempts: ProbeRunResult[] = [];

  for (let i = 0; i < CONSECUTIVE_PASSES_REQUIRED; i++) {
    const result = await runProbe({
      target: candidateTarget,
      model: opts.model,
      transport: opts.transport,
      contracts: recipe.verifyContracts,
      precheck: opts.precheck,
      maxRequests: opts.maxRequests,
      timeoutMs: opts.timeoutMs,
      maxTokens: opts.maxTokens,
      createSignal: opts.createSignal,
      now: opts.now,
    });
    attempts.push(result);

    if (!result.ok) {
      return {
        status: "verification-failed",
        plan,
        recipe,
        attempts,
        summary:
          `candidate verification failed on pass ${i + 1}/${CONSECUTIVE_PASSES_REQUIRED}` +
          ` (${result.stoppedReason ?? "stage failure"}); candidate discarded, no config write`,
        persisted: false,
      };
    }
  }

  // Two consecutive passes — CAS commit exactly one recipe.
  const commitResult = await opts.configStore.commit({
    expectedVersion,
    patch: recipe.patch,
  });

  if (!commitResult.ok) {
    if (commitResult.reason === "conflict") {
      return {
        status: "cas-conflict",
        plan,
        recipe,
        attempts,
        summary:
          commitResult.message?.trim() ||
          "config changed externally during repair; aborting to preserve external changes",
        persisted: false,
      };
    }
    return {
      status: "commit-error",
      plan,
      recipe,
      attempts,
      summary:
        commitResult.message?.trim() ||
        "failed to persist repair candidate",
      persisted: false,
    };
  }

  const repairedTarget: ProbeTarget = applyPatchToTarget(plan.target, recipe.patch);

  return {
    status: "committed",
    plan,
    recipe,
    attempts,
    summary:
      `committed ${recipe.recipeId} for ${plan.target.provider}/${plan.target.modelId}` +
      ` (session model unchanged)`,
    persisted: true,
    sessionModelUnchanged: true,
    switchAction: {
      kind: "switch-to-repaired-target",
      target: repairedTarget,
    },
  };
}

function buildRepairPlanPreviewPatch(
  recipe: RepairRecipeMatch,
): RepairPlanPreviewPatch {
  const base = {
    recipeId: recipe.recipeId,
    description: recipe.summary,
  };
  if (recipe.patch.scope === "model") {
    return {
      ...base,
      scope: "exact-model",
      affectedModels: [recipe.patch.modelId],
    };
  }
  return {
    ...base,
    scope: "provider-wide",
    provider: recipe.patch.provider,
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

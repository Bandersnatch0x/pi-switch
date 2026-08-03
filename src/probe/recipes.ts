/**
 * Repair Recipe matching (ticket 4 / #46).
 *
 * Whitelist only: exact evidence signatures → minimal Pi-side candidate.
 * Ambiguous evidence ("unknown") never matches. No LLM-generated recipes.
 *
 * Recipe 1: reasoning/thinking param rejected → exact-model reasoning=false.
 * (Recipes 2–3 land in later tickets.)
 */

import type { NormalizedProbeRunEvidence, NormalizedStageEvidence } from "./evidence.ts";
import type { ProbeContractId, ProbeTarget } from "./types.ts";

/** First-party recipe ids. Later tickets add fingerprint / gemini-tool. */
export type RepairRecipeId = "reasoning-false";

/**
 * Minimal Pi-side config candidate produced by a recipe.
 * Model-field patches always use exact model scope (never provider / global).
 */
export interface RepairPatchModelMeta {
  kind: "modelMeta";
  /** Exact model only — never provider-level or global. */
  scope: "model";
  provider: string;
  modelId: string;
  modelMeta: { reasoning: false };
}

export type RepairPatch = RepairPatchModelMeta;

/** One whitelist match from normalized evidence. */
export interface RepairRecipeMatch {
  recipeId: RepairRecipeId;
  signatureId: string;
  /** Contract stage that produced the matching evidence. */
  sourceContract: ProbeContractId;
  /**
   * Contracts to retest with the candidate applied in memory.
   * Recipe1 disables reasoning on the target, so reasoning is not re-probed;
   * basic (+ tool when claimed) prove the endpoint works without the param.
   */
  verifyContracts: ProbeContractId[];
  patch: RepairPatch;
  /** Models affected by the patch (plan preview). */
  affectedModels: string[];
  summary: string;
}

const RECIPE1_SIGNATURE = "reasoning_param_rejected";

/**
 * Contracts to verify after applying Recipe1 (reasoning=false).
 * Reasoning is skipped on the candidate target; prove basic (+ tool if present
 * in evidence plan) still work.
 */
function recipe1VerifyContracts(evidence: NormalizedProbeRunEvidence): ProbeContractId[] {
  const hasToolStage = evidence.stages.some((s) => s.contract === "tool");
  return hasToolStage ? ["basic", "tool"] : ["basic"];
}

function matchRecipe1(
  stage: NormalizedStageEvidence,
  target: ProbeTarget,
  evidence: NormalizedProbeRunEvidence,
): RepairRecipeMatch | undefined {
  if (stage.status !== "fail") return undefined;
  if (stage.signatureId !== RECIPE1_SIGNATURE) return undefined;
  if (stage.unrepairable) return undefined;

  const modelId = target.modelId;
  return {
    recipeId: "reasoning-false",
    signatureId: RECIPE1_SIGNATURE,
    sourceContract: stage.contract,
    verifyContracts: recipe1VerifyContracts(evidence),
    patch: {
      kind: "modelMeta",
      scope: "model",
      provider: target.provider,
      modelId,
      modelMeta: { reasoning: false },
    },
    affectedModels: [modelId],
    summary:
      `Set modelOverrides["${modelId}"].reasoning=false ` +
      `(exact model; upstream rejected reasoning/thinking parameter)`,
  };
}

/**
 * Match whitelist Repair Recipes against durable normalized evidence.
 * Returns zero or more matches in stage order; callers try at most one per run.
 * Unknown / ambiguous signatures produce no match.
 */
export function matchRepairRecipes(
  evidence: NormalizedProbeRunEvidence,
): RepairRecipeMatch[] {
  const matches: RepairRecipeMatch[] = [];
  const seen = new Set<RepairRecipeId>();

  for (const stage of evidence.stages) {
    const r1 = matchRecipe1(stage, evidence.target, evidence);
    if (r1 && !seen.has(r1.recipeId)) {
      matches.push(r1);
      seen.add(r1.recipeId);
    }
    // Future recipes register here (ticket 5 / 6) — still unique per id.
  }

  return matches;
}

/**
 * Apply a recipe patch to an in-memory Probe Target (never persists).
 * Used only for candidate verification before CAS commit.
 */
export function applyPatchToTarget(
  target: ProbeTarget,
  patch: RepairPatch,
): ProbeTarget {
  if (patch.kind === "modelMeta" && patch.modelMeta.reasoning === false) {
    return {
      provider: target.provider,
      modelId: target.modelId,
      reasoning: false,
    };
  }
  return { ...target };
}

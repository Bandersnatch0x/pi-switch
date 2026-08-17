/**
 * Pure Compatibility Repair plan construction.
 *
 * Plans depend only on normalized evidence, static recipes, and probe types.
 */

import type { NormalizedProbeRunEvidence } from "./evidence.ts";
import {
  matchRepairRecipes,
  type RepairRecipeId,
  type RepairRecipeMatch,
} from "./recipes.ts";
import type { ProbeTarget } from "./types.ts";

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
      recipeOrder: recipes.map((recipe) => recipe.recipeId),
      patches: recipes.map(buildRepairPlanPreviewPatch),
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

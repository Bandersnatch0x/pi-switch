/**
 * Repair Recipe matching (ticket 4 / #46, Recipe2 ticket 5 / #48,
 * Recipe3 ticket 6 / #49, registry gate ticket 9 / #47).
 *
 * Whitelist only: exact evidence signatures → minimal Pi-side candidate.
 * Ambiguous evidence ("unknown") never matches. No LLM-generated recipes.
 * Only recipes admitted by the evidence gate (recipe-registry) may match.
 *
 * Recipe 1: reasoning/thinking param rejected → exact-model reasoning=false.
 * Recipe 2: unique client-gate signature → provider-level fingerprint/compat.
 * Recipe 3: tool empty-args / schema evidence → provider-level geminiToolCompat.
 */

import type { NormalizedProbeRunEvidence, NormalizedStageEvidence } from "./evidence.ts";
import {
  type ClientGateFingerprint,
  clientGateSignatureId,
} from "./evidence.ts";
import { isRecipeAdmitted } from "./recipe-registry.ts";
import type { ProbeContractId, ProbeTarget } from "./types.ts";

/** First-party recipe ids. */
export type RepairRecipeId =
  | "reasoning-false"
  | "client-fingerprint"
  | "gemini-tool-compat";

/**
 * Minimal Pi-side config candidate produced by a recipe.
 * Model-field patches always use exact model scope (never provider / global).
 * Fingerprint / compat flags use provider scope (never global).
 */
export interface RepairPatchModelMeta {
  kind: "modelMeta";
  /** Exact model only — never provider-level or global. */
  scope: "model";
  provider: string;
  modelId: string;
  modelMeta: { reasoning: false };
}

/** Provider-level fingerprint (+ optional Claude Code compat) candidate. */
export interface RepairPatchProviderFingerprint {
  kind: "fingerprint";
  /** Provider only — never global config. */
  scope: "provider";
  provider: string;
  fingerprint: ClientGateFingerprint;
  /**
   * When true, also force providerOverrides[provider].claudeCodeCompat=true
   * (Claude Code request-shape gate; not set for codex/gemini).
   */
  claudeCodeCompat?: true;
}

/**
 * Provider-level geminiToolCompat force-on candidate (Recipe3).
 * Never writes global geminiToolCompat config.
 */
export interface RepairPatchProviderGeminiToolCompat {
  kind: "geminiToolCompat";
  /** Provider only — never global config. */
  scope: "provider";
  provider: string;
  geminiToolCompat: true;
}

export type RepairPatch =
  | RepairPatchModelMeta
  | RepairPatchProviderFingerprint
  | RepairPatchProviderGeminiToolCompat;

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

const RECIPE2_SIGNATURE_TO_FINGERPRINT: Record<string, ClientGateFingerprint> = {
  [clientGateSignatureId("claude-code")]: "claude-code",
  [clientGateSignatureId("codex")]: "codex",
  [clientGateSignatureId("gemini")]: "gemini",
};

const RECIPE3_SIGNATURE = "gemini_tool_empty_args";

/**
 * Contracts to verify after applying Recipe1 (reasoning=false).
 * Reasoning is skipped on the candidate target; prove basic (+ tool if present
 * in evidence plan) still work.
 */
function recipe1VerifyContracts(evidence: NormalizedProbeRunEvidence): ProbeContractId[] {
  const hasToolStage = evidence.stages.some((s) => s.contract === "tool");
  return hasToolStage ? ["basic", "tool"] : ["basic"];
}

/**
 * Contracts to verify after applying Recipe2 (fingerprint).
 * Re-run every non-skipped contract from the original plan (fingerprint is
 * header-level; all contracts that were intended must pass under the candidate).
 */
function recipe2VerifyContracts(evidence: NormalizedProbeRunEvidence): ProbeContractId[] {
  const out: ProbeContractId[] = [];
  for (const s of evidence.stages) {
    if (s.status === "skip") continue;
    if (!out.includes(s.contract)) out.push(s.contract);
  }
  // Always include basic as the minimum gate check.
  if (!out.includes("basic")) out.unshift("basic");
  return out;
}

/**
 * Contracts to verify after applying Recipe3 (geminiToolCompat).
 * Tool is the primary contract; always re-check basic as a smoke gate.
 */
function recipe3VerifyContracts(evidence: NormalizedProbeRunEvidence): ProbeContractId[] {
  const out: ProbeContractId[] = ["basic", "tool"];
  for (const s of evidence.stages) {
    if (s.status === "skip") continue;
    if (s.contract === "reasoning" && !out.includes("reasoning")) {
      // Only re-run reasoning when the original plan executed it.
      if (s.status === "pass" || s.status === "fail") out.push("reasoning");
    }
  }
  return out;
}

function matchRecipe1(
  stage: NormalizedStageEvidence,
  target: ProbeTarget,
  evidence: NormalizedProbeRunEvidence,
): RepairRecipeMatch | undefined {
  // Gate: only admitted registry entries may produce a match.
  if (!isRecipeAdmitted("reasoning-false")) return undefined;
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

function matchRecipe2(
  stage: NormalizedStageEvidence,
  target: ProbeTarget,
  evidence: NormalizedProbeRunEvidence,
): RepairRecipeMatch | undefined {
  if (!isRecipeAdmitted("client-fingerprint")) return undefined;
  if (stage.status !== "fail") return undefined;
  if (stage.unrepairable) return undefined;

  const fingerprint = RECIPE2_SIGNATURE_TO_FINGERPRINT[stage.signatureId];
  // Non-unique / unknown / non-mapped signatures never produce a candidate.
  if (!fingerprint) return undefined;

  const patch: RepairPatchProviderFingerprint = {
    kind: "fingerprint",
    scope: "provider",
    provider: target.provider,
    fingerprint,
  };
  // Claude Code gates often need request-shape compat in addition to UA preset.
  if (fingerprint === "claude-code") {
    patch.claudeCodeCompat = true;
  }

  return {
    recipeId: "client-fingerprint",
    signatureId: stage.signatureId,
    sourceContract: stage.contract,
    verifyContracts: recipe2VerifyContracts(evidence),
    patch,
    // Provider-level fingerprint applies to all models on this provider.
    affectedModels: [target.modelId],
    summary:
      fingerprint === "claude-code"
        ? `Set providerOverrides["${target.provider}"].fingerprint="claude-code" ` +
          `and claudeCodeCompat=true (unique client-gate signature)`
        : `Set providerOverrides["${target.provider}"].fingerprint="${fingerprint}" ` +
          `(unique client-gate signature; provider scope only)`,
  };
}

/**
 * Recipe 3: empty-args / schema evidence → provider geminiToolCompat=true.
 * When the switch is already enabled on the target, return undefined (report only;
 * no further parameter guessing).
 */
function matchRecipe3(
  stage: NormalizedStageEvidence,
  target: ProbeTarget,
  evidence: NormalizedProbeRunEvidence,
): RepairRecipeMatch | undefined {
  if (!isRecipeAdmitted("gemini-tool-compat")) return undefined;
  if (stage.status !== "fail") return undefined;
  if (stage.unrepairable) return undefined;
  if (stage.signatureId !== RECIPE3_SIGNATURE) return undefined;

  // Already force-on for this provider: do not propose another write.
  if (target.geminiToolCompat === true) return undefined;

  return {
    recipeId: "gemini-tool-compat",
    signatureId: RECIPE3_SIGNATURE,
    sourceContract: stage.contract,
    verifyContracts: recipe3VerifyContracts(evidence),
    patch: {
      kind: "geminiToolCompat",
      scope: "provider",
      provider: target.provider,
      geminiToolCompat: true,
    },
    affectedModels: [target.modelId],
    summary:
      `Set providerOverrides["${target.provider}"].geminiToolCompat=true ` +
      `(provider scope only; empty-args/schema tool evidence)`,
  };
}

/**
 * Match whitelist Repair Recipes against durable normalized evidence.
 * Returns zero or more matches in stage order; callers try at most one per run.
 * Unknown / ambiguous signatures produce no match.
 * Recipes must be admitted by the evidence gate (ticket 9).
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
    const r2 = matchRecipe2(stage, evidence.target, evidence);
    if (r2 && !seen.has(r2.recipeId)) {
      matches.push(r2);
      seen.add(r2.recipeId);
    }
    const r3 = matchRecipe3(stage, evidence.target, evidence);
    if (r3 && !seen.has(r3.recipeId)) {
      matches.push(r3);
      seen.add(r3.recipeId);
    }
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
  if (patch.kind === "fingerprint") {
    return {
      ...target,
      fingerprint: patch.fingerprint,
      ...(patch.claudeCodeCompat ? { claudeCodeCompat: true } : {}),
    };
  }
  if (patch.kind === "geminiToolCompat") {
    return {
      ...target,
      geminiToolCompat: true,
    };
  }
  return { ...target };
}
